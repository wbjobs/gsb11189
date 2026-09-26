/*
 * main.js — 主线程：DOM 交互、Canvas 迁移进度可视化、演示场景触发
 */
(function () {
  'use strict';

  /* 浏览器差异兼容：indexedDB 厂商前缀 */
  var IDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;

  var $ = function (id) { return document.getElementById(id); };
  var logEl = $('log');
  var statusEl = $('status');
  var modeBadge = $('modeBadge');
  var canvas = $('progressCanvas');

  var worker = null;
  var heldDb = null; // 模拟"数据库被占用"的连接

  /* ---------------- 日志 / 状态 ---------------- */
  function log(msg) {
    var time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logEl.textContent += '[' + time + '] ' + msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(msg) { statusEl.textContent = msg; }

  function setMode(mode) {
    if (mode === 'memory') {
      modeBadge.textContent = '内存模式（隐私模式降级，不持久化）';
      modeBadge.className = 'badge warn';
    } else {
      modeBadge.textContent = 'IndexedDB 持久化模式';
      modeBadge.className = 'badge ok';
    }
  }

  /* ---------------- IndexedDB 帮助函数 ---------------- */
  function openDb(name, version, onUpgrade) {
    return new Promise(function (resolve, reject) {
      var req = version ? IDB.open(name, version) : IDB.open(name);
      if (onUpgrade) {
        req.onupgradeneeded = function (e) {
          onUpgrade(req.result, req.transaction, e.oldVersion, e.newVersion);
        };
      }
      req.onblocked = function () { log('⚠ 打开请求被阻塞：存在未关闭的连接'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function deleteDb() {
    return new Promise(function (resolve, reject) {
      var req = IDB.deleteDatabase(MigDemo.DB_NAME);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { log('⚠ 删除数据库被阻塞：请先点击「释放占用」'); };
    });
  }

  function bulkInsert(db, store, items) {
    var chain = Promise.resolve();
    for (var i = 0; i < items.length; i += MigDemo.CHUNK_SIZE) {
      (function (slice) {
        chain = chain.then(function () {
          return new Promise(function (resolve, reject) {
            var tx = db.transaction(store, 'readwrite');
            var os = tx.objectStore(store);
            slice.forEach(function (item) { os.put(item); });
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
          });
        });
      })(items.slice(i, i + MigDemo.CHUNK_SIZE));
    }
    return chain;
  }

  /* ---------------- Canvas 进度可视化 ---------------- */
  var view = { plan: null, done: 0, total: 1, current: null, finished: false };

  function setupCanvas() {
    var dpr = window.devicePixelRatio || 1; // 高分屏兼容
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawProgress() {
    var ctx = canvas.getContext('2d');
    var w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    var percent = view.total > 0 ? Math.min(1, view.done / view.total) : 0;
    var barX = 20, barY = 24, barW = w - 40, barH = 22, radius = 11;

    // 背景轨道
    ctx.fillStyle = '#e5e7eb';
    roundRect(ctx, barX, barY, barW, barH, radius);
    ctx.fill();

    // 已完成部分（渐变）
    if (percent > 0) {
      var grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
      grad.addColorStop(0, '#2563eb');
      grad.addColorStop(1, '#22c55e');
      ctx.fillStyle = grad;
      roundRect(ctx, barX, barY, Math.max(barW * percent, barH), barH, radius);
      ctx.fill();
    }

    // 百分比文本
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(percent * 100) + '%', barX + barW / 2, barY + barH / 2 + 4.5);

    // 步骤刻度与标签
    if (view.plan && view.plan.length) {
      var cumulative = 0;
      ctx.font = '11px system-ui, sans-serif';
      view.plan.forEach(function (step, i) {
        var startX = barX + (cumulative / view.total) * barW;
        cumulative += step.units;
        var endX = barX + (cumulative / view.total) * barW;

        ctx.strokeStyle = '#9ca3af';
        ctx.beginPath();
        ctx.moveTo(endX, barY + barH + 4);
        ctx.lineTo(endX, barY + barH + 10);
        ctx.stroke();

        var isCurrent = view.current === step.id;
        ctx.fillStyle = isCurrent ? '#2563eb' : '#6b7280';
        ctx.textAlign = 'center';
        var label = step.id.replace('-data', '');
        ctx.fillText(label, (startX + endX) / 2, barY + barH + 24);
        if (isCurrent) {
          ctx.fillText('▲', (startX + endX) / 2, barY + barH + 38);
        }
      });
    }

    // 底部状态行
    ctx.fillStyle = '#374151';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    var line = view.finished
      ? '迁移完成 ✓'
      : (view.current ? '当前步骤：' + view.current + '（' + view.done + '/' + view.total + ' 条）' : '等待迁移开始');
    ctx.fillText(line, barX, h - 8);
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- 场景一：生成 v1 旧数据 ---------------- */
  async function seedV1() {
    if (!IDB) { log('当前浏览器不支持 IndexedDB，无法生成持久化旧数据'); return; }
    log('正在重建 v1 旧数据库…');
    await deleteDb();
    var data = MigDemo.generateLegacyData(300, 500);
    var db = await openDb(MigDemo.DB_NAME, 1, function (db, tx) {
      MigDemo.applySchema(db, tx, 0, 1);
    });
    await bulkInsert(db, 'users', data.users);
    await bulkInsert(db, 'orders', data.orders);
    db.close();
    log('v1 旧数据已生成：users=' + data.users.length + '，orders=' + data.orders.length +
        '（含缺 name 字段的遗留记录，state 为数字码）');
    setStatus('数据库版本：v1（待迁移到 v5）');
    view = { plan: null, done: 0, total: 1, current: null, finished: false };
    drawProgress();
  }

  /* ---------------- 场景二：执行迁移（Worker） ---------------- */
  function runMigration() {
    if (worker) { log('迁移正在进行中…'); return; }
    setButtons(true);
    view = { plan: null, done: 0, total: 1, current: null, finished: false };
    drawProgress();

    worker = new Worker('migration-worker.js');
    worker.onmessage = function (e) {
      var msg = e.data;
      switch (msg.type) {
        case 'log':
          log(msg.msg);
          break;
        case 'mode':
          setMode(msg.mode);
          break;
        case 'plan':
          view.plan = msg.steps;
          view.total = msg.totalUnits || 1;
          log('迁移计划：' + msg.steps.map(function (s) { return s.id; }).join(' → ') +
              '，共 ' + msg.totalUnits + ' 个工作量单位');
          drawProgress();
          break;
        case 'step-start':
          view.current = msg.stepId;
          drawProgress();
          break;
        case 'progress':
          view.done = msg.doneUnits;
          view.total = msg.totalUnits || 1;
          drawProgress();
          break;
        case 'step-done':
          drawProgress();
          break;
        case 'blocked':
          setStatus('⚠ 数据库被占用：请关闭其他标签页，或点击「释放占用」');
          break;
        case 'version-error':
          log('⛔ ' + msg.msg);
          setStatus('⛔ 版本回退被阻止：' + msg.msg);
          break;
        case 'rolled-back':
          log('↩ 步骤 ' + msg.stepId + ' 已回滚到迁移前状态（' + msg.error + '）');
          setStatus('迁移失败已回滚：可取消「注入失败」后重新迁移');
          cleanupWorker();
          break;
        case 'done':
          var s = msg.summary;
          view.done = view.total;
          view.finished = true;
          view.current = null;
          drawProgress();
          log('✅ 迁移完成：users=' + s.users + '，orders=' + s.orders +
              '，products=' + s.products + '，logs=' + s.logs);
          log(s.ok
            ? '✅ 数据校验通过：记录数完整、关键字段齐全，无数据丢失'
            : '❌ 数据校验失败：badUsers=' + s.badUsers + '，badOrders=' + s.badOrders);
          setStatus('数据库版本：v5（迁移完成）');
          cleanupWorker();
          break;
        case 'error':
          log('❌ 迁移出错：' + msg.error);
          setStatus('迁移出错：' + msg.error);
          cleanupWorker();
          break;
      }
    };
    worker.onerror = function (e) {
      log('❌ Worker 异常：' + e.message);
      cleanupWorker();
    };
    worker.postMessage({
      cmd: 'migrate',
      injectFailure: $('chkFail').checked,
      forceMemory: $('chkMemory').checked
    });
    log('迁移 Worker 已启动…');
  }

  function cleanupWorker() {
    if (worker) { worker.terminate(); worker = null; }
    setButtons(false);
  }

  /* ---------------- 场景三：模拟中断 ---------------- */
  function interrupt() {
    if (!worker) { log('当前没有正在运行的迁移'); return; }
    worker.terminate();
    worker = null;
    setButtons(false);
    log('⚠ 已模拟中断：Worker 被强制终止（未提交事务由浏览器自动回滚）');
    setStatus('迁移中断 —— 再次点击「迁移到 v5」将从断点续跑');
  }

  /* ---------------- 场景四：数据库被占用 ---------------- */
  async function holdConnection() {
    if (!IDB) return;
    if (heldDb) { log('已经有一个占用中的连接'); return; }
    heldDb = await openDb(MigDemo.DB_NAME);
    heldDb.onversionchange = function () {
      log('（占用连接收到 versionchange 事件，演示模式下保持不关闭）');
    };
    log('已模拟占用：保持一个打开的连接（相当于另一个标签页未关闭）');
    setStatus('数据库被占用中 —— 此时迁移会触发 onblocked 提示');
  }

  function releaseConnection() {
    if (!heldDb) { log('当前没有占用中的连接'); return; }
    heldDb.close();
    heldDb = null;
    log('占用连接已释放，被阻塞的迁移请求将继续执行');
  }

  /* ---------------- 场景五：版本回退检测 ---------------- */
  async function demoVersionRollback() {
    if (!IDB) return;
    var target = MigDemo.DB_VERSION - 1;
    try {
      var db = await openDb(MigDemo.DB_NAME, target);
      db.close();
      log('未触发版本回退（本地数据库版本 ≤ v' + target + '）');
    } catch (err) {
      if (err && err.name === 'VersionError') {
        log('⛔ 版本回退提示：本地数据库已是 v' + MigDemo.DB_VERSION +
            '，旧代码请求 v' + target + ' 被阻止（VersionError）—— 请升级应用');
        setStatus('⛔ 检测到版本回退：已阻止低版本代码打开高版本数据库');
      } else {
        log('打开失败：' + (err && err.message));
      }
    }
  }

  /* ---------------- 重置 ---------------- */
  async function resetAll() {
    if (!IDB) return;
    if (heldDb) { heldDb.close(); heldDb = null; }
    await deleteDb();
    log('数据库已删除，演示环境已重置');
    setStatus('已重置 —— 请先「生成 v1 旧数据」');
    view = { plan: null, done: 0, total: 1, current: null, finished: false };
    drawProgress();
  }

  /* ---------------- 初始化 ---------------- */
  function setButtons(running) {
    $('btnMigrate').disabled = running;
    $('btnInterrupt').disabled = !running;
  }

  window.addEventListener('resize', function () { setupCanvas(); drawProgress(); });

  $('btnSeed').addEventListener('click', function () { seedV1().catch(function (e) { log('生成失败：' + e.message); }); });
  $('btnMigrate').addEventListener('click', runMigration);
  $('btnInterrupt').addEventListener('click', interrupt);
  $('btnHold').addEventListener('click', function () { holdConnection().catch(function (e) { log('占用失败：' + e.message); }); });
  $('btnRelease').addEventListener('click', releaseConnection);
  $('btnRollback').addEventListener('click', function () { demoVersionRollback(); });
  $('btnReset').addEventListener('click', function () { resetAll().catch(function (e) { log('重置失败：' + e.message); }); });

  if (!IDB) {
    log('当前浏览器不支持 IndexedDB，迁移将自动降级为内存模式');
    setMode('memory');
  }
  setButtons(false);
  setupCanvas();
  drawProgress();
})();
