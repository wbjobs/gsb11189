(function (global) {
  'use strict';

  const Schema = global.MigrationSchema;
  const IndexedDbBackend = global.IndexedDbBackend;
  const MemoryBackend = global.MemoryBackend;

  function spin(ms) {
    const start = performance.now();
    while (performance.now() - start < ms) {
      // Intentionally block the worker briefly so progress and interruption are visible.
    }
  }

  function expectedStores(version) {
    const names = [];
    for (let current = 1; current <= version; current += 1) {
      Object.keys(Schema.SCHEMA[current].stores || {}).forEach(function (name) {
        if (!names.includes(name)) {
          names.push(name);
        }
      });
    }
    return names;
  }

  function expectedIndexes(version) {
    const result = {};
    for (let current = 1; current <= version; current += 1) {
      Object.entries(Schema.SCHEMA[current].stores || {}).forEach(function (entry) {
        const storeName = entry[0];
        const definition = entry[1];
        result[storeName] = result[storeName] || {};
        (definition.indexes || []).forEach(function (indexDefinition) {
          result[storeName][indexDefinition.name] = indexDefinition.keyPath;
        });
      });

      Object.entries(Schema.SCHEMA[current].storeIndexes || {}).forEach(function (entry) {
        const storeName = entry[0];
        result[storeName] = result[storeName] || {};
        entry[1].forEach(function (indexDefinition) {
          result[storeName][indexDefinition.name] = indexDefinition.keyPath;
        });
      });
    }
    return result;
  }

  class MigrationRunner {
    constructor(backend) {
      this.backend = backend;
    }

    static async create(options) {
      const settings = options || {};
      if (settings.forceMemory) {
        return new MigrationRunner(new MemoryBackend(settings.reason || '已选择内存演示模式'));
      }

      const probe = await IndexedDbBackend.probe(settings.probeTimeout);
      if (!probe.ok) {
        return new MigrationRunner(new MemoryBackend(probe.reason));
      }

      return new MigrationRunner(new IndexedDbBackend(Schema.DB_NAME));
    }

    async getCurrentVersion() {
      return this.backend.currentVersion();
    }

    async migrate(options) {
      const settings = options || {};
      const target = Number(settings.targetVersion || Schema.TARGET_VERSION);
      if (!Number.isInteger(target) || target < 1 || target > Schema.TARGET_VERSION) {
        throw Object.assign(new Error(`目标版本必须在 v1 到 v${Schema.TARGET_VERSION} 之间`), {
          code: 'INVALID_TARGET_VERSION'
        });
      }

      const current = await this.backend.currentVersion();
      if (target < current) {
        throw Object.assign(new Error(`IndexedDB 不支持降低数据库版本：当前 v${current}，请求 v${target}`), {
          code: 'DOWNGRADE_NOT_SUPPORTED',
          currentVersion: current,
          targetVersion: target
        });
      }

      const failVersion = Number(settings.failVersion || 0);
      for (let version = current + 1; version <= target; version += 1) {
        const versionSchema = Schema.SCHEMA[version];
        const callbacks = {
          onProgress: partial => {
            if (settings.onProgress) {
              settings.onProgress(Object.assign({ version }, partial));
            }
            if (partial.phase === 'data' && settings.slow) {
              spin(7);
            }
            if (failVersion === version && partial.phase === 'data') {
              throw Object.assign(new Error(`已在 v${version} 注入失败，当前版本事务正在回滚`), {
                code: 'INJECTED_FAILURE',
                rollbackVersion: version - 1
              });
            }
          },
          onBlocked: event => {
            if (settings.onBlocked) {
              settings.onBlocked(event);
            }
          }
        };

        if (settings.onProgress) {
          settings.onProgress({
            version,
            phase: 'start',
            versionProgress: 0,
            overallPercent: ((version - 1) / 5) * 100,
            label: `开始迁移 v${version - 1} → v${version}`
          });
        }

        await this.backend.migrateVersion(
          version,
          versionSchema,
          Schema.TRANSFORMS[version],
          callbacks
        );
      }

      return this.backend.currentVersion();
    }

    async prepareV1(options) {
      const settings = options || {};
      const current = await this.backend.currentVersion();
      if (current > 1) {
        throw Object.assign(new Error(`当前已经是 v${current}，不能重新生成 v1。请先重置数据库。`), {
          code: 'DOWNGRADE_NOT_SUPPORTED'
        });
      }

      if (current === 0) {
        await this.migrate({ targetVersion: 1, slow: false, onProgress: settings.onProgress });
      }

      const state = await this.backend.collectState();
      if ((state.stores.users && state.stores.users.count) !== 0 && !settings.forceSeed) {
        return { seeded: false, count: state.stores.users.count, version: 1 };
      }

      const users = Schema.seedUsers(Schema.SEED_USER_COUNT);
      await this.backend.seedV1(users, function (done, total) {
        if (settings.onProgress) {
          settings.onProgress({
            version: 1,
            phase: 'seed',
            versionProgress: done / total,
            overallPercent: (done / total) * 20,
            label: `写入 v1 旧格式用户 ${done}/${total}`
          });
        }
      });
      return { seeded: true, count: users.length, version: 1 };
    }

    async collectState() {
      return this.backend.collectState();
    }

    async deleteDatabase() {
      return this.backend.deleteDatabase();
    }

    async holdConnection() {
      return this.backend.holdConnection();
    }

    async releaseConnection() {
      return this.backend.releaseConnection();
    }

    describeEnvironment() {
      return {
        mode: this.backend.mode,
        persistent: Boolean(this.backend.persistent),
        reason: this.backend.reason || '',
        indexedDBSupported: Boolean(global.indexedDB),
        webWorkerSupported: typeof Worker !== 'undefined',
        blobSupported: typeof Blob !== 'undefined',
        promiseSupported: typeof Promise !== 'undefined'
      };
    }

    validateState(state, targetVersion) {
      const errors = [];
      const warnings = [];
      const version = Number(state.version || 0);
      const expected = expectedStores(targetVersion);
      const indexes = expectedIndexes(targetVersion);
      const records = state.records || {};
      const stores = state.stores || {};
      const rows = name => records[name] || [];
      const count = name => rows(name).length;

      if (version !== targetVersion) {
        errors.push(`版本应为 v${targetVersion}，实际为 v${version}`);
      }

      expected.forEach(function (name) {
        if (!stores[name]) {
          errors.push(`缺少对象仓库 ${name}`);
        }
      });

      Object.keys(stores).forEach(function (name) {
        if (!expected.includes(name)) {
          warnings.push(`存在额外对象仓库 ${name}`);
        }
      });

      if (this.backend.mode === 'indexeddb') {
        Object.entries(indexes).forEach(function (entry) {
          const storeName = entry[0];
          const expectedIndexMap = entry[1];
          const actualCounts = (stores[storeName] && stores[storeName].indexCounts) || {};
          Object.keys(expectedIndexMap).forEach(function (indexName) {
            if (!(indexName in actualCounts)) {
              errors.push(`缺少索引 ${storeName}.${indexName}`);
            } else if (rows(storeName).some(record => record !== undefined)) {
              const keyPath = expectedIndexMap[indexName];
              const missing = rows(storeName).some(function (record) {
                if (Array.isArray(keyPath)) {
                  return keyPath.some(function (key) {
                    return record[key] === undefined || record[key] === null;
                  });
                }
                return record[keyPath] === undefined || record[keyPath] === null;
              });
              if (missing) {
                errors.push(`索引 ${storeName}.${indexName} 存在空键，旧数据兼容不完整`);
              }
            }
          });
        });
      }

      const users = rows('users');
      const posts = rows('posts');
      const comments = rows('comments');
      const attachments = rows('attachments');
      const auditLogs = rows('auditLogs');
      const userIds = new Set(users.map(user => user.id));
      const postIds = new Set(posts.map(post => post.id));

      if (targetVersion >= 1) {
        users.forEach(function (user) {
          if (!user.id || !user.name || !user.createdAt) {
            errors.push(`用户 ${user.id || '(无 ID)'} 缺少 v1 必填字段`);
          }
        });
      }

      if (targetVersion >= 2) {
        users.forEach(function (user) {
          if (!user.handle || !user.email) {
            errors.push(`用户 ${user.id} 未补齐 v2 字段`);
          }
        });
        if (users.length !== posts.length) {
          errors.push(`v2 帖子数量 ${posts.length} 与用户数量 ${users.length} 不一致`);
        }
        posts.forEach(function (post) {
          if (!post.userId || !userIds.has(post.userId) || !post.title || !post.body) {
            errors.push(`帖子 ${post.id || '(无 ID)'} 的 v2 数据不完整`);
          }
        });
      }

      if (targetVersion >= 3) {
        posts.forEach(function (post) {
          if (!post.excerpt) {
            errors.push(`帖子 ${post.id} 缺少 v3 摘要`);
          }
        });
        if (posts.length !== comments.length) {
          errors.push(`v3 评论数量 ${comments.length} 与帖子数量 ${posts.length} 不一致`);
        }
        comments.forEach(function (comment) {
          if (!comment.postId || !postIds.has(comment.postId) || !comment.text) {
            errors.push(`评论 ${comment.id || '(无 ID)'} 的 v3 数据不完整`);
          }
        });
      }

      if (targetVersion >= 4) {
        comments.forEach(function (comment) {
          if (!comment.snippet) {
            errors.push(`评论 ${comment.id} 缺少 v4 短摘`);
          }
        });
        if (posts.length !== attachments.length) {
          errors.push(`v4 附件数量 ${attachments.length} 与帖子数量 ${posts.length} 不一致`);
        }
        attachments.forEach(function (attachment) {
          if (!attachment.postId || !postIds.has(attachment.postId) || !attachment.kind) {
            errors.push(`附件 ${attachment.id || '(无 ID)'} 的 v4 数据不完整`);
          }
        });
      }

      if (targetVersion >= 5) {
        attachments.forEach(function (attachment) {
          if (!attachment.sizeLabel) {
            errors.push(`附件 ${attachment.id} 缺少 v5 大小标签`);
          }
        });
        if (attachments.length !== auditLogs.length) {
          errors.push(`v5 审计日志数量 ${auditLogs.length} 与附件数量 ${attachments.length} 不一致`);
        }
        auditLogs.forEach(function (log) {
          if (log.entity !== 'attachment' || !log.entityId || !log.action) {
            errors.push(`审计日志 ${log.id || '(无 ID)'} 的 v5 数据不完整`);
          }
        });
      }

      return {
        ok: errors.length === 0,
        errors,
        warnings,
        counts: {
          users: users.length,
          posts: posts.length,
          comments: comments.length,
          attachments: attachments.length,
          auditLogs: auditLogs.length
        }
      };
    }
  }

  global.MigrationRunner = MigrationRunner;
})(typeof self !== 'undefined' ? self : globalThis);
