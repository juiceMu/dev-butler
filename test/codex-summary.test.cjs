const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCodexSummary, SUMMARY_INSTRUCTION } = require('../src/codex-summary.cjs');

function fakeServer({ sandbox = { type: 'readOnly', networkAccess: false }, status = 'completed', output = '总结结果', tool = false, noReply = false } = {}) {
  const calls = [];
  const spawnProcess = (_command, args) => {
    calls.push({ args });
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    let buffer = '';
    const emit = (value) => child.stdout.write(JSON.stringify(value) + '\n');
    child.stdin.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); const request = JSON.parse(line); calls.push(request);
        if (request.method === 'initialize') emit({ id: request.id, result: {} });
        if (request.method === 'thread/start') emit({ id: request.id, result: { thread: { id: 'test-thread' }, sandbox } });
        if (request.method === 'turn/start' && !noReply) {
          emit({ id: request.id, result: { turn: { id: 'test-turn' } } });
          if (tool) emit({ method: 'item/started', params: { threadId: 'test-thread', item: { type: 'mcpToolCall' } } });
          else {
            emit({ method: 'item/completed', params: { threadId: 'test-thread', item: { type: 'agentMessage', text: output } } });
            emit({ method: 'turn/completed', params: { threadId: 'test-thread', turn: { id: 'test-turn', status } } });
          }
        }
      }
    });
    return child;
  };
  return { calls, spawnProcess };
}

test('总结使用临时只读会话及默认模型，返回文本而不写草稿', async () => {
  const fake = fakeServer();
  const result = await createCodexSummary({ spawnProcess: fake.spawnProcess })('用户：查询慢');
  assert.deepEqual(result, { text: '总结结果' });
  const start = fake.calls.find((entry) => entry.method === 'thread/start');
  assert.equal(start.params.ephemeral, true); assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(start.params.model, undefined);
  assert.ok(fake.calls[0].args.includes('mcp_servers={}'));
  const turn = fake.calls.find((entry) => entry.method === 'turn/start');
  assert.equal(turn.params.input[0].text, `${SUMMARY_INSTRUCTION}\n\n用户：查询慢`);
});

test('拒绝无效输入、非只读沙箱、工具调用、失败和超时', async () => {
  for (const content of ['', ' ', 'x'.repeat(18001)]) await assert.rejects(createCodexSummary({ spawnProcess: fakeServer().spawnProcess })(content));
  for (const options of [{ sandbox: { type: 'workspaceWrite' } }, { tool: true }, { status: 'failed' }, { output: '' }, { noReply: true }]) {
    await assert.rejects(createCodexSummary({ spawnProcess: fakeServer(options).spawnProcess, timeoutMs: 20 })('测试'));
  }
});
