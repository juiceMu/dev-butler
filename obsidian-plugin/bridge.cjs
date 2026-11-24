const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const PLUGIN_ID = 'x-assistant-bridge';
const MAX_CONTENT = 100000;
const MAX_REQUEST_BYTES = MAX_CONTENT * 6 + 8192;
const MAX_ATTEMPTS = 10000;
const MAX_REPLAY_IDS = 100000;
const BLOOM_BYTES = 512 * 1024;
const MAX_PENDING = 8;
const BODY_IDLE_TIMEOUT_MS = 5000;
const HEADER_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const ACTIVE_LOCKS = globalThis[Symbol.for('x-assistant-bridge.active-locks')] || (globalThis[Symbol.for('x-assistant-bridge.active-locks')] = new Set());
const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const validAttemptId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function bloomPositions(attemptId) {
  const digest = crypto.createHash('sha512').update(attemptId, 'utf8').digest();
  const bitCount = BLOOM_BYTES * 8;
  const positions = [];
  for (let index = 0; index < 7; index++) positions.push(digest.readUInt32BE(index * 4) % bitCount);
  return positions;
}

function bloomHas(bits, attemptId) {
  return bloomPositions(attemptId).every((position) => (bits[position >> 3] & (1 << (position & 7))) !== 0);
}

function bloomAdd(bits, attemptId) {
  for (const position of bloomPositions(attemptId)) bits[position >> 3] |= 1 << (position & 7);
}

function decodeBloom(filter) {
  if (!filter.bits && filter.count === 0) return Buffer.alloc(BLOOM_BYTES);
  return Buffer.from(filter.bits || '', 'base64');
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function createBridge({ app, TFile, token, configDir = '.obsidian', pluginId = PLUGIN_ID, readAttempts, writeAttempt, readReplayFilter, compactAttempts }) {
  if (!app?.vault || typeof app.vault.process !== 'function' || typeof TFile !== 'function' ||
      typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
      typeof configDir !== 'string' || !configDir || path.posix.isAbsolute(configDir) ||
      configDir.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof pluginId !== 'string' || !/^[a-z0-9-]{1,100}$/.test(pluginId) ||
      typeof readAttempts !== 'function' || typeof writeAttempt !== 'function' || typeof readReplayFilter !== 'function' || typeof compactAttempts !== 'function') throw new Error('Obsidian 桥接配置无效');

  const vaultRoot = path.resolve(app.vault.adapter.getBasePath());
  const vaultId = hash(vaultRoot);
  const pluginPath = `${configDir}/plugins/${pluginId}`;
  const locksPath = path.join(vaultRoot, ...configDir.split('/'), 'plugins', pluginId, 'locks');
  let server;
  let accepting = false;
  let pending = 0;
  let inFlight = 0;
  let maintenance = false;
  let maintenanceWaiters = [];
  let drainWaiters = [];

  function send(response, statusCode, body) {
    if (response.bridgeDeferred) { response.bridgeResult = { statusCode, body }; return; }
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
    response.end(JSON.stringify(body));
  }

  function authorized(request) {
    const remote = request.socket.remoteAddress;
    const loopback = remote === '127.0.0.1' || remote === '::ffff:127.0.0.1' || remote === '::1';
    const expectedHost = `127.0.0.1:${server.address().port}`;
    const supplied = Buffer.from(String(request.headers.authorization || '').replace(/^Bearer /, ''));
    const expected = Buffer.from(token);
    return loopback && request.headers.host === expectedHost && !request.headers.origin &&
      /^Bearer [a-f0-9]{64}$/.test(request.headers.authorization || '') && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  function parsePath(notePath) {
    return typeof notePath === 'string' && notePath.length > 0 && notePath.length <= 4096 &&
      notePath.toLowerCase().endsWith('.md') && !notePath.startsWith('/') && !notePath.includes('\\') && !notePath.includes('\0') &&
      notePath.split('/').every((part) => part && part !== '.' && part !== '..');
  }

  async function acquireLock(lockName, payload) {
    await ensureLockDirectory(true);
    const lockPath = path.join(locksPath, `${hash(lockName)}.lock`);
    let handle;
    try {
      handle = await fs.promises.open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ ...payload, pid: process.pid, createdAt: Date.now() }), 'utf8');
      await handle.close();
      ACTIVE_LOCKS.add(lockPath);
      return { lockPath };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code === 'EEXIST') return null;
      throw error;
    }
  }

  async function releaseLock(lockPath) {
    if (!lockPath) return;
    await ensureLockDirectory(false);
    await fs.promises.unlink(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    ACTIVE_LOCKS.delete(lockPath);
  }

  async function acquireTransaction() {
    await ensureLockDirectory(true);
    const transactionPath = path.join(locksPath, 'vault-transaction.lock');
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      let handle;
      try {
        handle = await fs.promises.open(transactionPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, vaultId }), 'utf8');
        await handle.close();
        ACTIVE_LOCKS.add(transactionPath);
        return async () => releaseLock(transactionPath);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.promises.lstat(transactionPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) throw new Error('事务锁无效');
        const owner = await fs.promises.readFile(transactionPath, 'utf8').then((value) => JSON.parse(value)).catch(() => null);
        if (owner?.vaultId === vaultId && !processIsAlive(owner.pid)) {
          const recoveryPath = path.join(locksPath, 'transaction-recovery.lock');
          const recovery = await fs.promises.open(recoveryPath, 'wx', 0o600).catch(() => null);
          if (recovery) {
            try {
              const latest = await fs.promises.readFile(transactionPath, 'utf8').then((value) => JSON.parse(value)).catch(() => null);
              if (latest?.vaultId === vaultId && !processIsAlive(latest.pid)) await releaseLock(transactionPath);
            } finally {
              await recovery.close();
              await fs.promises.unlink(recoveryPath);
            }
          }
          continue;
        }
        return null;
      }
    }
    return null;
  }

  async function ensureLockDirectory(create) {
    let current = vaultRoot;
    for (const part of path.relative(vaultRoot, locksPath).split(path.sep)) {
      current = path.join(current, part);
      try {
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid lock directory');
      } catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error;
        await fs.promises.mkdir(current, { mode: 0o700 }).catch((mkdirError) => {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        });
        const created = await fs.promises.lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('invalid lock directory');
      }
    }
  }

  function waitUntilIdle() {
    if (!pending && !inFlight) return Promise.resolve();
    return new Promise((resolve) => drainWaiters.push(resolve));
  }

  async function recoverLocks() {
    await ensureLockDirectory(true);
    const records = await readAttempts();
    const byAttempt = new Map(records.map((item) => [item.attemptId, item]));
    const entries = await fs.promises.readdir(locksPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.lock$/.test(entry.name)) continue;
      const lockPath = path.join(locksPath, entry.name);
      const stat = await fs.promises.lstat(lockPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('锁目录包含无效文件');
      let payload;
      try { payload = JSON.parse(await fs.promises.readFile(lockPath, 'utf8')); } catch { throw new Error('锁文件格式无效'); }
      if (payload.vaultId !== vaultId || !validAttemptId(payload.attemptId) || !['attempt', 'target'].includes(payload.kind)) throw new Error('锁文件绑定无效');
      const lockKey = payload.kind === 'attempt' ? `attempt\0${vaultId}\0${payload.attemptId}` : `target\0${vaultId}\0${payload.notePath}`;
      if (entry.name !== `${hash(lockKey)}.lock` || (payload.kind === 'target' && !parsePath(payload.notePath))) throw new Error('锁文件名称绑定无效');
      const record = byAttempt.get(payload.attemptId);
      if (record && record.vaultId === vaultId && (payload.kind !== 'target' || record.notePath === payload.notePath) && ['completed', 'target_mismatch', 'resolved_unknown'].includes(record.status)) {
        await releaseLock(lockPath);
        continue;
      }
      if (!record && !ACTIVE_LOCKS.has(lockPath) && !processIsAlive(payload.pid)) {
        await releaseLock(lockPath);
      }
    }
  }

  async function handleUpdate(request, response, rawBody, releaseSlot) {
    response.bridgeDeferred = true;
    let releaseTransaction;
    try {
      let input;
      try { input = JSON.parse(rawBody); } catch { return send(response, 400, { status: 'invalid' }); }
      const { attemptId, vaultId: requestVaultId, notePath, expectedDigest, content, confirmed } = input || {};
      const expectedKeys = ['attemptId', 'confirmed', 'content', 'expectedDigest', 'notePath', 'vaultId'];
      if (!input || Array.isArray(input) || Object.keys(input).sort().join(',') !== expectedKeys.join(',') ||
          !validAttemptId(attemptId) || requestVaultId !== vaultId || !parsePath(notePath) ||
          typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest) ||
          typeof content !== 'string' || !content.trim() || content.length > MAX_CONTENT || confirmed !== true) {
        return send(response, 400, { status: 'invalid', ...(validAttemptId(attemptId) ? { attemptId } : {}) });
      }
      const requestDigest = hash(JSON.stringify({ vaultId, notePath, expectedDigest, contentDigest: hash(content), confirmed }));
      releaseTransaction = await acquireTransaction();
      if (!releaseTransaction) return send(response, 503, { status: 'busy', attemptId });
      const records = await readAttempts();
      const previous = records.find((item) => item.attemptId === attemptId);
      if (previous) {
        if (previous.vaultId !== vaultId || previous.notePath !== notePath || previous.expectedDigest !== expectedDigest ||
            previous.contentDigest !== hash(content) || (previous.requestDigest && previous.requestDigest !== requestDigest)) {
          return send(response, 409, { status: 'conflict', attemptId });
        }
        const status = previous.status === 'submitting' ? 'unknown' : previous.status;
        return send(response, 200, { status, attemptId });
      }
      const replayFilter = await readReplayFilter();
      const filterBits = decodeBloom(replayFilter);
      if (filterBits.length !== BLOOM_BYTES || bloomHas(filterBits, attemptId)) return send(response, 409, { status: 'conflict', attemptId });
      if (!Number.isSafeInteger(replayFilter.count) || replayFilter.count < 0 || replayFilter.count >= MAX_REPLAY_IDS) return send(response, 507, { status: 'limit_reached', attemptId });
      if (records.length >= MAX_ATTEMPTS) return send(response, 507, { status: 'limit_reached', attemptId });
      const attemptLockPath = path.join(locksPath, `${hash(`attempt\0${vaultId}\0${attemptId}`)}.lock`);
      const attemptLock = await acquireLock(`attempt\0${vaultId}\0${attemptId}`, { vaultId, attemptId, kind: 'attempt' }).catch(() => null);
      if (!attemptLock) return send(response, 503, { status: 'busy', attemptId });
      const targetLock = await acquireLock(`target\0${vaultId}\0${notePath}`, { vaultId, notePath, attemptId, kind: 'target' }).catch(() => null);
      if (!targetLock) {
        await releaseLock(attemptLock.lockPath).catch(() => {});
        return send(response, 503, { status: 'busy', attemptId });
      }
      const record = { attemptId, vaultId, notePath, expectedDigest, contentDigest: hash(content), requestDigest, status: 'submitting', updatedAt: Date.now() };
      try { await writeAttempt(attemptId, record); } catch {
        await releaseLock(targetLock.lockPath).catch(() => {});
        await releaseLock(attemptLock.lockPath).catch(() => {});
        return send(response, 503, { status: 'unavailable', attemptId });
      }

      inFlight++;
      let outcome = 'unknown';
      try {
        const file = app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof TFile)) outcome = 'target_mismatch';
        else {
          let mismatch = false;
          await app.vault.process(file, (current) => {
            if (hash(current) !== expectedDigest) { mismatch = true; return current; }
            return content;
          });
          outcome = mismatch ? 'target_mismatch' : 'completed';
        }
      } catch {
        outcome = 'unknown';
      }
      record.status = outcome;
      record.updatedAt = Date.now();
      try { await writeAttempt(attemptId, record); } catch { outcome = 'unknown'; }
      if (outcome !== 'unknown') {
        await releaseLock(targetLock.lockPath).catch(() => { outcome = 'unknown'; });
        await releaseLock(attemptLock.lockPath).catch(() => { outcome = 'unknown'; });
        if (outcome === 'unknown') {
          record.status = 'unknown';
          await writeAttempt(attemptId, record).catch(() => {});
        }
      } else {
        ACTIVE_LOCKS.delete(targetLock.lockPath);
        ACTIVE_LOCKS.delete(attemptLock.lockPath);
      }
      inFlight--;
      return send(response, 200, { status: outcome, attemptId });
    } catch {
      return send(response, 503, { status: 'unavailable' });
    } finally {
      try { if (releaseTransaction) await releaseTransaction(); }
      finally {
        releaseSlot();
        response.bridgeDeferred = false;
        if (response.bridgeResult) send(response, response.bridgeResult.statusCode, response.bridgeResult.body);
      }
    }
  }

  async function handle(request, response) {
    if (!authorized(request)) return send(response, 403, { status: 'unavailable' });
    if (request.method !== 'POST' || !['/v1/update-note', '/v1/inspect-attempt'].includes(request.url) || request.headers['content-type'] !== 'application/json') return send(response, 404, { status: 'invalid' });
    if (!accepting || maintenance) return send(response, 503, { status: 'unavailable' });
    if (pending >= MAX_PENDING) return send(response, 503, { status: 'busy' });
    pending++;
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      pending--;
      if (pending === 0 && inFlight === 0) drainWaiters.splice(0).forEach((resolve) => resolve());
    };
    const lengthHeader = request.headers['content-length'];
    if (lengthHeader !== undefined && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > MAX_REQUEST_BYTES)) {
      response.shouldKeepAlive = false;
      releaseSlot();
      return send(response, 413, { status: 'invalid' });
    }
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (statusCode, payload) => {
      if (settled) return;
      settled = true;
      send(response, statusCode, payload);
      request.resume();
      releaseSlot();
    };
    request.setTimeout(BODY_IDLE_TIMEOUT_MS, () => finish(408, { status: 'unavailable' }));
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) return finish(413, { status: 'invalid' });
      if (!settled) chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) {
        settled = true;
        let body;
        try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { send(response, 400, { status: 'invalid' }); releaseSlot(); return; }
        if (request.url === '/v1/inspect-attempt') void handleInspect(response, body, releaseSlot);
        else void handleUpdate(request, response, body, releaseSlot);
      }
    });
    request.on('error', () => finish(400, { status: 'invalid' }));
  }

  async function handleInspect(response, rawBody, releaseSlot) {
    response.bridgeDeferred = true;
    let releaseTransaction;
    try {
      let input;
      try { input = JSON.parse(rawBody); } catch { return send(response, 400, { status: 'invalid', drained: false }); }
      const { attemptId, vaultId: requestVaultId, notePath, expectedDigest, contentDigest } = input || {};
      if (!input || Object.keys(input).sort().join(',') !== 'attemptId,contentDigest,expectedDigest,notePath,vaultId' ||
          !validAttemptId(attemptId) || requestVaultId !== vaultId || !parsePath(notePath) ||
          typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest) ||
          typeof contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contentDigest)) return send(response, 400, { status: 'invalid', drained: false });
      releaseTransaction = await acquireTransaction();
      if (!releaseTransaction) return send(response, 503, { status: 'busy', attemptId, drained: false });
      const records = await readAttempts();
      const record = records.find((item) => item.attemptId === attemptId);
      if (!record) return send(response, 200, { status: 'not_found', attemptId, drained: false });
      if (record.vaultId !== vaultId || record.notePath !== notePath || record.expectedDigest !== expectedDigest || record.contentDigest !== contentDigest) {
        return send(response, 409, { status: 'conflict', attemptId, drained: false });
      }
      const terminal = ['completed', 'target_mismatch', 'resolved_unknown'].includes(record.status);
      return send(response, 200, { status: terminal ? record.status : 'unknown', attemptId, drained: terminal });
    } catch { return send(response, 503, { status: 'unavailable', drained: false }); }
    finally {
      try { if (releaseTransaction) await releaseTransaction(); }
      finally {
        releaseSlot();
        response.bridgeDeferred = false;
        if (response.bridgeResult) send(response, response.bridgeResult.statusCode, response.bridgeResult.body);
      }
    }
  }

  function start() {
    if (server) throw new Error('Obsidian 桥已启动');
    server = http.createServer((request, response) => { void handle(request, response); });
    server.headersTimeout = HEADER_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.keepAliveTimeout = 1000;
    server.maxHeadersCount = 32;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        void (async () => {
          const releaseTransaction = await acquireTransaction();
          if (!releaseTransaction) throw new Error('事务锁忙碌');
          try { await recoverLocks(); } finally { await releaseTransaction(); }
        })().then(() => {
          accepting = true;
          resolve({ protocol: 1, host: '127.0.0.1', port: server.address().port, token, vaultId, pluginId, pluginPath });
        }, (error) => {
          server.close(() => reject(error));
        });
      });
    });
  }

  async function close() {
    accepting = false;
    if (!server) return;
    const closed = new Promise((resolve) => server.close(resolve));
    await waitUntilIdle();
    if (maintenance) await new Promise((resolve) => maintenanceWaiters.push(resolve));
    await closed;
  }

  async function withMaintenance(callback) {
    if (!accepting || maintenance) return { status: 'busy' };
    maintenance = true;
    let releaseTransaction;
    try {
      await waitUntilIdle();
      releaseTransaction = await acquireTransaction();
      if (!releaseTransaction) return { status: 'busy' };
      return await callback();
    } finally {
      if (releaseTransaction) await releaseTransaction();
      maintenance = false;
      maintenanceWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  async function resolveUnknownAttempts({ confirmed } = {}) {
    if (confirmed !== true) return { status: 'unavailable' };
    return withMaintenance(async () => {
      const records = await readAttempts();
      const unknown = records.filter((item) => item.vaultId === vaultId && ['submitting', 'unknown'].includes(item.status));
      for (const item of unknown) {
        const targetLockPath = path.join(locksPath, `${hash(`target\0${vaultId}\0${item.notePath}`)}.lock`);
        const attemptLockPath = path.join(locksPath, `${hash(`attempt\0${vaultId}\0${item.attemptId}`)}.lock`);
        for (const candidate of [targetLockPath, attemptLockPath]) {
          const exists = await fs.promises.access(candidate).then(() => true, () => false);
          if (!exists) continue;
          if (ACTIVE_LOCKS.has(candidate)) return { status: 'busy' };
          const payload = await fs.promises.readFile(candidate, 'utf8').then((value) => JSON.parse(value)).catch(() => null);
          if (!payload || payload.vaultId !== vaultId || (payload.pid !== process.pid && processIsAlive(payload.pid))) return { status: 'busy' };
        }
        await writeAttempt(item.attemptId, { ...item, status: 'resolved_unknown', updatedAt: Date.now() });
        await releaseLock(targetLockPath).catch(() => {});
        await releaseLock(attemptLockPath).catch(() => {});
      }
      return { status: 'completed', count: unknown.length };
    });
  }

  async function resetCompletedHistory({ confirmed } = {}) {
    if (confirmed !== true) return { status: 'unavailable' };
    return withMaintenance(async () => {
      const records = await readAttempts();
      if (records.some((item) => !['completed', 'target_mismatch', 'resolved_unknown'].includes(item.status))) return { status: 'conflict' };
      const filter = await readReplayFilter();
      const bits = decodeBloom(filter);
      if (bits.length !== BLOOM_BYTES || !Number.isSafeInteger(filter.count) || filter.count + records.length > MAX_REPLAY_IDS) return { status: 'limit_reached' };
      for (const record of records) bloomAdd(bits, record.attemptId);
      await compactAttempts({ attempts: [], replayFilter: { bits: bits.toString('base64'), count: filter.count + records.length } });
      return { status: 'completed' };
    });
  }

  return { start, close, resolveUnknownAttempts, resetCompletedHistory, getState: () => ({ accepting, maintenance, pending, inFlight }) };
}

module.exports = { PLUGIN_ID, MAX_CONTENT, MAX_REQUEST_BYTES, MAX_ATTEMPTS, MAX_PENDING, MAX_REPLAY_IDS, BLOOM_BYTES, createBridge, hash };
