(function (global) {
  'use strict';

  const DB_NAME = 'idb-migration-demo';
  const TARGET_VERSION = 5;
  const SEED_USER_COUNT = 60;

  const SCHEMA = {
    1: {
      stores: {
        appMeta: {
          keyPath: 'key',
          indexes: []
        },
        users: {
          keyPath: 'id',
          indexes: [
            { name: 'by_created', keyPath: 'createdAt' }
          ]
        }
      }
    },
    2: {
      stores: {
        posts: {
          keyPath: 'id',
          indexes: [
            { name: 'by_user', keyPath: 'userId' },
            { name: 'by_created', keyPath: 'createdAt' }
          ]
        }
      },
      storeIndexes: {
        users: [
          { name: 'by_handle', keyPath: 'handle', unique: true }
        ]
      }
    },
    3: {
      stores: {
        comments: {
          keyPath: 'id',
          indexes: [
            { name: 'by_post', keyPath: 'postId' },
            { name: 'by_user', keyPath: 'userId' },
            { name: 'by_created', keyPath: 'createdAt' }
          ]
        }
      }
    },
    4: {
      stores: {
        attachments: {
          keyPath: 'id',
          indexes: [
            { name: 'by_post', keyPath: 'postId' },
            { name: 'by_kind', keyPath: 'kind' },
            { name: 'by_created', keyPath: 'createdAt' }
          ]
        }
      }
    },
    5: {
      stores: {
        auditLogs: {
          keyPath: 'id',
          indexes: [
            { name: 'by_entity', keyPath: 'entity' },
            { name: 'by_entity_ref', keyPath: ['entity', 'entityId'] },
            { name: 'by_created', keyPath: 'createdAt' }
          ]
        }
      }
    }
  };

  const FIRST_NAMES = ['安', '白', '蔡', '陈', '邓', '丁', '董', '杜', '方', '高', '顾', '郭', '韩', '何', '胡', '黄'];
  const LAST_NAMES = ['明', '华', '强', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '鑫', '宇', '晨', '宁', '安'];

  function pad(number, length) {
    return String(number).padStart(length, '0');
  }

  function normalizeName(name) {
    return String(name || 'user')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '') || 'user';
  }

  function seedUsers(count) {
    const users = [];
    for (let index = 0; index < count; index += 1) {
      const id = `user_${pad(index + 1, 3)}`;
      const name = `${FIRST_NAMES[index % FIRST_NAMES.length]}${LAST_NAMES[(index * 7) % LAST_NAMES.length]}`;
      const createdAt = new Date(Date.UTC(2024, 0, 1 + (index % 28), index % 24, index % 60, 0)).toISOString();
      users.push({ id, name, createdAt });
    }
    return users;
  }

  async function migrateV2(tx, report) {
    const users = await tx.table('users').all();
    const total = users.length;
    let done = 0;

    for (const legacyUser of users) {
      const user = legacyUser;
      const normalized = normalizeName(user.name);
      const suffix = String(user.id).replace(/^user_/, '');
      const handle = user.handle || `${normalized}_${suffix}`;
      user.handle = handle;
      user.email = user.email || `${handle}@example.local`;
      user.updatedAt = user.updatedAt || user.createdAt;
      await tx.table('users').put(user);

      const postId = `post_${user.id}_intro`;
      const existingPost = await tx.table('posts').get(postId);
      if (!existingPost) {
        await tx.table('posts').put({
          id: postId,
          userId: user.id,
          title: `${user.name}的介绍`,
          body: '这是从 v1 用户资料自动生成的介绍帖，用于验证跨表数据迁移。',
          createdAt: user.createdAt
        });
      }

      done += 1;
      report(done, total, `v2：补全用户资料 ${done}/${total}`);
    }
  }

  async function migrateV3(tx, report) {
    const posts = await tx.table('posts').all();
    const total = posts.length;
    let done = 0;

    for (const legacyPost of posts) {
      const post = legacyPost;
      const source = String(post.body || post.title || '');
      post.excerpt = source.slice(0, 28) + (source.length > 28 ? '…' : '');
      await tx.table('posts').put(post);

      const commentId = `comment_${post.id}_welcome`;
      const existingComment = await tx.table('comments').get(commentId);
      if (!existingComment) {
        await tx.table('comments').put({
          id: commentId,
          postId: post.id,
          userId: post.userId,
          text: '欢迎来到升级后的讨论区。',
          createdAt: post.createdAt
        });
      }

      done += 1;
      report(done, total, `v3：转换帖子 ${done}/${total}`);
    }
  }

  async function migrateV4(tx, report) {
    const comments = await tx.table('comments').all();
    const posts = await tx.table('posts').all();
    const total = comments.length + posts.length;
    let done = 0;

    for (const legacyComment of comments) {
      const comment = legacyComment;
      comment.snippet = String(comment.text || '').slice(0, 20);
      await tx.table('comments').put(comment);
      done += 1;
      report(done, total, `v4：转换评论 ${done}/${total}`);
    }

    for (const post of posts) {
      const attachmentId = `attachment_${post.id}_cover`;
      const existing = await tx.table('attachments').get(attachmentId);
      if (!existing) {
        const size = 1024 + ((post.id.length * 137) % 4096);
        await tx.table('attachments').put({
          id: attachmentId,
          postId: post.id,
          kind: 'image',
          size,
          createdAt: post.createdAt
        });
      }
      done += 1;
      report(done, total, `v4：生成附件记录 ${done}/${total}`);
    }
  }

  async function migrateV5(tx, report) {
    const attachments = await tx.table('attachments').all();
    const total = attachments.length * 2;
    let done = 0;

    for (const legacyAttachment of attachments) {
      const attachment = legacyAttachment;
      const size = Number.isFinite(attachment.size) ? attachment.size : 0;
      attachment.sizeLabel = size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
      await tx.table('attachments').put(attachment);
      done += 1;
      report(done, total, `v5：转换附件 ${done}/${total}`);

      const logId = `audit_${attachment.id}`;
      const existingLog = await tx.table('auditLogs').get(logId);
      if (!existingLog) {
        await tx.table('auditLogs').put({
          id: logId,
          entity: 'attachment',
          entityId: attachment.id,
          action: 'schema-upgraded',
          createdAt: attachment.createdAt
        });
      }
      done += 1;
      report(done, total, `v5：写入审计记录 ${done}/${total}`);
    }
  }

  const TRANSFORMS = {
    2: migrateV2,
    3: migrateV3,
    4: migrateV4,
    5: migrateV5
  };

  global.MigrationSchema = {
    DB_NAME,
    TARGET_VERSION,
    SEED_USER_COUNT,
    SCHEMA,
    seedUsers,
    TRANSFORMS
  };
})(typeof self !== 'undefined' ? self : globalThis);
