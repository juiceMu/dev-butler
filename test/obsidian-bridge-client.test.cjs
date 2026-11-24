const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createBridge, hash, MAX_PENDING } = require('../obsidian-plugin/bridge.cjs');
const { createObsidianBridgeClient } = require('../src/obsidian-bridge-client.cjs');

class TFile { constructor(filePath) { this.path = filePath; } }

async function fixture(t, { saved = [], processOverride, compactOverride, initialize } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-bridge-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pluginDirectory = path.join(directory, '.obsidian', 'plugins', 'x-assistant-bridge');
  fs.mkdirSync(pluginDirectory, { recursive: true });
  if (initialize) await initialize(directory, pluginDirectory);
  const files = new Map([['notes/topic.md', '# 原文\n']]);
  const records = saved.map((record) => ({ ...record, vaultId: record.vaultId === '__CURRENT__' ? hash(directory) : record.vaultId }));
  let replayFilter = { bits: '', count: 0 };
  let processCalls = 0;
  const app = { vault: {
    adapter: { getBasePath: () => directory },
    getAbstractFileByPath: (name) => files.has(name) ? new TFile(name) : null,
    process: async (file, transform) => {
      processCalls++;
      const operation = processOverride || (async () => {
        const updated = transform(files.get(file.path));
        files.set(file.path, updated);
        return updated;
      });
      return operation(file, transform, files);
    },
  } };
  const token = 'b'.repeat(64);
  const bridge = createBridge({
    app,
    TFile,
    token,
    readAttempts: async () => records.map((record) => ({ ...record })),
    writeAttempt: async (attemptId, record) => {
      const index = records.findIndex((item) => item.attemptId === attemptId);
      if (index < 0) records.push({ ...record }); else records[index] = { ...record };
    },
    readReplayFilter: async () => ({ ...replayFilter }),
    compactAttempts: async ({ attempts, replayFilter: nextFilter }) => {
      if (compactOverride) return compactOverride({ attempts, replayFilter: nextFilter, records, setReplayFilter: (value) => { replayFilter = value; } });
      records.splice(0, records.length, ...attempts.map((item) => ({ ...item })));
      replayFilter = { ...nextFilter };
    },
  });
  const endpoint = await bridge.start();
  fs.writeFileSync(path.join(pluginDirectory, 'bridge.json'), JSON.stringify(endpoint));
  const client = createObsidianBridgeClient({ vaultRoot: directory, vaultId: hash(directory) });
  t.after(() => bridge.close());
  return { directory, endpoint, bridge, client, app, files, records, getProcessCalls: () => processCalls };
}

function request(input = {}) {
  return {
    attemptId: 'attempt-1',
    notePath: 'notes/topic.md',
    expectedDigest: hash('# 原文\n'),
    content: '# 更新后\n',
    confirmed: true,
    ...input,
  };
}

test('经确认后通过 Obsidian process 更新，重放相同 attempt 不重复写入且不保存正文', async (t) => {
  const h = await fixture(t);
  assert.deepEqual(await h.client.update(request()), { status: 'completed' });
  assert.equal(h.files.get('notes/topic.md'), '# 更新后\n');
  assert.equal(h.getProcessCalls(), 1);
  assert.equal(JSON.stringify(h.records).includes('# 更新后'), false);
  assert.deepEqual(await h.client.update(request()), { status: 'completed' });
  assert.equal(h.getProcessCalls(), 1);
  assert.deepEqual(await h.client.update(request({ content: '# 其他内容\n' })), { status: 'conflict' });
  assert.equal(h.getProcessCalls(), 1);
});

test('正文摘要过期、目标无效或未确认时不覆盖', async (t) => {
  const h = await fixture(t);
  assert.deepEqual(await h.client.update(request({ expectedDigest: hash('另一个版本') })), { status: 'target_mismatch' });
  assert.equal(h.files.get('notes/topic.md'), '# 原文\n');
  assert.equal(h.getProcessCalls(), 1);
  await assert.rejects(h.client.update(request({ confirmed: false })), /确认/);
  await assert.rejects(h.client.update(request({ notePath: '../topic.md' })), /无效/);
  assert.equal(h.getProcessCalls(), 1);
});

test('启动后遗留的 submitting 请求按 unknown 返回，绝不自动重放', async (t) => {
  const pending = {
    attemptId: 'attempt-1', vaultId: '__CURRENT__', notePath: 'notes/topic.md',
    expectedDigest: hash('# 原文\n'), contentDigest: hash('# 更新后\n'), status: 'submitting',
  };
  const h = await fixture(t, { saved: [pending] });
  assert.deepEqual(await h.client.update(request()), { status: 'unknown' });
  assert.equal(h.getProcessCalls(), 0);
  assert.equal(h.files.get('notes/topic.md'), '# 原文\n');
});

test('缺少插件端点时明确返回 unavailable，不退回本地文件写入', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-bridge-offline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const client = createObsidianBridgeClient({ vaultRoot: directory, vaultId: hash(directory) });
  assert.deepEqual(await client.update(request()), { status: 'unavailable' });
});

test('拒绝错误 Host、任意 Origin 和错误令牌，且不写入', async (t) => {
  const h = await fixture(t);
  const send = (headers) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ ...request(), vaultId: hash(h.directory) });
    const req = http.request({ host: '127.0.0.1', port: h.endpoint.port, method: 'POST', path: '/v1/update-note',
      headers: { host: `127.0.0.1:${h.endpoint.port}`, authorization: `Bearer ${h.endpoint.token}`, 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
  assert.equal(await send({ host: `evil.test:${h.endpoint.port}` }), 403);
  assert.equal(await send({ origin: 'https://evil.test' }), 403);
  assert.equal(await send({ authorization: `Bearer ${'c'.repeat(64)}` }), 403);
  assert.equal(h.getProcessCalls(), 0);
});

test('请求超时为 unknown，即使插件稍后完成也不触发第二次写入', async (t) => {
  const h = await fixture(t, { processOverride: async (file, transform, files) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const updated = transform(files.get(file.path));
    files.set(file.path, updated);
    return updated;
  } });
  const shortClient = createObsidianBridgeClient({ vaultRoot: h.directory, vaultId: hash(h.directory), timeoutMs: 100 });
  assert.deepEqual(await shortClient.update(request()), { status: 'unknown' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(h.files.get('notes/topic.md'), '# 更新后\n');
  assert.equal(h.getProcessCalls(), 1);
});

test('Obsidian 桌面插件入口生成随机 token 和本知识库握手文件', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-plugin-entry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  class BasePlugin {
    constructor(app) { this.app = app; this.data = {}; this.status = ''; }
    async loadData() { return this.data; }
    async saveData(value) { this.data = structuredClone(value); }
    addStatusBarItem() { return { setText: (value) => { this.status = value; } }; }
    addCommand(command) { (this.commands ||= []).push(command); }
  }
  const dataDirectory = path.join(directory, '.obsidian', 'plugins', 'x-assistant-bridge');
  const adapter = {
    getBasePath: () => directory,
    mkdir: async (relative) => fs.mkdirSync(path.join(directory, ...relative.split('/')), { recursive: true }),
    write: async (relative, contents) => fs.writeFileSync(path.join(directory, ...relative.split('/')), contents),
    remove: async (relative) => fs.rmSync(path.join(directory, ...relative.split('/')), { force: true }),
  };
  const app = { vault: { adapter, configDir: '.obsidian', getAbstractFileByPath: () => null, process: async () => { throw new Error('不应写入'); } } };
  const moduleObject = { exports: {} };
  const pluginMain = path.join(__dirname, '..', 'obsidian-plugin', 'main.js');
  const localRequire = (name) => name === 'obsidian' ? { Plugin: BasePlugin, TFile, Notice: class { constructor(message) { this.message = message; } } } : require(name.startsWith('.') ? path.resolve(path.dirname(pluginMain), name) : name);
  vm.runInNewContext(fs.readFileSync(pluginMain, 'utf8'), { module: moduleObject, exports: moduleObject.exports, require: localRequire, Buffer, setTimeout, clearTimeout });
  const Plugin = moduleObject.exports;
  const plugin = new Plugin(app);
  await plugin.onload();
  t.after(() => plugin.bridge.close());
  assert.equal(plugin.status, '开发管家桥已连接');
  const endpoint = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'bridge.json'), 'utf8'));
  assert.match(endpoint.token, /^[a-f0-9]{64}$/);
  assert.equal(endpoint.vaultId, hash(directory));
  assert.equal(endpoint.host, '127.0.0.1');
  assert.equal(endpoint.pluginId, 'x-assistant-bridge');
});

test('超限序列化正文由客户端稳定拒绝且不创建请求', async (t) => {
  const h = await fixture(t);
  const tooLargePath = '\u0001'.repeat(4090) + '.md';
  assert.deepEqual(await h.client.update(request({ notePath: tooLargePath, content: '\u0001'.repeat(100000) })), { status: 'invalid' });
  assert.equal(h.getProcessCalls(), 0);
});

test('服务端对超限请求返回稳定 413，不执行 vault.process', async (t) => {
  const h = await fixture(t);
  const body = JSON.stringify({ ...request(), vaultId: hash(h.directory) }) + ' '.repeat(700000);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.endpoint.port, method: 'POST', path: '/v1/update-note',
      headers: { host: `127.0.0.1:${h.endpoint.port}`, authorization: `Bearer ${h.endpoint.token}`, 'content-type': 'application/json' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
  assert.equal(status, 413);
  assert.equal(h.getProcessCalls(), 0);
});

test('同 vault 不同 bridge 实例通过独占目标锁阻止并发尝试', async (t) => {
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const h = await fixture(t, { processOverride: async (file, transform, files) => {
    await new Promise((resolve) => { release = resolve; markStarted(); });
    const updated = transform(files.get(file.path));
    files.set(file.path, updated);
    return updated;
  } });
  const other = createBridge({
    app: h.app,
    TFile,
    token: h.endpoint.token,
    readAttempts: async () => h.records,
    writeAttempt: async (id, record) => {
      const index = h.records.findIndex((item) => item.attemptId === id);
      if (index < 0) h.records.push(record); else h.records[index] = record;
    },
    readReplayFilter: async () => ({ bits: '', count: 0 }),
    compactAttempts: async () => {},
  });
  const endpoint = await other.start();
  t.after(() => other.close());
  const first = h.client.update(request());
  try {
    await Promise.race([
      started,
      first.then(() => { throw new Error('更新请求未进入 vault.process'); }),
    ]);
    const otherClient = createObsidianBridgeClient({ vaultRoot: h.directory, vaultId: hash(h.directory) });
    fs.writeFileSync(path.join(h.directory, '.obsidian/plugins/x-assistant-bridge/bridge.json'), JSON.stringify({ ...h.endpoint, port: endpoint.port }));
    assert.deepEqual(await otherClient.update(request({ attemptId: 'attempt-2' })), { status: 'busy' });
  } finally {
    if (release) release();
    await first;
  }
  assert.deepEqual(await first, { status: 'completed' });
});

test('达到 10000 条记录后可显式压缩，Bloom 拒绝旧 ID 重放', async (t) => {
  const saved = Array.from({ length: 10000 }, (_, index) => ({
    attemptId: `old-${index}`, vaultId: '__CURRENT__', notePath: 'notes/topic.md',
    expectedDigest: hash('# 原文\n'), contentDigest: hash('# 已完成\n'), requestDigest: hash(`request-${index}`), status: 'completed',
  }));
  const h = await fixture(t, { saved });
  assert.deepEqual(await h.bridge.resetCompletedHistory({ confirmed: true }), { status: 'completed' });
  assert.equal(h.records.length, 0);
  assert.deepEqual(await h.client.update(request({ attemptId: 'old-9999' })), { status: 'conflict' });
  assert.equal(h.getProcessCalls(), 0);
  assert.deepEqual(await h.client.update(request()), { status: 'completed' });
});

test('卸载停止接入新请求并等待已进入 vault.process 的操作', async (t) => {
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const h = await fixture(t, { processOverride: async (file, transform, files) => {
    await new Promise((resolve) => { release = resolve; markStarted(); });
    const updated = transform(files.get(file.path));
    files.set(file.path, updated);
    return updated;
  } });
  const inProgress = h.client.update(request());
  let closing;
  try {
    await Promise.race([
      started,
      inProgress.then(() => { throw new Error('更新请求未进入 vault.process'); }),
    ]);
    closing = h.bridge.close();
    assert.deepEqual(h.bridge.getState(), { accepting: false, maintenance: false, pending: 1, inFlight: 1 });
  } finally {
    if (release) release();
    if (closing) await closing;
    await inProgress;
  }
  assert.deepEqual(await inProgress, { status: 'completed' });
});

test('请求体空闲超时返回明确 unavailable，不进入写入', async (t) => {
  const h = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.endpoint.port, method: 'POST', path: '/v1/update-note',
      headers: { host: `127.0.0.1:${h.endpoint.port}`, authorization: `Bearer ${h.endpoint.token}`, 'content-type': 'application/json', 'content-length': 100 } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('{"partial":');
  });
  assert.equal(status, 408);
  assert.equal(h.getProcessCalls(), 0);
});

test('接收队列上限为 8，超限请求明确 busy 且不进入 vault.process', async (t) => {
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const h = await fixture(t, { processOverride: async (file, transform, files) => {
    await gate;
    const updated = transform(files.get(file.path));
    files.set(file.path, updated);
    return updated;
  } });
  const requests = Array.from({ length: MAX_PENDING }, (_, index) => {
    const notePath = `notes/${index}.md`;
    h.files.set(notePath, '# 原文\n');
    return h.client.update(request({ attemptId: `queue-${index}`, notePath, content: `# 更新 ${index}\n` }));
  });
  for (let index = 0; index < 50 && h.getProcessCalls() < 1; index++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(h.bridge.getState().pending <= MAX_PENDING);
  assert.equal(h.getProcessCalls(), 1);
  h.files.set('notes/overflow.md', '# 原文\n');
  assert.deepEqual(await h.client.update(request({ attemptId: 'queue-overflow', notePath: 'notes/overflow.md' })), { status: 'busy' });
  releaseGate();
  const results = await Promise.all(requests);
  assert.equal(results.filter((item) => item.status === 'completed').length, 1);
  assert.equal(results.filter((item) => item.status === 'busy').length, MAX_PENDING - 1);
  assert.equal(h.getProcessCalls(), 1);
});

test('分片跨越中文 UTF-8 字节边界时仍完整解码正文', async (t) => {
  const h = await fixture(t);
  const content = '# 中文内容：猪齿鱼与知识库联动\n';
  const body = Buffer.from(JSON.stringify({ ...request({ content }), vaultId: hash(h.directory) }), 'utf8');
  const marker = Buffer.from('中', 'utf8');
  const markerIndex = body.indexOf(marker);
  const splitAt = markerIndex + 1;
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.endpoint.port, method: 'POST', path: '/v1/update-note',
      headers: { host: `127.0.0.1:${h.endpoint.port}`, authorization: `Bearer ${h.endpoint.token}`, 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
      let response = '';
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(response) }));
    });
    req.on('error', reject);
    req.write(body.subarray(0, splitAt));
    setTimeout(() => req.end(body.subarray(splitAt)), 30);
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.status, 'completed');
  assert.equal(h.files.get('notes/topic.md'), content);
});

test('历史压缩期间暂停请求接入，压缩完成后恢复接入', async (t) => {
  const saved = [{ attemptId: 'done-1', vaultId: '__CURRENT__', notePath: 'notes/topic.md', expectedDigest: hash('# 原文\n'), contentDigest: hash('# done\n'), requestDigest: hash('done'), status: 'completed' }];
  let finishCompact;
  const h = await fixture(t, { saved, compactOverride: async ({ attempts, replayFilter, records, setReplayFilter }) => {
    await new Promise((resolve) => { finishCompact = resolve; });
    records.splice(0, records.length, ...attempts);
    setReplayFilter(replayFilter);
  } });
  const compacting = h.bridge.resetCompletedHistory({ confirmed: true });
  for (let index = 0; index < 20 && !finishCompact; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(h.bridge.getState().maintenance, true);
  assert.deepEqual(await h.client.update(request()), { status: 'unavailable' });
  finishCompact();
  assert.deepEqual(await compacting, { status: 'completed' });
  assert.deepEqual(await h.client.update(request()), { status: 'completed' });
});

test('启动时回收已终态记录的锁和已崩溃且无 attempt 记录的孤儿锁', async (t) => {
  const terminalId = 'terminal-lock';
  const terminal = { attemptId: terminalId, vaultId: '__CURRENT__', notePath: 'notes/topic.md', expectedDigest: hash('# 原文\n'), contentDigest: hash('# old\n'), requestDigest: hash('old'), status: 'completed' };
  const orphanId = 'orphan-lock';
  const lockDirectory = (directory) => path.join(directory, '.obsidian/plugins/x-assistant-bridge/locks');
  const h = await fixture(t, {
    saved: [terminal],
    initialize: async (directory) => {
      const locks = lockDirectory(directory);
      fs.mkdirSync(locks, { recursive: true });
      const locksToCreate = [
        [`attempt\0${hash(directory)}\0${terminalId}`, { vaultId: hash(directory), attemptId: terminalId, kind: 'attempt', pid: process.pid }],
        [`target\0${hash(directory)}\0notes/topic.md`, { vaultId: hash(directory), attemptId: terminalId, notePath: 'notes/topic.md', kind: 'target', pid: process.pid }],
        [`attempt\0${hash(directory)}\0${orphanId}`, { vaultId: hash(directory), attemptId: orphanId, kind: 'attempt', pid: 99999999 }],
      ];
      for (const [key, value] of locksToCreate) fs.writeFileSync(path.join(locks, `${hash(key)}.lock`), JSON.stringify(value));
    },
  });
  const locks = lockDirectory(h.directory);
  assert.equal(fs.readdirSync(locks).length, 0);
});

test('插件将并发 attempt 的 load-modify-save 串行化，避免设置记录丢失', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-settings-queue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const content = new Map([['notes/a.md', '# A\n'], ['notes/b.md', '# B\n']]);
  class BasePlugin {
    constructor(app) { this.app = app; this.data = {}; }
    async loadData() { return structuredClone(this.data); }
    async saveData(value) { await new Promise((resolve) => setTimeout(resolve, 8)); this.data = structuredClone(value); }
    addStatusBarItem() { return { setText() {} }; }
    addCommand() {}
  }
  const adapter = {
    getBasePath: () => directory,
    mkdir: async (relative) => fs.mkdirSync(path.join(directory, ...relative.split('/')), { recursive: true }),
    write: async (relative, value) => fs.writeFileSync(path.join(directory, ...relative.split('/')), value),
    remove: async (relative) => fs.rmSync(path.join(directory, ...relative.split('/')), { force: true }),
  };
  const app = { vault: {
    adapter,
    configDir: '.obsidian',
    getAbstractFileByPath: (notePath) => content.has(notePath) ? new TFile(notePath) : null,
    process: async (file, transform) => { content.set(file.path, transform(content.get(file.path))); },
  } };
  const moduleObject = { exports: {} };
  const pluginMain = path.join(__dirname, '..', 'obsidian-plugin', 'main.js');
  const localRequire = (name) => name === 'obsidian' ? { Plugin: BasePlugin, TFile, Notice: class {} } : require(name.startsWith('.') ? path.resolve(path.dirname(pluginMain), name) : name);
  vm.runInNewContext(fs.readFileSync(pluginMain, 'utf8'), { module: moduleObject, exports: moduleObject.exports, require: localRequire, Buffer, setTimeout, clearTimeout });
  const plugin = new moduleObject.exports(app);
  await plugin.onload();
  t.after(() => plugin.bridge.close());
  const client = createObsidianBridgeClient({ vaultRoot: directory, vaultId: hash(directory) });
  const [first, second] = await Promise.all([
    client.update(request({ attemptId: 'parallel-a', notePath: 'notes/a.md', expectedDigest: hash('# A\n'), content: '# A2\n' })),
    client.update(request({ attemptId: 'parallel-b', notePath: 'notes/b.md', expectedDigest: hash('# B\n'), content: '# B2\n' })),
  ]);
  const completed = [first, second].filter((item) => item.status === 'completed');
  assert.equal(completed.length, 1);
  const retry = first.status === 'busy' ? request({ attemptId: 'parallel-a', notePath: 'notes/a.md', expectedDigest: hash('# A\n'), content: '# A2\n' }) : request({ attemptId: 'parallel-b', notePath: 'notes/b.md', expectedDigest: hash('# B\n'), content: '# B2\n' });
  assert.deepEqual(await client.update(retry), { status: 'completed' });
  assert.deepEqual(plugin.data.bridgeAttempts.map((record) => record.attemptId).sort(), ['parallel-a', 'parallel-b']);
});

test('unknown attempt 的崩溃遗留锁可在确认后回收并写入终态记录', async (t) => {
  const attemptId = 'stale-unknown';
  const saved = [{ attemptId, vaultId: '__CURRENT__', notePath: 'notes/topic.md', expectedDigest: hash('# 原文\n'), contentDigest: hash('# unknown\n'), requestDigest: hash('unknown'), status: 'submitting' }];
  const h = await fixture(t, {
    saved,
    initialize: async (directory) => {
      const locks = path.join(directory, '.obsidian/plugins/x-assistant-bridge/locks');
      fs.mkdirSync(locks, { recursive: true });
      const vaultId = hash(directory);
      const lockEntries = [
        [`attempt\0${vaultId}\0${attemptId}`, { vaultId, attemptId, kind: 'attempt', pid: 99999999 }],
        [`target\0${vaultId}\0notes/topic.md`, { vaultId, attemptId, notePath: 'notes/topic.md', kind: 'target', pid: 99999999 }],
      ];
      for (const [key, value] of lockEntries) fs.writeFileSync(path.join(locks, `${hash(key)}.lock`), JSON.stringify(value));
    },
  });
  assert.deepEqual(await h.bridge.resolveUnknownAttempts({ confirmed: true }), { status: 'completed', count: 1 });
  assert.equal(h.records[0].status, 'resolved_unknown');
  assert.equal(fs.readdirSync(path.join(h.directory, '.obsidian/plugins/x-assistant-bridge/locks')).length, 0);
});

test('unknown 恢复维护等待在途写入结束，等待期间拒绝新请求', async (t) => {
  let release;
  const h = await fixture(t, { processOverride: async () => {
    await new Promise((resolve) => { release = resolve; });
    throw new Error('模拟结果不确定');
  } });
  const updating = h.client.update(request());
  for (let index = 0; index < 40 && !release; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  const recovering = h.bridge.resolveUnknownAttempts({ confirmed: true });
  assert.equal(h.bridge.getState().maintenance, true);
  assert.deepEqual(await h.client.update(request({ attemptId: 'during-maintenance' })), { status: 'unavailable' });
  release();
  assert.deepEqual(await updating, { status: 'unknown' });
  assert.deepEqual(await recovering, { status: 'completed', count: 1 });
  assert.equal(h.records[0].status, 'resolved_unknown');
});

test('只读 inspect 在远端执行中不确认排空，终态后仅完整绑定匹配才确认', async (t) => {
  let release;
  const h = await fixture(t, { processOverride: async (file, transform, files) => {
    await new Promise((resolve) => { release = resolve; });
    files.set(file.path, transform(files.get(file.path)));
  } });
  const binding = { attemptId: 'attempt-1', notePath: 'notes/topic.md', expectedDigest: hash('# 原文\n'), contentDigest: hash('# 更新后\n') };
  const updating = h.client.update(request());
  for (let index = 0; index < 40 && !release; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await h.client.inspect(binding), { status: 'busy', drained: false });
  release();
  assert.deepEqual(await updating, { status: 'completed' });
  assert.deepEqual(await h.client.inspect(binding), { status: 'completed', drained: true });
  assert.deepEqual(await h.client.inspect({ ...binding, contentDigest: hash('different') }), { status: 'conflict', drained: false });
  assert.equal(h.getProcessCalls(), 1);
});

test('另一进程持有 vault 事务锁时写入、维护、inspect 均拒绝越过事务', async (t) => {
  const h = await fixture(t);
  const transactionPath = path.join(h.directory, '.obsidian/plugins/x-assistant-bridge/locks/vault-transaction.lock');
  const code = `const fs = require('node:fs'); const lockPath = process.argv[1]; const vaultId = process.argv[2]; const fd = fs.openSync(lockPath, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({pid:process.pid,vaultId})); process.send('locked'); process.on('message', () => { fs.closeSync(fd); fs.unlinkSync(lockPath); process.send('released'); process.disconnect(); });`;
  const child = spawn(process.execPath, ['-e', code, transactionPath, hash(h.directory)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (!child.killed) child.kill(); });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  assert.deepEqual(await h.client.update(request()), { status: 'busy' });
  assert.deepEqual(await h.bridge.resetCompletedHistory({ confirmed: true }), { status: 'busy' });
  assert.deepEqual(await h.client.inspect({ attemptId: 'attempt-1', notePath: 'notes/topic.md', expectedDigest: hash('# 原文\n'), contentDigest: hash('# 更新后\n') }), { status: 'busy', drained: false });
  assert.equal(h.records.length, 0);
  assert.equal(h.getProcessCalls(), 0);
  const released = new Promise((resolve) => child.once('message', resolve));
  child.send('release');
  await released;
  assert.deepEqual(await h.client.update(request()), { status: 'completed' });
});
