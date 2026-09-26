(function (global) {
  'use strict';

  const PROBE_DB_NAME = 'idb-migration-probe';

  function promisify(request, callbacks) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        reject(request.error || new Error('IndexedDB 请求失败'));
      };
      request.onblocked = function (event) {
        if (callbacks && callbacks.onBlocked) {
          callbacks.onBlocked(event);
        }
      };
    });
  }

  function allFromStore(store) {
    if (typeof store.getAll === 'function') {
      return promisify(store.getAll());
    }

    return new Promise(function (resolve, reject) {
      const rows = [];
      const request = store.openCursor();
      request.onsuccess = function () {
        const cursor = request.result;
        if (cursor) {
          rows.push(cursor.value);
          cursor.continue();
        } else {
          resolve(rows);
        }
      };
      request.onerror = function () {
        reject(request.error || new Error('读取游标失败'));
      };
    });
  }

  class IDBTransaction {
    constructor(transaction, database) {
      this.transaction = transaction;
      this.database = database;
      this.stores = {};
    }

    hasStore(name) {
      return this.database.objectStoreNames.contains(name);
    }

    createStore(name, definition) {
      return this.transaction.objectStore(name);
    }

    table(name) {
      if (!this.stores[name]) {
        this.stores[name] = this.transaction.objectStore(name);
      }
      return {
        all: () => allFromStore(this.stores[name]),
        count: () => promisify(this.stores[name].count()),
        get: id => promisify(this.stores[name].get(id)),
        put: record => promisify(this.stores[name].put(record))
      };
    }
  }

  function applySchema(database, transaction, version, schema) {
    Object.keys(schema.stores || {}).forEach(function (storeName) {
      const definition = schema.stores[storeName];
      let store;
      if (!database.objectStoreNames.contains(storeName)) {
        store = database.createObjectStore(storeName, { keyPath: definition.keyPath });
      } else {
        store = transaction.objectStore(storeName);
      }

      (definition.indexes || []).forEach(function (indexDefinition) {
        if (!store.indexNames.contains(indexDefinition.name)) {
          store.createIndex(indexDefinition.name, indexDefinition.keyPath, {
            unique: Boolean(indexDefinition.unique)
          });
        }
      });
    });

    Object.keys(schema.storeIndexes || {}).forEach(function (storeName) {
      const store = transaction.objectStore(storeName);
      schema.storeIndexes[storeName].forEach(function (indexDefinition) {
        if (!store.indexNames.contains(indexDefinition.name)) {
          store.createIndex(indexDefinition.name, indexDefinition.keyPath, {
            unique: Boolean(indexDefinition.unique)
          });
        }
      });
    });
  }

  class IndexedDbBackend {
    constructor(dbName) {
      this.dbName = dbName;
      this.mode = 'indexeddb';
      this.persistent = true;
      this.activeDatabase = null;
      this.heldDatabase = null;
    }

    static isSupported() {
      return Boolean(
        typeof global !== 'undefined' &&
        global.indexedDB &&
        typeof global.indexedDB.open === 'function' &&
        global.IDBTransaction
      );
    }

    static async probe(timeoutMs) {
      if (!IndexedDbBackend.isSupported()) {
        return {
          ok: false,
          persistent: false,
          reason: '当前浏览器未提供 IndexedDB'
        };
      }

      const waitMs = timeoutMs || 2500;
      let request;
      let settled = false;

      const cleanup = function (database) {
        if (database) {
          try {
            database.close();
          } catch (error) {
            return;
          }
        }
        try {
          global.indexedDB.deleteDatabase(PROBE_DB_NAME);
        } catch (error) {
          return;
        }
      };

      const result = await new Promise(function (resolve) {
        const finish = function (ok, reason, database) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          cleanup(database);
          resolve({ ok, persistent: ok, reason: reason || '' });
        };

        const timer = setTimeout(function () {
          finish(false, 'IndexedDB 打开超时，可能处于隐私模式或被浏览器策略禁用');
        }, waitMs);

        try {
          request = global.indexedDB.open(PROBE_DB_NAME, 1);
          request.onupgradeneeded = function () {
            const database = request.result;
            if (!database.objectStoreNames.contains('probe')) {
              database.createObjectStore('probe', { keyPath: 'key' });
            }
          };
          request.onsuccess = function () {
            const database = request.result;
            let transaction;
            try {
              const store = database.transaction('probe', 'readwrite').objectStore('probe');
              const write = store.put({ key: 'ok', value: Date.now() });
              transaction = write.transaction;
              transaction.oncomplete = function () {
                finish(true, '', database);
              };
              transaction.onerror = function () {
                finish(false, 'IndexedDB 写入被拒绝，可能处于隐私模式', database);
              };
              transaction.onabort = function () {
                finish(false, (transaction.error && transaction.error.message) || 'IndexedDB 写入事务被中止', database);
              };
            } catch (error) {
              finish(false, error.message || 'IndexedDB 不可写入', database);
            }
          };
          request.onerror = function () {
            finish(false, (request.error && request.error.message) || 'IndexedDB 打开失败');
          };
          request.onblocked = function () {
            finish(false, 'IndexedDB 探测被其他连接阻塞');
          };
        } catch (error) {
          finish(false, error.message || '浏览器拒绝创建 IndexedDB');
        }
      });

      return result;
    }

    async openExisting() {
      const database = await promisify(global.indexedDB.open(this.dbName));
      this.activeDatabase = database;
      return database;
    }

    async closeActive() {
      if (this.activeDatabase) {
        try {
          this.activeDatabase.close();
        } catch (error) {
          return;
        }
        this.activeDatabase = null;
      }
    }

    async currentVersion() {
      try {
        const database = await this.openExisting();
        const version = database.version;
        await this.closeActive();
        return version;
      } catch (error) {
        if (error && (error.name === 'NotFoundError' || /not\s*found/i.test(error.message || ''))) {
          return 0;
        }
        if (error && error.name === 'InvalidStateError') {
          return 0;
        }
        throw error;
      }
    }

    async migrateVersion(version, schema, transform, callbacks) {
      const from = await this.currentVersion();
      if (from !== version - 1) {
        throw Object.assign(new Error(`必须按顺序迁移：当前 v${from}，请求 v${version}`), {
          code: 'INVALID_VERSION_PATH',
          currentVersion: from,
          requestedVersion: version
        });
      }

      const backend = this;
      const request = global.indexedDB.open(this.dbName, version);
      let upgradeDatabase = null;

      request.onupgradeneeded = function () {
        upgradeDatabase = request.result;
        const transaction = request.transaction;
        applySchema(upgradeDatabase, transaction, version, schema);

        if (version === 1) {
          callbacks.onProgress({
            phase: 'schema',
            versionProgress: 1,
            overallPercent: 20,
            label: 'v1 基线结构已创建'
          });
          return;
        }

        callbacks.onProgress({
          phase: 'schema',
          versionProgress: 0.04,
          overallPercent: ((version - 1.04) / 5) * 100,
          label: `创建 v${version} 对象仓库和索引`
        });

        const adapter = new IDBTransaction(transaction, upgradeDatabase);
        transform(adapter, function (done, total, label) {
          const fraction = total > 0 ? done / total : 1;
          callbacks.onProgress({
            phase: 'data',
            versionProgress: 0.04 + fraction * 0.92,
            overallPercent: ((version - 1 + 0.04 + fraction * 0.92) / 5) * 100,
            label
          });
        })
          .then(function () {
            const metaStore = transaction.objectStore('appMeta');
            const metaRequest = metaStore.put({
              key: `migration_v${version}`,
              version,
              appliedAt: new Date().toISOString()
            });
            metaRequest.onsuccess = function () {
              callbacks.onProgress({
                phase: 'commit',
                versionProgress: 1,
                overallPercent: (version / 5) * 100,
                label: `v${version} 已提交`
              });
            };
          })
          .catch(function (error) {
            try {
              transaction.abort();
            } catch (abortError) {
              throw error;
            }
          });
      };

      request.onblocked = function (event) {
        callbacks.onBlocked(Object.assign({
          code: 'BLOCKED',
          message: '数据库仍被旧版本页面或标签页占用，请关闭旧连接后继续'
        }, event));
      };

      try {
        const database = await new Promise(function (resolve, reject) {
          request.onsuccess = function () {
            resolve(request.result);
          };
          request.onerror = function () {
            reject(request.error || new Error(`v${version} 迁移失败`));
          };
        });
        database.close();
        if (upgradeDatabase && upgradeDatabase !== database) {
          upgradeDatabase.close();
        }
      } catch (error) {
        if (backend.heldDatabase) {
          backend.releaseConnection();
        }
        throw Object.assign(error, {
          code: error.code || error.name || 'MIGRATION_FAILED',
          currentVersion: from,
          requestedVersion: version
        });
      }
    }

    async seedV1(users, report) {
      const database = await this.openExisting();
      if (database.version !== 1) {
        database.close();
        this.activeDatabase = null;
        throw Object.assign(new Error('只能向 v1 数据库写入旧格式数据'), { code: 'INVALID_SEED_VERSION' });
      }

      await new Promise(function (resolve, reject) {
        const transaction = database.transaction(['users', 'appMeta'], 'readwrite');
        const usersStore = transaction.objectStore('users');
        const metaStore = transaction.objectStore('appMeta');

        users.forEach(function (user, index) {
          usersStore.put(user);
          report(index + 1, users.length);
        });

        metaStore.put({
          key: 'legacySeed',
          version: 1,
          count: users.length,
          createdAt: new Date().toISOString()
        });

        transaction.oncomplete = resolve;
        transaction.onerror = function () {
          reject(transaction.error || new Error('v1 旧数据写入失败'));
        };
        transaction.onabort = function () {
          reject(transaction.error || new Error('v1 旧数据写入被中止'));
        };
      });

      await this.closeActive();
    }

    async collectState() {
      const existingVersion = await this.currentVersion();
      if (existingVersion === 0) {
        return { version: 0, stores: {}, records: {} };
      }
      const database = await this.openExisting();
      const version = database.version;
      const storeNames = Array.prototype.slice.call(database.objectStoreNames);

      const state = await new Promise(function (resolve, reject) {
        const transaction = database.transaction(storeNames, 'readonly');
        const stores = {};
        const records = {};
        let pending = storeNames.length;

        if (pending === 0) {
          resolve({ version, stores, records });
          return;
        }

        storeNames.forEach(function (name) {
          const store = transaction.objectStore(name);
          const indexNames = Array.prototype.slice.call(store.indexNames);
          Promise.all([
            allFromStore(store),
            Promise.all(indexNames.map(function (indexName) {
              return promisify(store.index(indexName).count()).then(function (count) {
                return [indexName, count];
              });
            }))
          ])
            .then(function (values) {
              records[name] = values[0];
              stores[name] = {
                count: values[0].length,
                indexCounts: values[1].reduce(function (result, entry) {
                  result[entry[0]] = entry[1];
                  return result;
                }, {})
              };
              pending -= 1;
              if (pending === 0) {
                resolve({ version, stores, records });
              }
            })
            .catch(reject);
        });
      });

      await this.closeActive();
      return state;
    }

    async deleteDatabase() {
      await this.closeActive();
      await this.releaseConnection();
      await new Promise(function (resolve, reject) {
        const request = global.indexedDB.deleteDatabase(this.dbName);
        request.onsuccess = resolve;
        request.onerror = function () {
          reject(request.error || new Error('删除数据库失败'));
        };
        request.onblocked = function () {
          reject(Object.assign(new Error('数据库仍被占用，无法删除'), { code: 'BLOCKED' }));
        };
      }.bind(this));
    }

    async holdConnection() {
      await this.releaseConnection();
      const database = await promisify(global.indexedDB.open(this.dbName));
      database.onversionchange = function () {
        return;
      };
      this.heldDatabase = database;
    }

    async releaseConnection() {
      if (this.heldDatabase) {
        const database = this.heldDatabase;
        this.heldDatabase = null;
        await new Promise(function (resolve) {
          try {
            database.close();
          } catch (error) {
            return;
          }
          setTimeout(resolve, 60);
        });
      }
    }
  }

  global.IndexedDbBackend = IndexedDbBackend;
})(typeof self !== 'undefined' ? self : globalThis);
