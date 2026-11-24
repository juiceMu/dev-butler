const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexClient } = require('../src/codex.cjs');
const { createAppServerRequest, createInitialTurn } = require('../src/codex-transport.cjs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

test('默认不连接 Codex 或声称已支持创建和打开', async () => {
  const client = createCodexClient();
  assert.deepEqual(client.capabilities(), { metadataRead: false, list: false, create: false, open: false, history: false });
  await assert.rejects(client.read('thread-1'), { code: 'CODEX_UNAVAILABLE' });
});

test('只发送有范围的列表请求并返回必要元数据', async () => {
  let call;
  const client = createCodexClient({ request: async (method, params) => {
    call = { method, params };
    return { data: [{ id: 'thread-1', name: '标题', cwd: '/work', createdAt: 1, updatedAt: 2, status: { type: 'idle' }, preview: '不应返回原文', turns: [{ secret: '不应返回' }] }], nextCursor: 'next' };
  } });
  const result = await client.list({ searchTerm: '标题', limit: 10 });
  assert.deepEqual(call, { method: 'thread/list', params: { useStateDbOnly: true, limit: 10, searchTerm: '标题' } });
  assert.deepEqual(result, { data: [{ id: 'thread-1', title: '标题', cwd: '/work', createdAt: 1, updatedAt: 2, status: 'idle' }], nextCursor: 'next' });
  await assert.rejects(client.list({}), /指定关键词或工程路径/);
  await assert.rejects(client.list({ cwd: 'relative' }), /绝对路径/);
  await assert.rejects(client.list({ searchTerm: 'x', limit: 51 }), /limit/);
});

test('详情仅请求元数据，不请求历史', async () => {
  const client = createCodexClient({ request: async (method, params) => {
    assert.equal(method, 'thread/read');
    assert.deepEqual(params, { threadId: 'thread-1', includeTurns: false });
    return { thread: { id: 'thread-1', turns: [{ text: '不应返回' }] } };
  } });
  assert.equal(JSON.stringify(await client.read('thread-1')).includes('不应返回'), false);
  const invalid = createCodexClient({ request: async () => ({ thread: { id: 'other' } }) });
  await assert.rejects(invalid.read('thread-1'), /标识不匹配/);
});

test('会话历史限定分页，仅返回用户和助手文本并标记截断', async () => {
  const client = createCodexClient({ request: async (method, params) => {
    assert.equal(method, 'thread/turns/list');
    assert.deepEqual(params, { threadId: 'thread-1', limit: 1, cursor: 'next', itemsView: 'full', sortDirection: 'desc' });
    return { data: [{ id: 'turn', status: 'completed', startedAt: 1700000000, completedAt: null, itemsView: 'full', items: [
      { type: 'userMessage', content: [{ type: 'text', text: '问题' }, { type: 'localImage', path: '/private' }] },
      { type: 'commandExecution', aggregatedOutput: '不返回' },
      { type: 'agentMessage', text: 'x'.repeat(20001) },
    ] }], nextCursor: null };
  } });
  const result = await client.history({ threadId: 'thread-1', cursor: 'next', limit: 1 });
  assert.equal(result.turns[0].messages[0].text, '问题');
  assert.equal(result.turns[0].startedAt, 1700000000);
  assert.equal(result.turns[0].completedAt, null);
  assert.equal(result.turns[0].messages[1].text.length, 20000);
  assert.equal(result.turns[0].omittedItems, 1);
  assert.equal(result.turns[0].omittedContentParts, 1);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes('不返回'), false);
  assert.equal(JSON.stringify(result).includes('/private'), false);
  await assert.rejects(client.history({ threadId: 'thread-1', limit: 6 }), /limit/);
  const invalid = createCodexClient({ request: async () => ({ data: [{ id: 't', items: [], itemsView: 'summary' }], nextCursor: null }) });
  await assert.rejects(invalid.history({ threadId: 't' }), /不完整/);
  const malformed = createCodexClient({ request: async () => ({ data: [{ id: 't', items: [{ type: 'agentMessage' }], itemsView: 'full' }], nextCursor: null }) });
  await assert.rejects(malformed.history({ threadId: 't' }), /消息无效/);
});

test('项目列表仅返回名称、ID 与根目录', async () => {
  const client = createCodexClient({ request: async (method, params) => {
    assert.equal(method, 'project/list'); assert.deepEqual(params, { limit: 50 });
    return { data: [{ id: 'p', name: '项目', roots: [{ path: '/work' }], metadata: { secret: 'private' } }], nextCursor: null };
  } });
  assert.deepEqual(await client.projects(), { data: [{ id: 'p', name: '项目', roots: ['/work'] }], nextCursor: null });
});

test('创建仅发送指定项目与目录，错误的返回视为结果不确定', async () => {
  const client = createCodexClient({ request: async (method, params, options) => {
    assert.equal(method, 'thread/start'); assert.deepEqual(params, { projectId: 'p', cwd: '/work', ephemeral: false });
    assert.equal(options.title, '工作项 标题');
    return { thread: { id: 't', cwd: '/work', projectId: 'p', preview: 'private' } };
  } });
  const result = await client.create({ projectId: 'p', cwd: '/work', title: '工作项\n标题' });
  assert.equal(result.id, 't'); assert.equal(JSON.stringify(result).includes('private'), false);
  const invalid = createCodexClient({ request: async () => ({ thread: { id: 't', cwd: '/other', projectId: 'p' } }) });
  await assert.rejects(invalid.create({ projectId: 'p', cwd: '/work' }), { code: 'CODEX_CREATE_UNCERTAIN', recoverySessionId: 't' });
});

function fakeServer(handler) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false; child.kill = () => { child.killed = true; };
  let buffer = '';
  child.stdin.on('data', (data) => {
    buffer += data.toString();
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      handler(JSON.parse(line), child);
    }
  });
  return child;
}

test('传输协商实验能力、限定方法并关闭子进程', async () => {
  let child;
  const request = createAppServerRequest({ spawnProcess: () => {
    child = fakeServer((message, process) => {
      if (message.id === 1) {
        assert.equal(message.params.capabilities.experimentalApi, true);
        process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
      } else if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { data: [] } }) + '\n');
    });
    return child;
  } });
  assert.deepEqual(await request('project/list', {}), { data: [] });
  assert.equal(child.killed, true);
  await assert.rejects(request('turn/start', {}), /不允许/);
});

test('创建请求发出后超时报告不确定，且不自动重试', async () => {
  let starts = 0; let child;
  const request = createAppServerRequest({ timeoutMs: 20, spawnProcess: () => {
    child = fakeServer((message, process) => {
      if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
      if (message.method === 'thread/start') starts++;
    });
    return child;
  } });
  await assert.rejects(request('thread/start', {}), { code: 'CODEX_CREATE_UNCERTAIN' });
  assert.equal(starts, 1); assert.equal(child.killed, true);
});
test('首条消息等待匹配回合完成通知，不将请求响应当作完成', async () => {
  let child; let sent;
  const turn = createInitialTurn({ spawnProcess: () => {
    child = fakeServer((message, process) => {
      if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
      if (message.method === 'thread/resume') process.stdout.write(JSON.stringify({ id: 2, result: { thread: { id: 't' } } }) + '\n');
      if (message.method === 'turn/start') {
        sent = message.params;
        process.stdout.write(JSON.stringify({ id: 3, result: { turn: { id: 'turn-1' } } }) + '\n');
        process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn-1', status: 'completed' } } }) + '\n');
      }
    });
    return child;
  } });
  assert.deepEqual(await turn({ threadId: 't', message: '测试' }), { status: 'completed' });
  assert.deepEqual(sent.input, [{ type: 'text', text: '测试' }]);
  assert.equal(child.killed, true);
});
test('首条消息提交后连接超时不能自动重发', async () => {
  let sent = 0;
  const turn = createInitialTurn({ timeoutMs: 20, spawnProcess: () => fakeServer((message, process) => {
    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    if (message.method === 'thread/resume') process.stdout.write(JSON.stringify({ id: 2, result: { thread: { id: 't' } } }) + '\n');
    if (message.method === 'turn/start') sent++;
  }) });
  await assert.rejects(turn({ threadId: 't', message: '测试' }), { code: 'CODEX_TURN_UNCERTAIN' });
  assert.equal(sent, 1);
});
test('创建后在同一进程设置会话标题才返回', async () => {
  const commands = [];
  let requestedName;
  const request = createAppServerRequest({ spawnProcess: () => fakeServer((message, process) => {
    if (message.method) commands.push(message.method);
    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    if (message.method === 'thread/start') process.stdout.write(JSON.stringify({ id: 2, result: { thread: { id: 't' } } }) + '\n');
    if (message.method === 'thread/name/set') { requestedName = message.params.name; process.stdout.write(JSON.stringify({ id: 3, result: {} }) + '\n'); }
  }) });
  const created = await request('thread/start', {}, { title: '工作项标题' });
  assert.equal(created.thread.id, 't'); assert.equal(created.thread.name, '工作项标题'); assert.equal(requestedName, '工作项标题');
  assert.deepEqual(commands, ['initialize', 'initialized', 'thread/start', 'thread/name/set']);
});
test('会话创建后设置标题失败时保留 ID 并报告结果不确定', async () => {
  const request = createAppServerRequest({ spawnProcess: () => fakeServer((message, process) => {
    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    if (message.method === 'thread/start') process.stdout.write(JSON.stringify({ id: 2, result: { thread: { id: 't' } } }) + '\n');
    if (message.method === 'thread/name/set') process.stdout.write(JSON.stringify({ id: 3, error: { code: -1 } }) + '\n');
  }) });
  await assert.rejects(request('thread/start', {}), (error) => error.code === 'CODEX_CREATE_UNCERTAIN' && error.recoverySessionId === 't');
});
