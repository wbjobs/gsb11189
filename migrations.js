/*
 * migrations.js — 共享迁移定义（主线程与 Web Worker 共用）
 * 包含：常量、v1 基线 schema、v2~v5 迁移步骤（schema + data）、旧数据生成器。
 * 所有 data 步骤都是幂等的：中断后重跑同一步骤不会产生脏数据。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'migration-demo-db';
  var DB_VERSION = 5;
  var META_STORE = '__meta';     // 迁移检查点
  var BACKUP_STORE = '__backup'; // 步骤级备份（失败回滚用）
  var CHUNK_SIZE = 50;           // 每个事务处理的记录数（驱动进度条）

  /* ---------------- v1 基线结构 ---------------- */
  function schemaV1(db) {
    if (!db.objectStoreNames.contains('users')) {
      var users = db.createObjectStore('users', { keyPath: 'id' });
      users.createIndex('name', 'name', { unique: false });
    }
    if (!db.objectStoreNames.contains('orders')) {
      db.createObjectStore('orders', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains(META_STORE)) {
      db.createObjectStore(META_STORE, { keyPath: 'key' });
    }
    if (!db.objectStoreNames.contains(BACKUP_STORE)) {
      db.createObjectStore(BACKUP_STORE, { keyPath: 'key' });
    }
  }

  /* ---------------- 工具 ---------------- */
  function splitName(name, id) {
    if (!name || typeof name !== 'string') return { first: 'user' + id, last: 'legacy' };
    var parts = name.trim().split(/\s+/);
    if (parts.length === 1) return { first: parts[0].toLowerCase(), last: 'unknown' };
    return { first: parts[0].toLowerCase(), last: parts.slice(1).join('.').toLowerCase() };
  }

  function chunks(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  var DEFAULT_PRODUCTS = [
    { id: 1, name: 'Demo Book', category: 'book', price: 10 },
    { id: 2, name: 'Demo Pen', category: 'stationery', price: 3 },
    { id: 3, name: 'Demo Mug', category: 'life', price: 15 },
    { id: 4, name: 'Demo Bag', category: 'life', price: 45 },
    { id: 5, name: 'Demo Lamp', category: 'life', price: 60 }
  ];

  var ORDER_STATE_MAP = { 0: 'pending', 1: 'paid', 2: 'shipped' };

  /* ---------------- 数据迁移（幂等） ----------------
   * ctx = { adapter, report(unitsDone), injectFailure }
   * adapter 提供 getAll/get/put/delete/clear/count/bulkPut，
   * 真实 IndexedDB 与内存降级模式共用同一接口。 */

  // v2：users 补 createdAt；初始化 products 表数据
  async function migrateV2Data(ctx) {
    var users = await ctx.adapter.getAll('users');
    var groups = chunks(users, CHUNK_SIZE);
    for (var i = 0; i < groups.length; i++) {
      var toWrite = [];
      groups[i].forEach(function (u) {
        if (u.createdAt === undefined) {
          u.createdAt = 0; // 遗留数据无法得知创建时间，置 0 作为兼容标记
          u.legacy = true;
          toWrite.push(u);
        }
      });
      if (toWrite.length) await ctx.adapter.bulkPut('users', toWrite);
      ctx.report(groups[i].length);
    }
    if ((await ctx.adapter.count('products')) === 0) {
      await ctx.adapter.bulkPut('products', DEFAULT_PRODUCTS);
    }
    ctx.report(DEFAULT_PRODUCTS.length);
  }

  // v3：users.name 拆分为 firstName/lastName，并生成唯一 email
  async function migrateV3Data(ctx) {
    var users = await ctx.adapter.getAll('users');
    var usedEmails = {};
    users.forEach(function (u) { if (u.email) usedEmails[u.email] = true; });
    var groups = chunks(users, CHUNK_SIZE);
    for (var i = 0; i < groups.length; i++) {
      var toWrite = [];
      groups[i].forEach(function (u) {
        if (u.firstName !== undefined) return; // 已迁移过，跳过（幂等）
        var parts = splitName(u.name, u.id);
        u.firstName = parts.first;
        u.lastName = parts.last;
        var email = parts.first + '.' + parts.last + '@demo.local';
        if (usedEmails[email]) email = parts.first + '.' + parts.last + '+' + u.id + '@demo.local';
        usedEmails[email] = true;
        u.email = email;
        delete u.name; // 旧字段下线
        toWrite.push(u);
      });
      if (toWrite.length) await ctx.adapter.bulkPut('users', toWrite);
      ctx.report(groups[i].length);
    }
  }

  // v4：orders.state(数字码) → orders.status(字符串)，补 updatedAt
  async function migrateV4Data(ctx) {
    var orders = await ctx.adapter.getAll('orders');
    var groups = chunks(orders, CHUNK_SIZE);
    var injected = false;
    for (var i = 0; i < groups.length; i++) {
      // 演示用：注入一次失败，验证回滚
      if (ctx.injectFailure && !injected && i >= Math.floor(groups.length / 2)) {
        injected = true;
        throw new Error('注入的迁移失败（v4-data 中途出错）');
      }
      var toWrite = [];
      groups[i].forEach(function (o) {
        if (o.status !== undefined) return; // 幂等
        o.status = ORDER_STATE_MAP[o.state] || 'pending'; // 未知旧码兜底
        o.updatedAt = 0;
        delete o.state;
        toWrite.push(o);
      });
      if (toWrite.length) await ctx.adapter.bulkPut('orders', toWrite);
      ctx.report(groups[i].length);
    }
  }

  // v5：users 计算 score（订单数*10）；logs 写入迁移完成记录
  async function migrateV5Data(ctx) {
    var orders = await ctx.adapter.getAll('orders');
    var counts = {};
    orders.forEach(function (o) { counts[o.userId] = (counts[o.userId] || 0) + 1; });
    var users = await ctx.adapter.getAll('users');
    var groups = chunks(users, CHUNK_SIZE);
    for (var i = 0; i < groups.length; i++) {
      var toWrite = [];
      groups[i].forEach(function (u) {
        if (u.score !== undefined) return; // 幂等
        u.score = (counts[u.id] || 0) * 10;
        toWrite.push(u);
      });
      if (toWrite.length) await ctx.adapter.bulkPut('users', toWrite);
      ctx.report(groups[i].length);
    }
    if ((await ctx.adapter.count('logs')) === 0) {
      await ctx.adapter.bulkPut('logs', [{ ts: Date.now(), message: 'migration to v5 completed' }]);
    }
    ctx.report(1);
  }

  /* ---------------- 迁移步骤表 ---------------- */
  var STEPS = [
    {
      id: 'v2-schema', version: 2, type: 'schema',
      label: 'v2 结构：orders.userId 索引 + products 表',
      schema: function (db, tx) {
        var orders = tx.objectStore('orders');
        if (!orders.indexNames.contains('userId')) orders.createIndex('userId', 'userId');
        if (!db.objectStoreNames.contains('products')) {
          var products = db.createObjectStore('products', { keyPath: 'id' });
          products.createIndex('category', 'category');
        }
      }
    },
    {
      id: 'v2-data', version: 2, type: 'data',
      label: 'v2 数据：users 补 createdAt / 初始化 products',
      stores: ['users', 'products'],
      estimate: function (adapter) {
        return adapter.count('users').then(function (n) { return n + DEFAULT_PRODUCTS.length; });
      },
      run: migrateV2Data
    },
    {
      id: 'v3-schema', version: 3, type: 'schema',
      label: 'v3 结构：users.email 唯一索引',
      schema: function (db, tx) {
        var users = tx.objectStore('users');
        if (!users.indexNames.contains('email')) users.createIndex('email', 'email', { unique: true });
      }
    },
    {
      id: 'v3-data', version: 3, type: 'data',
      label: 'v3 数据：name 拆分 firstName/lastName + 生成 email',
      stores: ['users'],
      estimate: function (adapter) { return adapter.count('users'); },
      run: migrateV3Data
    },
    {
      id: 'v4-schema', version: 4, type: 'schema',
      label: 'v4 结构：新增 logs 表 + users.lastName 索引',
      schema: function (db, tx) {
        if (!db.objectStoreNames.contains('logs')) {
          db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        }
        var users = tx.objectStore('users');
        if (!users.indexNames.contains('lastName')) users.createIndex('lastName', 'lastName');
      }
    },
    {
      id: 'v4-data', version: 4, type: 'data',
      label: 'v4 数据：orders.state → status 转换',
      stores: ['orders'],
      estimate: function (adapter) { return adapter.count('orders'); },
      run: migrateV4Data
    },
    {
      id: 'v5-schema', version: 5, type: 'schema',
      label: 'v5 结构：orders.status 索引 + 下线 users.name 索引',
      schema: function (db, tx) {
        var orders = tx.objectStore('orders');
        if (!orders.indexNames.contains('status')) orders.createIndex('status', 'status');
        var users = tx.objectStore('users');
        if (users.indexNames.contains('name')) users.deleteIndex('name'); // 旧字段索引下线
      }
    },
    {
      id: 'v5-data', version: 5, type: 'data',
      label: 'v5 数据：users 计算 score / logs 记录',
      stores: ['users', 'logs'],
      estimate: function (adapter) {
        return adapter.count('users').then(function (n) { return n + 1; });
      },
      run: migrateV5Data
    }
  ];

  /* 在 onupgradeneeded 中按版本区间应用结构变更（浏览器保证原子性） */
  function applySchema(db, tx, oldVersion, newVersion) {
    if (oldVersion < 1) schemaV1(db);
    STEPS.forEach(function (s) {
      if (s.type === 'schema' && s.version > oldVersion && s.version <= newVersion) {
        s.schema(db, tx);
      }
    });
  }

  /* ---------------- v1 旧数据生成器 ---------------- */
  function generateLegacyData(userCount, orderCount) {
    var FIRST = ['Zhang', 'Wang', 'Li', 'Zhao', 'Chen', 'Liu', 'Yang'];
    var LAST = ['San', 'Si', 'Wu', 'Liu', 'Qi', 'Ba', 'Jiu'];
    var users = [];
    for (var i = 1; i <= userCount; i++) {
      var u = { id: i, name: FIRST[i % FIRST.length] + ' ' + LAST[i % LAST.length] };
      if (i % 10 === 0) delete u.name; // 模拟更老的遗留记录：连 name 都没有
      users.push(u);
    }
    var orders = [];
    for (var j = 1; j <= orderCount; j++) {
      orders.push({ id: j, userId: 1 + ((j * 7) % userCount), state: j % 3, amount: (j % 100) + 1 });
    }
    return { users: users, orders: orders };
  }

  global.MigDemo = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    META_STORE: META_STORE,
    BACKUP_STORE: BACKUP_STORE,
    CHUNK_SIZE: CHUNK_SIZE,
    STEPS: STEPS,
    applySchema: applySchema,
    generateLegacyData: generateLegacyData
  };
})(typeof self !== 'undefined' ? self : window);
