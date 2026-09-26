importScripts('migrations.js', 'memory-backend.js', 'idb-backend.js', 'migration-core.js');

let runner = null;
let currentMigration = 0;

function post(type, payload) {
  self.postMessage(Object.assign({ type }, payload || {}));
}

async function ensureRunner(options) {
  if (!runner) {
    runner = await MigrationRunner.create(options || {});
  }
  return runner;
}

self.onmessage = async function (event) {
  const message = event.data || {};
  const id = message.id;

  function reply(type, payload) {
    post(type, Object.assign({ id }, payload || {}));
  }

  try {
    if (message.type === 'env') {
      const activeRunner = await ensureRunner(message.options || {});
      reply('env', { environment: activeRunner.describeEnvironment(), version: await activeRunner.getCurrentVersion() });
      return;
    }

    if (message.type === 'prepareV1') {
      const activeRunner = await ensureRunner(message.options || {});
      const result = await activeRunner.prepareV1({
        forceSeed: Boolean(message.forceSeed),
        onProgress: progress => reply('progress', { progress })
      });
      reply('prepared', { result, environment: activeRunner.describeEnvironment(), version: 1 });
      return;
    }

    if (message.type === 'migrate') {
      currentMigration += 1;
      const migrationId = currentMigration;
      const activeRunner = await ensureRunner(message.options || {});
      const before = await activeRunner.getCurrentVersion();
      const finalVersion = await activeRunner.migrate({
        targetVersion: message.targetVersion,
        failVersion: message.failVersion || 0,
        slow: message.slow !== false,
        onProgress: progress => {
          if (migrationId === currentMigration) {
            reply('progress', { progress });
          }
        },
        onBlocked: blocked => reply('blocked', { blocked })
      });
      const state = await activeRunner.collectState();
      const validation = activeRunner.validateState(state, finalVersion);
      reply('done', { beforeVersion: before, version: finalVersion, state, validation, environment: activeRunner.describeEnvironment() });
      return;
    }

    if (message.type === 'state') {
      const activeRunner = await ensureRunner(message.options || {});
      const version = await activeRunner.getCurrentVersion();
      const state = await activeRunner.collectState();
      const validation = activeRunner.validateState(state, version);
      reply('state', { version, state, validation, environment: activeRunner.describeEnvironment() });
      return;
    }

    if (message.type === 'reset') {
      const activeRunner = await ensureRunner(message.options || {});
      await activeRunner.releaseConnection();
      await activeRunner.deleteDatabase();
      reply('reset', { version: 0 });
      return;
    }

    if (message.type === 'hold') {
      const activeRunner = await ensureRunner(message.options || {});
      await activeRunner.holdConnection();
      reply('holding');
      return;
    }

    if (message.type === 'release') {
      const activeRunner = await ensureRunner(message.options || {});
      await activeRunner.releaseConnection();
      reply('released');
      return;
    }

    reply('error', { error: { message: `未知 Worker 消息：${message.type}`, code: 'UNKNOWN_MESSAGE' } });
  } catch (error) {
    let version = null;
    let environment = null;
    try {
      if (runner) {
        version = await runner.getCurrentVersion();
        environment = runner.describeEnvironment();
      }
    } catch (stateError) {
      version = null;
    }
    reply('error', {
      error: {
        name: error.name || 'MigrationError',
        message: error.message || String(error),
        code: error.code || error.name || 'MIGRATION_ERROR',
        currentVersion: error.currentVersion,
        requestedVersion: error.requestedVersion,
        rollbackVersion: error.rollbackVersion
      },
      version,
      environment
    });
  }
};
