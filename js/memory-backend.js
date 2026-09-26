(function (global) {
  'use strict';

  function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  class MemoryTable {
    constructor(collection) {
      this.collection = collection;
    }

    async all() {
      return Array.from(this.collection.values()).map(clone);
    }

    async count() {
      return this.collection.size;
    }

    async get(id) {
      return clone(this.collection.get(id));
    }

    async put(record) {
      this.collection.set(record.id ?? record.key, clone(record));
      return record.key ?? record.id;
    }
  }

  class MemoryTransaction {
    constructor(database) {
      this.database = database;
    }

    hasStore(name) {
      return this.database.stores.has(name);
    }

    createStore(name) {
      this.database.stores.set(name, new Map());
    }

    table(name) {
      if (!this.database.stores.has(name)) {
        throw new Error(`内存模式缺少对象仓库：${name}`);
      }
      return new MemoryTable(this.database.stores.get(name));
    }
  }

  class MemoryBackend {
    constructor(reason) {
      this.mode = 'memory';
      this.persistent = false;
      this.reason = reason || '已手动切换到内存演示模式';
      this.reset();
    }

    reset() {
      this.version = 0;
      this.stores = new Map();
      this.indexes = new Map();
    }

    async currentVersion() {
      return this.version;
    }

    async migrateVersion(version, schema, transform, callbacks) {
      if (this.version !== version - 1) {
        throw Object.assign(new Error(`必须按顺序迁移：当前 v${this.version}，请求 v${version}`), {
          code: 'INVALID_VERSION_PATH'
        });
      }

      const snapshot = {
        version: this.version,
        stores: new Map(Array.from(this.stores, ([name, rows]) => [name, new Map(clone(Array.from(rows)))])),
        indexes: new Map(Array.from(this.indexes, ([name, definitions]) => [name, clone(definitions)]))
      };

      callbacks.onProgress({ phase: 'schema', versionProgress: 0.04, overallPercent: ((version - 1) / 5) * 100, label: `创建 v${version} 对象仓库和索引` });

      try {
        for (const name of Object.keys(schema.stores)) {
          if (!this.stores.has(name)) {
            this.stores.set(name, new Map());
            this.indexes.set(name, {});
          }
          const indexMap = this.indexes.get(name);
          (schema.stores[name].indexes || []).forEach(function (definition) {
            indexMap[definition.name] = definition.keyPath;
          });
        }

        Object.entries(schema.storeIndexes || {}).forEach(([storeName, definitions]) => {
          if (!this.stores.has(storeName)) this.stores.set(storeName, new Map());
          if (!this.indexes.has(storeName)) this.indexes.set(storeName, {});
          const indexMap = this.indexes.get(storeName);
          definitions.forEach(function (definition) {
            indexMap[definition.name] = definition.keyPath;
          });
        });

        const tx = new MemoryTransaction(this);
        if (transform) {
          await transform(tx, (done, total, label) => {
            const fraction = total > 0 ? done / total : 1;
            callbacks.onProgress({
              phase: 'data',
              versionProgress: 0.04 + fraction * 0.92,
              overallPercent: ((version - 1 + 0.04 + fraction * 0.92) / 5) * 100,
              label
            });
          });
        }

        await tx.table('appMeta').put({
          key: `migration_v${version}`,
          version,
          appliedAt: new Date().toISOString()
        });

        this.version = version;
        callbacks.onProgress({ phase: 'commit', versionProgress: 1, overallPercent: (version / 5) * 100, label: `v${version} 已提交` });
      } catch (error) {
        this.version = snapshot.version;
        this.stores = snapshot.stores;
        this.indexes = snapshot.indexes;
        throw error;
      }
    }

    async seedV1(users, report) {
      if (this.version === 0) {
        throw new Error('内存模式尚未初始化 v1');
      }
      if (this.version !== 1) {
        throw Object.assign(new Error('只能向 v1 数据库写入旧格式数据'), { code: 'INVALID_SEED_VERSION' });
      }

      const usersStore = this.stores.get('users');
      const metaStore = this.stores.get('appMeta');
      for (let index = 0; index < users.length; index += 1) {
        const user = clone(users[index]);
        usersStore.set(user.id, user);
        report(index + 1, users.length);
      }
      metaStore.set('legacySeed', {
        key: 'legacySeed',
        version: 1,
        count: users.length,
        createdAt: new Date().toISOString()
      });
    }

    async collectState() {
      const storeNames = Array.from(this.stores.keys());
      const stores = {};
      const records = {};
      for (const name of storeNames) {
        const rows = await new MemoryTable(this.stores.get(name)).all();
        const indexCounts = {};
        Object.entries(this.indexes.get(name) || {}).forEach(function (entry) {
          const indexName = entry[0];
          const keyPath = entry[1];
          indexCounts[indexName] = rows.filter(function (row) {
            if (Array.isArray(keyPath)) {
              return keyPath.every(function (key) {
                return row[key] !== undefined && row[key] !== null;
              });
            }
            return row[keyPath] !== undefined && row[keyPath] !== null;
          }).length;
        });
        stores[name] = { count: rows.length, indexCounts };
        records[name] = rows;
      }
      return { version: this.version, stores, records };
    }

    async deleteDatabase() {
      this.reset();
    }

    async holdConnection() {
      this.holdEnabled = true;
    }

    async releaseConnection() {
      this.holdEnabled = false;
    }
  }

  global.MemoryBackend = MemoryBackend;
})(typeof self !== 'undefined' ? self : globalThis);
