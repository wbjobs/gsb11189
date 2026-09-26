/*
 * migration-worker.js — 在 Web Worker 中执行 IndexedDB 迁移
 * 职责：结构升级、断点续跑、失败回滚、隐私模式降级、浏览器差异兼容、进度上报。
 */
importScripts('migrations.js');

var M = MigDemo;

/* 浏览器差异兼容：indexedDB 厂商前缀 */
var IDB = self.indexedDB || self.mozIndexedDB || self.webkitIndexedDB || self.msIndexedDB;

function post(msg) { self.postMessage(msg); }
function log(msg) { post({ type: 'log', msg: msg }); }

/* ================= IndexedDB 适配器 ================= */
function IdbAdapter(db) { this.db = db; }

function txDone(tx) {
  return new Promise(function (resolve, reject) {
    // 兼容处理：以事务 oncomplete 为准，而不是最后一条请求的 onsuccess
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
    tx.onabort = function () { reject(tx.error || new Error('transaction aborted')); };
  });
}

IdbAdapter.prototype.getAll = function (store) {
  var db = this.db;
  return new Promise(function (resolve, reject) {
    var os = db.transaction(store, 'readonly').objectStore(store);
    if (os.getAll) { // 现代浏览器
      var req = os.getAll();
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    } else { // 旧浏览器回退：游标逐条读取
      var out = [];
      var cursor = os.openCursor();
      cursor.onsuccess = function (e) {
        var cur = e.target.result;
        if (cur) { out.push(cur.value); cur.continue(); } else { resolve(out); }
      };
      cursor.onerror = function () { reject(cursor.error); };
    }
  });
};

IdbAdapter.prototype.get = function (store, key) {
  var db = this.db;
  return new Promise(function (resolve, reject) {
    var req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
};

IdbAdapter.prototype.put = function (store, value) {
  var tx = this.db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return txDone(tx);
};

IdbAdapter.prototype.delete = function (store, key) {
  var tx = this.db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return txDone(tx);
};

IdbAdapter.prototype.clear = function (store) {
  var tx = this.db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return txDone(tx);
};

IdbAdapter.prototype.count = function (store) {
  var db = this.db;
  return new Promise(function (resolve, reject) {
    var req = db.transaction(store, 'readonly').objectStore(store).count();
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
};

IdbAdapter.prototype.bulkPut = function (store, items) {
  var db = this.db;
  var chain = Promise.resolve();
  for (var i = 0; i < items.length; i += M.CHUNK_SIZE) {
    (function (slice) {
      chain = chain.then(function () {
        var tx = db.transaction(store, 'readwrite');
        var os = tx.objectStore(store);
        slice.forEach(function (item) { os.put(item); });
        return txDone(tx);
      });
    })(items.slice(i, i + M.CHUNK_SIZE));
  }
  return chain;
};

/* ================= 内存适配器（隐私模式降级） ================= */
function MemoryAdapter() { this.data = {}; }

MemoryAdapter.prototype.ensure = function (store) {
  if (!this.data[store]) this.data[store] = new Map();
};

MemoryAdapter.prototype.getAll = function (store) {
  this.ensure(store);
  return Promise.resolve(Array.from(this.data[store].values()));
};

MemoryAdapter.prototype.get = function (store, key) {
  this.ensure(store);
  return Promise.resolve(this.data[store].get(key));
};

MemoryAdapter.prototype.put = function (store, value) {
  this.ensure(store);
  var key = value.key !== undefined ? value.key : value.id;
  this.data[store].set(key, value);
  return Promise.resolve();
};

MemoryAdapter.prototype.delete = function (store, key) {
  this.ensure(store);
  this.data[store].delete(key);
  return Promise.resolve();
};

MemoryAdapter.prototype.clear = function (store) {
  this.ensure(store);
  this.data[store].clear();
  return Promise.resolve();
};

MemoryAdapter.prototype.count = function (store) {
  this.ensure(store);
  return Promise.resolve(this.data[store].size);
};

MemoryAdapter.prototype.bulkPut = function (store, items) {
  var self = this;
  this.ensure(store);
  var chain = Promise.resolve();
  var _loop = function (i) {
    chain = chain.then(function () {
      items.slice(i, i + M.CHUNK_SIZE).forEach(function (item) {
        var key = item.id !== undefined ? item.id : item.key;
        self.data[store].set(key, item);
      });
      return new Promise(function (r) { setTimeout(r, 0); }); // 让出事件循环，模拟分批提交
    });
  };
  for (var i = 0; i < items.length; i += M.CHUNK_SIZE) _loop(i);
  return chain;
};

/* ================= 隐私模式探测 =================
 * 部分浏览器隐私模式下 open 直接报错，或一直挂起无响应。 */
function probeIdb(timeoutMs) {
  return new Promise(function (resolve) {
    if (!IDB) return resolve(false);
    var settled = false;
    function done(ok) { if (!settled) { settled = true; resolve(ok); } }
    var timer = setTimeout(function () { done(false); }, timeoutMs);
    try {
      var req = IDB.open('__probe__', 1);
      req.onsuccess = function () {
        clearTimeout(timer);
        req.result.close();
        try { IDB.deleteDatabase('__probe__'); } catch (e) { /* 忽略 */ }
        done(true);
      };
      req.onerror = function () { clearTimeout(timer); done(false); };
      req.onblocked = function () { clearTimeout(timer); done(false); };
    } catch (e) {
      clearTimeout(timer);
      done(false);
    }
  });
}

/* ================= 打开数据库（结构升级） ================= */
function openLatest() {
  return new Promise(function (resolve, reject) {
    var req = IDB.open(M.DB_NAME, M.DB_VERSION);
    req.onupgradeneeded = function (e) {
      log('结构升级：v' + e.oldVersion + ' → v' + e.newVersion + '（事务原子提交，中断自动回滚）');
      M.applySchema(req.result, req.transaction, e.oldVersion, e.newVersion);
    };
    req.onblocked = function () {
      post({ type: 'blocked' });
      log('数据库被占用：其他标签页/连接未关闭，等待释放中…');
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () {
      var err = req.error;
      if (err && err.name === 'VersionError') {
        post({ type: 'version-error',
               msg: '检测到版本回退：本地数据库版本高于当前应用支持的 v' + M.DB_VERSION + '，请升级应用' });
      }
      reject(err || new Error('open failed'));
    };
  });
}

/* ================= 检查点 / 备份 ================= */
function getState(adapter) { return adapter.get(M.META_STORE, 'state'); }

function setState(adapter, patch) {
  return adapter.put(M.META_STORE, {
    key: 'state',
    status: patch.status,
    lastDoneStep: patch.lastDoneStep || null,
    updatedAt: Date.now()
  });
}

async function backupStores(adapter, step) {
  var data = {};
  for (var i = 0; i < step.stores.length; i++) {
    data[step.stores[i]] = await adapter.getAll(step.stores[i]);
  }
  await adapter.put(M.BACKUP_STORE, { key: step.id, data: data });
}

async function restoreStores(adapter, step) {
  var rec = await adapter.get(M.BACKUP_STORE, step.id);
  if (!rec) return;
  for (var i = 0; i < step.stores.length; i++) {
    var name = step.stores[i];
    await adapter.clear(name);
    await adapter.bulkPut(name, rec.data[name] || []);
  }
}

/* ================= 迁移主流程 ================= */
async function run(cfg) {
  /* 1. 模式判定：隐私模式 / 无 IndexedDB → 内存降级 */
  var useMemory = !!cfg.forceMemory || !IDB;
  if (!useMemory) useMemory = !(await probeIdb(2000));

  var adapter;
  var db = null;

  if (useMemory) {
    post({ type: 'mode', mode: 'memory' });
    log('隐私模式/无 IndexedDB：已降级为内存存储，数据不会持久化（功能不受影响）');
    adapter = new MemoryAdapter();
    ['users', 'orders', 'products', 'logs', M.META_STORE, M.BACKUP_STORE].forEach(function (s) {
      adapter.ensure(s);
    });
    if ((await adapter.count('users')) === 0) {
      var seed = M.generateLegacyData(50, 80);
      await adapter.bulkPut('users', seed.users);
      await adapter.bulkPut('orders', seed.orders);
      log('内存模式：已生成演示旧数据 users=50 orders=80');
    }
  } else {
    post({ type: 'mode', mode: 'idb' });
    db = await openLatest();
    // 浏览器差异兼容：收到 versionchange 主动关闭，避免阻塞他人升级
    db.onversionchange = function () { db.close(); };
    adapter = new IdbAdapter(db);
  }

  /* 2. 读取检查点，计算待执行的数据步骤（断点续跑） */
  var state = await getState(adapter);
  var dataSteps = M.STEPS.filter(function (s) { return s.type === 'data'; });
  var startIdx = 0;

  if (state && state.status === 'done') {
    log('迁移已完成过（v' + M.DB_VERSION + '），无需重复执行');
    post({ type: 'done', summary: await verify(adapter) });
    if (db) db.close();
    return;
  }
  if (state && state.status === 'in-progress' && state.lastDoneStep) {
    var lastIdx = -1;
    dataSteps.forEach(function (s, i) { if (s.id === state.lastDoneStep) lastIdx = i; });
    startIdx = lastIdx + 1;
    log('检测到未完成的迁移（断点：' + state.lastDoneStep + '），从下一步继续执行');
  }
  if (state && state.status === 'rolled-back') {
    var rbIdx = -1;
    dataSteps.forEach(function (s, i) { if (s.id === state.lastDoneStep) rbIdx = i; });
    startIdx = rbIdx + 1;
    log('检测到上次迁移失败已回滚，从断点后继续执行');
  }

  var pending = dataSteps.slice(startIdx);
  if (!pending.length) {
    await setState(adapter, { status: 'done', lastDoneStep: dataSteps[dataSteps.length - 1].id });
    post({ type: 'done', summary: await verify(adapter) });
    if (db) db.close();
    return;
  }

  /* 3. 估算总工作量，上报进度计划 */
  var plan = [];
  var total = 0;
  for (var p = 0; p < pending.length; p++) {
    var units = await pending[p].estimate(adapter);
    plan.push({ id: pending[p].id, label: pending[p].label, units: units });
    total += units;
  }
  post({ type: 'plan', steps: plan, totalUnits: total });

  /* 4. 逐步执行：备份 → 迁移 → 记录检查点；失败则回滚 */
  var doneUnits = 0;
  for (var s = 0; s < pending.length; s++) {
    var step = pending[s];
    post({ type: 'step-start', stepId: step.id });
    log('开始步骤 ' + step.id + '：' + step.label);

    await backupStores(adapter, step);

    var report = (function (stepId) {
      return function (n) {
        doneUnits += n;
        post({ type: 'progress', stepId: stepId, doneUnits: doneUnits, totalUnits: total });
      };
    })(step.id);

    try {
      await step.run({ adapter: adapter, report: report, injectFailure: !!cfg.injectFailure });
    } catch (err) {
      log('步骤 ' + step.id + ' 失败：' + (err && err.message) + '，正在回滚该步骤…');
      await restoreStores(adapter, step);
      await adapter.delete(M.BACKUP_STORE, step.id);
      var prevId = (startIdx + s) > 0 ? dataSteps[startIdx + s - 1].id : null;
      await setState(adapter, { status: 'rolled-back', lastDoneStep: prevId });
      post({ type: 'rolled-back', stepId: step.id, error: String((err && err.message) || err) });
      if (db) db.close();
      return;
    }

    await setState(adapter, { status: 'in-progress', lastDoneStep: step.id });
    await adapter.delete(M.BACKUP_STORE, step.id);
    post({ type: 'step-done', stepId: step.id });
    log('步骤 ' + step.id + ' 完成（检查点已保存）');
  }

  /* 5. 收尾：标记完成、校验数据完整性 */
  await setState(adapter, { status: 'done', lastDoneStep: dataSteps[dataSteps.length - 1].id });
  var summary = await verify(adapter);
  post({ type: 'done', summary: summary });
  if (db) db.close();
}

/* 数据完整性校验：条数 + 关键字段 */
async function verify(adapter) {
  var users = await adapter.getAll('users');
  var orders = await adapter.getAll('orders');
  var badUsers = users.filter(function (u) {
    return !u.firstName || !u.email || u.score === undefined || u.createdAt === undefined;
  }).length;
  var badOrders = orders.filter(function (o) { return !o.status; }).length;
  return {
    users: users.length,
    orders: orders.length,
    products: await adapter.count('products'),
    logs: await adapter.count('logs'),
    badUsers: badUsers,
    badOrders: badOrders,
    ok: badUsers === 0 && badOrders === 0
  };
}

self.onmessage = function (e) {
  var cfg = e.data || {};
  if (cfg.cmd !== 'migrate') return;
  run(cfg).catch(function (err) {
    post({ type: 'error', error: String((err && err.message) || err) });
  });
};
