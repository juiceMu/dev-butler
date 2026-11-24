const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../src/core.cjs');
const { createSessionWorkflow } = require('../src/session-workflow.cjs');

const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '3' };
const input = { attemptId: '12345678-1234-1234-1234-123456789abc', issue, projectId: 'project', cwd: '/work', primary: false };
function fixture(t, create) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-workflow-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LocalStore(directory);
  return { store, workflow: createSessionWorkflow({ directory, store, codex: { create } }) };
}
test('创建会话只执行一次并持久保存关联', async (t) => {
  let count = 0;
  const { store, workflow } = fixture(t, async () => { count++; return { id: 'thread-1', title: '标题' }; });
  const result = await workflow.create(input);
  assert.equal(result.status, 'linked');
  assert.equal((await workflow.create(input)).sessionId, 'thread-1');
  assert.equal(count, 1);
  assert.equal(store.list().links[0].sessionId, 'thread-1');
  assert.equal(workflow.list().length, 1);
  await assert.rejects(workflow.create({ ...input, cwd: '/other' }), /其他请求/);
});
test('创建时将工作项标题传给会话命名流程', async (t) => {
  let received;
  const { workflow } = fixture(t, async (args) => { received = args; return { id: 'thread-1', title: args.title }; });
  const result = await workflow.create({ ...input, issue: { ...issue, title: '修复事件流' } });
  assert.equal(received.title, '修复事件流');
  assert.equal(result.sessionTitle, '修复事件流');
});
test('创建结果不确定时不自动重试', async (t) => {
  let count = 0;
  const { workflow } = fixture(t, async () => { count++; throw new Error('timeout'); });
  assert.equal((await workflow.create(input)).status, 'unknown');
  assert.equal((await workflow.create(input)).status, 'unknown');
  assert.throws(() => workflow.finish(input.attemptId), /尚未确认/);
  await assert.rejects(workflow.create({ ...input, attemptId: 'abcdef12-1234-1234-1234-123456789abc' }), /未完成/);
  assert.equal(count, 1);
  assert.equal(workflow.abandon(input.attemptId).status, 'abandoned');
});
test('已返回会话 ID 的不确定记录可核对后恢复，不重复创建或发送', async (t) => {
  let count = 0;
  const { workflow, store } = fixture(t, async () => { count++; const error = new Error('name failed'); error.recoverySessionId = 'thread-1'; throw error; });
  assert.equal((await workflow.create({ ...input, initialMessage: '测试消息' })).status, 'unknown');
  assert.throws(() => workflow.recover(input.attemptId, { id: 'thread-1', cwd: '/other' }), /不匹配/);
  assert.throws(() => workflow.recover(input.attemptId, { id: 'other', cwd: '/work' }), /不匹配/);
  const recovered = workflow.recover(input.attemptId, { id: 'thread-1', cwd: '/work', title: '已创建' });
  assert.equal(recovered.status, 'created');
  assert.equal(recovered.messageStatus, 'not_sent');
  assert.equal(store.list().links.length, 0);
  assert.equal(workflow.finish(input.attemptId).status, 'linked');
  assert.equal(store.list().links[0].sessionId, 'thread-1');
  assert.equal(count, 1);
  assert.throws(() => workflow.recover(input.attemptId, { id: 'thread-1', cwd: '/work' }), /不匹配/);
});
test('关联失败后仅重试本地保存', async (t) => {
  let count = 0;
  const { workflow, store } = fixture(t, async () => { count++; return { id: 'thread-1' }; });
  const add = store.addLink.bind(store);
  store.addLink = () => { throw new Error('disk'); };
  assert.equal((await workflow.create(input)).status, 'created');
  store.addLink = add;
  assert.equal(workflow.finish(input.attemptId).status, 'linked');
  assert.equal(count, 1);
});
test('创建期间账号变化时保留会话 ID，不自动关联', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-workflow-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LocalStore(directory);
  const workflow = createSessionWorkflow({ directory, store, codex: { create: async () => ({ id: 'thread-2' }) }, verifyBeforeLink: async () => { throw new Error('账号变化'); } });
  const result = await workflow.create({ ...input, userId: '123' });
  assert.equal(result.status, 'created');
  assert.equal(result.sessionId, 'thread-2');
  assert.equal(store.list().links.length, 0);
  assert.equal(workflow.get(input.attemptId).userId, '123');
});
test('首条消息先持久化待发送状态，仅在关联完成后发送一次', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-message-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LocalStore(directory);
  let sent = 0; let workflow;
  const codex = {
    create: async () => ({ id: 'thread-1' }),
    initialTurn: async ({ threadId, message }) => {
      sent++;
      assert.equal(workflow.get(input.attemptId).messageStatus, 'sending');
      assert.equal(workflow.get(input.attemptId).sessionId, threadId);
      assert.equal(store.list().links.length, 1);
      assert.equal(message, '测试消息');
      return { status: 'completed' };
    },
  };
  workflow = createSessionWorkflow({ directory, store, codex });
  const args = { ...input, initialMessage: '测试消息' };
  const result = await workflow.create(args);
  assert.equal(result.status, 'linked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workflow.get(input.attemptId).messageStatus, 'completed');
  assert.equal((await workflow.create(args)).messageStatus, 'completed');
  assert.equal(sent, 1);
  await assert.rejects(workflow.create({ ...args, initialMessage: '其他消息' }), /其他请求/);
});
test('首条消息结果不确定不会自动重发', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-message-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let sent = 0;
  const workflow = createSessionWorkflow({ directory, store: new LocalStore(directory), codex: { create: async () => ({ id: 'thread-1' }), initialTurn: async () => { sent++; throw new Error('timeout'); } } });
  const args = { ...input, initialMessage: '测试消息' };
  assert.equal((await workflow.create(args)).status, 'linked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await workflow.create(args)).messageStatus, 'unknown');
  await assert.rejects(workflow.sendInitial(args.attemptId), /当前状态不能/);
  assert.equal(sent, 1);
});
test('未发送首条消息可以确认后恢复，且并发调用不重复发送', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-message-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LocalStore(directory);
  let calls = 0;
  const workflow = createSessionWorkflow({ directory, store, codex: { create: async () => ({ id: 'thread-1' }), initialTurn: async () => { calls++; if (calls === 1) { const error = new Error('not sent'); error.code = 'CODEX_TURN_NOT_SENT'; throw error; } return { status: 'completed' }; } } });
  const args = { ...input, initialMessage: '测试消息' };
  assert.equal((await workflow.create(args)).status, 'linked');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workflow.get(args.attemptId).messageStatus, 'not_sent');
  const [first, second] = await Promise.allSettled([workflow.sendInitial(args.attemptId), workflow.sendInitial(args.attemptId)]);
  assert.equal(first.value.messageStatus, 'completed');
  assert.equal(second.status, 'rejected');
  assert.equal(calls, 2);
});
test('首条消息尚未结束时创建调用立即返回且关联已保存', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-background-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new LocalStore(directory);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const workflow = createSessionWorkflow({ directory, store, codex: { create: async () => ({ id: 'thread-1' }), initialTurn: () => pending } });
  const result = await workflow.create({ ...input, initialMessage: '测试消息' });
  assert.equal(result.status, 'linked');
  assert.equal(result.messageStatus, 'sending');
  assert.equal(store.list().links[0].sessionId, 'thread-1');
  finish({ status: 'completed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workflow.get(input.attemptId).messageStatus, 'completed');
});
test('创建锁已占用时保留锁并报告检查路径', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'session-attempts'); fs.mkdirSync(root);
  const lock = path.join(root, '.reservation.lock'); fs.writeFileSync(lock, 'existing');
  const workflow = createSessionWorkflow({ directory, store: new LocalStore(directory), codex: { create: async () => { throw new Error('不应调用'); } } });
  await assert.rejects(workflow.create(input), (error) => error.message.includes('确认没有创建操作运行') && error.message.includes(lock));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'existing');
});
