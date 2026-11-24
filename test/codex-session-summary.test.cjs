const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSessionSummary, SUMMARY_PROMPT } = require('../src/codex-session-summary.cjs');

function fakeServer({ turnStatus = 'completed', stale = false, output = '总结', noReply = false, serviceError, early = false, forkId = 'fork', forkStatus = 'idle', ephemeral = true, sandbox = { type: 'readOnly', networkAccess: false }, tool = false, request = false, completionStatus = 'completed', commentary = false, unrelated = false } = {}) {
  const calls = []; let listCount = 0; let kills = 0; let spawnArgs;
  const spawnProcess = (...args) => {
    spawnArgs = args;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { kills++; };
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'); const value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); calls.push(value);
        const emit = (result) => child.stdout.write(JSON.stringify({ id: value.id, result }) + '\n');
        const notify = (method, params) => child.stdout.write(JSON.stringify({ method, params: { threadId: forkId, turnId: 'summary-turn', ...params } }) + '\n');
        if (value.method === 'initialize') emit({});
        if (value.method === 'thread/turns/list') { listCount++; emit({ data: [{ id: stale && listCount > 1 ? 'new-turn' : 'turn', status: turnStatus }] }); }
        if (value.method === 'thread/fork') emit({ thread: { id: forkId, ephemeral, status: { type: forkStatus } }, sandbox });
        if (value.method === 'turn/start' && !noReply) {
          if (serviceError) { child.stdout.write(JSON.stringify({ id: value.id, error: serviceError }) + '\n'); continue; }
          if (request) { child.stdout.write(JSON.stringify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} }) + '\n'); continue; }
          if (tool) { notify('item/started', { item: { type: 'commandExecution' } }); continue; }
          const events = () => {
            notify('item/started', { item: { type: 'userMessage' } });
            if (unrelated) notify('item/completed', { turnId: 'other-turn', item: { type: 'agentMessage', text: '其他回合内容', phase: 'final' } });
            if (commentary) notify('item/completed', { item: { type: 'agentMessage', text: '正在检查', phase: 'commentary' } });
            if (typeof output === 'string') notify('item/completed', { item: { type: 'agentMessage', text: output, phase: 'final' } });
            notify('turn/completed', { turn: { id: 'summary-turn', status: completionStatus } });
          };
          if (early) events();
          emit({ turn: { id: 'summary-turn' } });
          if (!early) events();
        }
      }
    });
    return child;
  };
  return { calls, spawnProcess, get kills() { return kills; }, get spawnArgs() { return spawnArgs; } };
}

test('总结在临时隔离副本运行，继承原历史且不向原会话发起回合', async () => {
  const fake = fakeServer({ commentary: true, unrelated: true });
  assert.deepEqual(await createSessionSummary({ spawnProcess: fake.spawnProcess })('thread'), { text: '总结', sourceTurnId: 'turn' });
  assert.deepEqual(fake.calls.filter((call) => call.method).map((call) => call.method), ['initialize', 'initialized', 'thread/turns/list', 'thread/fork', 'turn/start', 'thread/turns/list']);
  assert.deepEqual(fake.calls.find((call) => call.method === 'thread/fork').params, { threadId: 'thread', lastTurnId: 'turn', ephemeral: true, excludeTurns: true, config: { 'features.goals': false }, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: '只输出会话总结，不得调用任何工具或执行任何操作。' });
  assert.deepEqual(fake.calls.find((call) => call.method === 'turn/start').params, { threadId: 'fork', input: [{ type: 'text', text: SUMMARY_PROMPT }] });
  assert.equal(fake.calls.some((call) => call.method === 'thread/sample'), false);
  assert.equal(fake.calls.some((call) => call.method === 'thread/resume'), false);
  assert.equal(fake.calls.some((call) => call.method === 'thread/goal/clear'), false);
  assert.equal(fake.spawnArgs[1].includes('shell_tool'), true);
  assert.equal(fake.spawnArgs[1].includes('unified_exec'), true);
  assert.equal(fake.spawnArgs[1].includes('goals'), true);
  assert.equal(fake.spawnArgs[1].includes('mcp_servers={}'), true);
  assert.equal(fake.kills, 1);
});

test('完成通知早于启动响应时仍返回完整正文', async () => {
  assert.deepEqual(await createSessionSummary({ spawnProcess: fakeServer({ early: true }).spawnProcess })('thread'), { text: '总结', sourceTurnId: 'turn' });
});

test('拒绝未结束、过期、无文本、失败及超时结果', async () => {
  for (const options of [{ turnStatus: 'inProgress' }, { stale: true }, { output: '' }, { output: null }, { noReply: true }, { completionStatus: 'failed' }]) {
    const fake = fakeServer(options);
    await assert.rejects(createSessionSummary({ spawnProcess: fake.spawnProcess, timeoutMs: 20 })('thread'));
    assert.equal(fake.kills, 1);
  }
});

test('副本必须与原会话不同且无网络只读，校验失败不发起回合', async () => {
  for (const options of [{ forkId: 'thread' }, { forkId: '' }, { forkStatus: 'active' }, { forkStatus: null }, { ephemeral: false }, { sandbox: { type: 'readOnly', networkAccess: true } }, { sandbox: { type: 'dangerFullAccess', networkAccess: false } }]) {
    const fake = fakeServer(options);
    await assert.rejects(createSessionSummary({ spawnProcess: fake.spawnProcess })('thread'), /隔离状态/);
    assert.equal(fake.calls.some((call) => call.method === 'turn/start'), false);
  }
});

test('工具尝试或交互请求立即停止且不回写原会话', async () => {
  for (const options of [{ tool: true }, { request: true }]) {
    const fake = fakeServer(options);
    await assert.rejects(createSessionSummary({ spawnProcess: fake.spawnProcess })('thread'), /已停止生成/);
    assert.equal(fake.kills, 1);
    assert.equal(fake.calls.filter((call) => call.method === 'turn/start').every((call) => call.params.threadId === 'fork'), true);
    if (options.request) assert.equal(fake.calls.find((call) => call.id === 'approval').error.code, -32601);
  }
});

test('区分无正文、超限与服务错误，不误报会话变化', async () => {
  for (const [options, expected] of [
    [{ output: null }, /未返回文档正文/],
    [{ output: 'x'.repeat(100001) }, /超过长度限制/],
    [{ serviceError: { code: -32603, message: 'sample timed out' } }, /会话总结请求超时/],
    [{ serviceError: { code: -32601, message: 'unknown method' } }, /不支持会话总结/],
    [{ serviceError: { code: -32603, message: 'Upstream encrypted content error' } }, /上下文无法被模型服务读取/],
    [{ serviceError: { code: -32603, message: 'stale expected turn' } }, /上下文已变化/],
    [{ serviceError: { code: -32603, message: 'private server details' } }, /模型服务未能完成/],
  ]) {
    await assert.rejects(createSessionSummary({ spawnProcess: fakeServer(options).spawnProcess })('thread'), expected);
  }
});
