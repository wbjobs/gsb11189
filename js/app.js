(function () {
  'use strict';

  const els = {
    modeBadge: document.getElementById('modeBadge'),
    targetVersion: document.getElementById('targetVersion'),
    failVersion: document.getElementById('failVersion'),
    slowMode: document.getElementById('slowMode'),
    prepareBtn: document.getElementById('prepareBtn'),
    migrateBtn: document.getElementById('migrateBtn'),
    interruptBtn: document.getElementById('interruptBtn'),
    holdBtn: document.getElementById('holdBtn'),
    releaseBtn: document.getElementById('releaseBtn'),
    memoryBtn: document.getElementById('memoryBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    resetBtn: document.getElementById('resetBtn'),
    versionBadge: document.getElementById('versionBadge'),
    canvas: document.getElementById('progressCanvas'),
    progressPercent: document.getElementById('progressPercent'),
    progressLabel: document.getElementById('progressLabel'),
    progressBar: document.getElementById('progressBar'),
    statusMessage: document.getElementById('statusMessage'),
    validationBadge: document.getElementById('validationBadge'),
    countCards: document.getElementById('countCards'),
    validationList: document.getElementById('validationList'),
    logList: document.getElementById('logList')
  };

  const state = {
    worker: null,
    running: false,
    holding: false,
    progress: 0,
    version: 0,
    requestId: 0,
    pending: new Map(),
    environment: null,
    fallback: false,
    forceMemory: new URLSearchParams(location.search).get('mode') === 'memory'
  };

  function log(message, kind) {
    const item = document.createElement('li');
    const time = document.createElement('span');
    const body = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date().toLocaleTimeString();
    body.textContent = message;
    if (kind) body.dataset.kind = kind;
    item.append(time, body);
    els.logList.prepend(item);
  }

  function setStatus(message, kind) {
    els.statusMessage.textContent = message;
    els.statusMessage.className = `status ${kind || 'neutral'}`;
  }

  function setBusy(isRunning) {
    state.running = isRunning;
    els.migrateBtn.disabled = isRunning;
    els.prepareBtn.disabled = isRunning;
    els.resetBtn.disabled = isRunning;
    els.refreshBtn.disabled = isRunning;
    els.memoryBtn.disabled = isRunning;
    els.interruptBtn.disabled = !isRunning;
  }

  function updateEnvironment(environment) {
    if (!environment) return;
    state.environment = environment;
    const persistent = environment.mode === 'indexeddb';
    els.modeBadge.textContent = persistent ? '持久化 IndexedDB' : `内存模式：${environment.reason || '已降级'}`;
    els.modeBadge.className = `mode-badge ${persistent ? 'persistent' : 'memory'}`;

    if (!persistent) {
      setStatus(`隐私模式或受限环境已降级为内存数据库，页面不会崩溃，但刷新后数据不保留。原因：${environment.reason}`, 'warning');
    }
  }

  function setVersion(version) {
    if (version === null || version === undefined) return;
    state.version = Number(version);
    els.versionBadge.textContent = `当前 v${version}`;
  }

  function drawFallback(text) {
    const context = els.canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, els.canvas.width, els.canvas.height);
    context.fillStyle = '#172033';
    context.font = '700 18px sans-serif';
    context.fillText(text || 'Canvas 不可用', 40, 130);
  }

  function drawProgress(percent) {
    const canvas = els.canvas;
    const context = canvas.getContext && canvas.getContext('2d');
    if (!context) {
      drawFallback(`进度 ${Math.round(percent)}%（Canvas 2D 不可用）`);
      return;
    }

    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);

    const segmentCount = 5;
    const margin = 58;
    const gap = 14;
    const segmentWidth = (width - margin * 2 - gap * (segmentCount - 1)) / segmentCount;
    const barY = 94;
    const barHeight = 30;
    const clamped = Math.max(0, Math.min(100, percent));

    context.font = '700 15px sans-serif';
    context.textAlign = 'center';

    for (let index = 0; index < segmentCount; index += 1) {
      const x = margin + index * (segmentWidth + gap);
      const start = index * 20;
      const end = start + 20;
      context.fillStyle = '#e5eaf2';
      context.fillRect(x, barY, segmentWidth, barHeight);

      const local = Math.max(0, Math.min(20, clamped - start));
      if (local > 0) {
        const gradient = context.createLinearGradient(x, barY, x + segmentWidth, barY);
        gradient.addColorStop(0, '#60a5fa');
        gradient.addColorStop(1, '#2563eb');
        context.fillStyle = gradient;
        context.fillRect(x, barY, segmentWidth * (local / 20), barHeight);
      }

      context.fillStyle = clamped >= end ? '#1d4ed8' : '#667085';
      context.fillText(`v${index + 1}`, x + segmentWidth / 2, barY + 58);
    }

    context.textAlign = 'left';
    context.fillStyle = '#667085';
    context.font = '600 14px sans-serif';
    context.fillText('旧 v1', margin - 28, barY + 20);
    context.textAlign = 'right';
    context.fillText('v5 完成', width - margin + 30, barY + 20);

    context.textAlign = 'center';
    context.font = '800 34px sans-serif';
    context.fillStyle = '#172033';
    context.fillText(`${Math.round(clamped)}%`, width / 2, 52);
  }

  function setProgress(progress, label) {
    const percent = typeof progress === 'number' ? progress : Number(progress && progress.overallPercent) || 0;
    state.progress = percent;
    els.progressPercent.textContent = `${Math.round(percent)}%`;
    els.progressBar.style.width = `${percent}%`;
    els.progressLabel.textContent = label || '处理中…';
    drawProgress(percent);
  }

  function renderValidation(payload) {
    if (!payload) return;
    const { version, validation, state: databaseState } = payload;
    setVersion(version);

    if (databaseState && databaseState.stores) {
      const names = ['users', 'posts', 'comments', 'attachments', 'auditLogs'];
      Array.from(els.countCards.children).forEach(function (card, index) {
        const name = names[index];
        card.querySelector('strong').textContent = databaseState.stores[name] ? databaseState.stores[name].count : 0;
      });
    }

    if (!validation) {
      els.validationBadge.textContent = '未校验';
      els.validationBadge.style.color = '';
      els.validationList.replaceChildren();
      return;
    }

    els.validationBadge.textContent = validation.ok ? '通过' : `${validation.errors.length} 个问题`;
    els.validationBadge.style.color = validation.ok ? 'var(--success)' : 'var(--danger)';
    els.validationList.replaceChildren();

    const entries = [];
    validation.errors.forEach(message => entries.push(['error-item', message]));
    validation.warnings.forEach(message => entries.push(['warning-item', message]));
    if (entries.length === 0) {
      entries.push(['', `v${version} 结构、索引、跨表引用和字段转换校验通过。`]);
    }
    entries.forEach(([className, message]) => {
      const item = document.createElement('li');
      item.className = className;
      item.textContent = message;
      els.validationList.appendChild(item);
    });
  }

  function resolvePending(id, payload) {
    const pending = state.pending.get(id);
    if (pending) {
      state.pending.delete(id);
      pending.resolve(payload);
    }
  }

  function rejectPending(id, error) {
    const pending = state.pending.get(id);
    if (pending) {
      state.pending.delete(id);
      pending.reject(error);
    }
  }

  function send(message) {
    const id = ++state.requestId;
    const payload = Object.assign({ id }, message);
    const pending = new Promise((resolve, reject) => state.pending.set(id, { resolve, reject }));
    if (state.worker) {
      state.worker.postMessage(payload);
    } else {
      sendFallback(payload);
    }
    return pending;
  }

  async function sendFallback(message) {
    const id = message.id;
    const emit = (type, payload) => handleMessage(Object.assign({ type, id }, payload || {}));
    const callbacks = {
      onProgress: progress => emit('progress', { progress }),
      onBlocked: blocked => emit('blocked', { blocked })
    };

    try {
      if (!window.fallbackRunner) {
        window.fallbackRunner = await MigrationRunner.create({
          forceMemory: true,
          reason: '当前浏览器不支持 Web Worker，已在主线程使用内存模式'
        });
      }
      const runner = window.fallbackRunner;
      state.fallback = true;

      if (message.type === 'env' || message.type === 'state') {
        const dbVersion = await runner.getCurrentVersion();
        const databaseState = await runner.collectState();
        const validation = runner.validateState(databaseState, dbVersion);
        emit(message.type === 'env' ? 'env' : 'state', {
          environment: runner.describeEnvironment(),
          version: dbVersion,
          state: databaseState,
          validation
        });
        return;
      }
      if (message.type === 'prepareV1') {
        const result = await runner.prepareV1({ forceSeed: Boolean(message.forceSeed), onProgress: callbacks.onProgress });
        emit('prepared', { result, environment: runner.describeEnvironment(), version: 1 });
      } else if (message.type === 'migrate') {
        const before = await runner.getCurrentVersion();
        const finalVersion = await runner.migrate({
          targetVersion: message.targetVersion,
          failVersion: message.failVersion,
          slow: Boolean(message.slow),
          onProgress: callbacks.onProgress,
          onBlocked: callbacks.onBlocked
        });
        const databaseState = await runner.collectState();
        const validation = runner.validateState(databaseState, finalVersion);
        emit('done', { beforeVersion: before, version: finalVersion, state: databaseState, validation, environment: runner.describeEnvironment() });
      } else if (message.type === 'reset') {
        await runner.deleteDatabase();
        emit('reset', { version: 0 });
      } else if (message.type === 'hold') {
        emit('holding');
      } else if (message.type === 'release') {
        emit('released');
      }
    } catch (error) {
      emit('error', {
        error: {
          message: error.message || String(error),
          code: error.code || error.name || 'ERROR',
          currentVersion: error.currentVersion,
          requestedVersion: error.requestedVersion,
          rollbackVersion: error.rollbackVersion
        }
      });
    }
  }

  function normalizeError(error) {
    return error || { message: '未知错误', code: 'UNKNOWN' };
  }

  function handleMessage(event) {
    const message = event.data || event;
    if (message.environment) updateEnvironment(message.environment);

    if (message.type === 'progress') {
      const progress = message.progress || {};
      setProgress(progress.overallPercent || 0, progress.label || '处理中…');
      return;
    }

    if (message.type === 'blocked') {
      setStatus('数据库被旧版本连接占用。请关闭其他打开本页的标签页，或点击“释放旧连接”。本次升级在旧连接释放后会继续。', 'warning');
      log('收到 blocked：版本升级等待旧连接释放', 'warning');
      return;
    }

    if (message.type === 'env') {
      setVersion(message.version);
      renderValidation({ version: message.version, validation: null });
      resolvePending(message.id, message);
      return;
    }

    if (message.type === 'prepared') {
      setVersion(1);
      setProgress(20, 'v1 旧数据已准备完成');
      setStatus(message.result.seeded ? `已生成 ${message.result.count} 条 v1 旧格式用户数据。` : 'v1 数据库已有数据，未重复写入。', 'success');
      log(message.result.seeded ? `生成 ${message.result.count} 条 v1 旧数据` : 'v1 已有旧数据，保持原样');
      resolvePending(message.id, message);
      return;
    }

    if (message.type === 'done') {
      setBusy(false);
      setProgress(100, `迁移完成，当前 v${message.version}`);
      renderValidation(message);
      setStatus(`已迁移到 v${message.version}，事务已提交，旧数据转换和引用校验${message.validation.ok ? '通过' : '存在问题'}。`, message.validation.ok ? 'success' : 'error');
      log(`迁移完成：v${message.beforeVersion} → v${message.version}`);
      resolvePending(message.id, message);
      return;
    }

    if (message.type === 'state') {
      renderValidation(message);
      resolvePending(message.id, message);
      return;
    }

    if (message.type === 'reset' || message.type === 'released' || message.type === 'holding') {
      if (message.type === 'reset') {
        setVersion(0);
        setProgress(0, '数据库已重置');
        renderValidation({ version: 0, validation: null, state: { stores: {} } });
        setStatus('数据库已删除，可以重新生成 v1 旧数据。', 'neutral');
      }
      if (message.type === 'holding') {
        state.holding = true;
        els.holdBtn.disabled = true;
        els.releaseBtn.disabled = false;
        setStatus('已保留一个旧版本连接。现在开始迁移会触发 blocked 提示。', 'warning');
      }
      if (message.type === 'released') {
        state.holding = false;
        els.holdBtn.disabled = false;
        els.releaseBtn.disabled = true;
        setStatus('旧连接已释放，被阻塞的升级可以继续。', 'success');
      }
      resolvePending(message.id, message);
      return;
    }

    if (message.type === 'error') {
      setBusy(false);
      const error = normalizeError(message.error);
      rejectPending(message.id, error);
      setVersion(message.version);
      if (error.code === 'DOWNGRADE_NOT_SUPPORTED') {
        setStatus(`版本回退被阻止：IndexedDB 只能向更高版本打开。当前数据仍保留在 v${error.currentVersion}，请求目标 v${error.targetVersion}。请选择 v${error.currentVersion} 或更高版本。`, 'warning');
      } else if (error.code === 'INJECTED_FAILURE' || error.code === 'MIGRATION_FAILED' || error.name === 'AbortError') {
        setStatus(`迁移失败，版本升级事务已回滚。数据库保持在 v${message.version || error.rollbackVersion || 0}，未提交半成品结构或数据。`, 'error');
      } else if (error.code === 'BLOCKED') {
        setStatus('数据库被占用：请关闭其他标签页或点击“释放旧连接”后重试。', 'warning');
      } else {
        setStatus(error.message, 'error');
      }
      log(`错误：${error.message}`, 'error');
    }
  }

  function createWorker() {
    if (state.forceMemory || typeof Worker !== 'function') {
      state.fallback = true;
      return null;
    }

    try {
      const worker = new Worker('js/worker.js');
      worker.onmessage = handleMessage;
      worker.onerror = function (error) {
        state.worker = null;
        if (state.running) {
          setBusy(false);
          setStatus('迁移 Worker 已中断。IndexedDB 正在执行的版本事务不会提交半成品；重新开始会从数据库当前版本续迁。', 'warning');
          log('Worker 中断，稍后可从已提交版本继续', 'warning');
        } else {
          setStatus(`Worker 加载失败：${error.message}。将使用主线程内存模式。`, 'warning');
          state.fallback = true;
        }
        state.pending.forEach(pending => pending.reject(new Error('Worker 已中断')));
        state.pending.clear();
      };
      return worker;
    } catch (error) {
      state.fallback = true;
      return null;
    }
  }

  async function requestEnvironment() {
    if (!state.worker) state.worker = createWorker();
    await send({ type: 'env', options: { forceMemory: state.forceMemory } });
    if (state.fallback && state.forceMemory) {
      setStatus('已手动启用隐私模式降级：迁移逻辑在内存数据库中运行，刷新后数据清空，但所有异常路径仍可演示。', 'warning');
    }
  }

  async function prepareV1() {
    setBusy(true);
    setStatus('正在重置并生成 v1 旧格式数据…', 'neutral');
    try {
      await send({ type: 'reset', options: { forceMemory: state.forceMemory } });
      await send({ type: 'prepareV1', forceSeed: true, options: { forceMemory: state.forceMemory } });
      await send({ type: 'state', options: { forceMemory: state.forceMemory } });
    } catch (error) {
      setStatus(`准备失败：${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function migrate() {
    const target = Number(els.targetVersion.value);
    if (target < state.version) {
      setStatus(`版本回退有风险，IndexedDB 不支持直接降级：当前 v${state.version}，目标 v${target}。数据未改动。`, 'warning');
      log('拒绝版本回退请求', 'warning');
      return;
    }

    setBusy(true);
    setStatus(`开始迁移到 v${target}…`, 'neutral');
    log(`请求迁移：当前 v${state.version} → v${target}`);
    try {
      await send({
        type: 'migrate',
        targetVersion: target,
        failVersion: Number(els.failVersion.value),
        slow: els.slowMode.checked,
        options: { forceMemory: state.forceMemory }
      });
    } catch (error) {
      if (state.running) setBusy(false);
      if (error.message !== 'Worker 已中断') setStatus(error.message, 'error');
    }
  }

  function interrupt() {
    if (!state.worker) {
      setStatus('当前使用主线程内存模式，无法终止线程；可通过失败注入观察回滚。', 'warning');
      return;
    }
    const worker = state.worker;
    state.worker = null;
    worker.terminate();
    setBusy(false);
    state.pending.forEach(pending => pending.reject(new Error('Worker 已中断')));
    state.pending.clear();
    setProgress(state.progress, 'Worker 已中断，点击“开始迁移”可从已提交版本续迁');
    setStatus('已中断迁移执行器。未提交的版本事务会回滚；已提交版本下次继续。', 'warning');
    log('用户中断 Worker', 'warning');

    setTimeout(async function () {
      state.worker = createWorker();
      try {
        await send({ type: 'state', options: { forceMemory: state.forceMemory } });
        setStatus(`检测到数据库当前为 v${state.version}。选择不低于当前的版本即可继续迁移。`, 'success');
      } catch (error) {
        setStatus(`中断后重新检测失败：${error.message}`, 'error');
      }
    }, 120);
  }

  async function resetDatabase() {
    if (!window.confirm('将删除整个演示数据库。确定要重置吗？')) return;
    setBusy(true);
    try {
      await send({ type: 'reset', options: { forceMemory: state.forceMemory } });
      log('数据库已重置');
    } catch (error) {
      setStatus(`重置失败：${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function refreshState() {
    try {
      await send({ type: 'state', options: { forceMemory: state.forceMemory } });
      setStatus('已重新读取数据库现状。', 'success');
    } catch (error) {
      setStatus(`读取失败：${error.message}`, 'error');
    }
  }

  async function holdConnection() {
    try {
      await send({ type: 'hold', options: { forceMemory: state.forceMemory } });
      log('已打开并保留旧版本连接');
    } catch (error) {
      setStatus(`占用模拟失败：${error.message}`, 'error');
    }
  }

  async function releaseConnection() {
    try {
      await send({ type: 'release', options: { forceMemory: state.forceMemory } });
      log('旧版本连接已释放');
    } catch (error) {
      setStatus(`释放失败：${error.message}`, 'error');
    }
  }

  function switchToMemoryMode() {
    const url = new URL(location.href);
    url.searchParams.set('mode', 'memory');
    location.href = url.toString();
  }

  els.prepareBtn.addEventListener('click', prepareV1);
  els.migrateBtn.addEventListener('click', migrate);
  els.interruptBtn.addEventListener('click', interrupt);
  els.resetBtn.addEventListener('click', resetDatabase);
  els.refreshBtn.addEventListener('click', refreshState);
  els.holdBtn.addEventListener('click', holdConnection);
  els.releaseBtn.addEventListener('click', releaseConnection);
  els.memoryBtn.addEventListener('click', switchToMemoryMode);

  els.targetVersion.addEventListener('change', function () {
    const target = Number(els.targetVersion.value);
    if (state.version && target < state.version) {
      setStatus(`目标 v${target} 低于当前 v${state.version}。开始时会阻止版本回退并提示。`, 'warning');
    }
  });

  if (!('indexedDB' in window)) state.forceMemory = true;
  drawProgress(0);

  requestEnvironment()
    .then(refreshState)
    .catch(function (error) {
      setStatus(`环境检测失败：${error.message}。可尝试内存模式。`, 'error');
    });
})();
