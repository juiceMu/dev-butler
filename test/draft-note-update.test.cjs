const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalStore } = require('../src/core.cjs');
const { createDraftNoteUpdater } = require('../src/draft-note-update.cjs');

const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');

function fixture(t, { bridgeStatus = 'completed' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-note-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, 'state');
  const guardDirectory = path.join(directory, 'guard');
  fs.mkdirSync(guardDirectory, { mode: 0o700 });
  const store = new LocalStore(stateDirectory);
  const draft = store.saveDraft({ title: '知识记录', target: 'notes/topic.md', content: '# 更新后\n' });
  let noteContent = '# 原文\n';
  let currentVault = 'a'.repeat(64);
  let bridgeCalls = 0;
  const createUpdater = (localStore = store) => createDraftNoteUpdater({
    store: localStore,
    directory: guardDirectory,
    knowledgeStore: () => ({ read: (notePath) => ({ path: notePath, content: noteContent, revision: 'rev' }) }),
    currentVaultId: () => currentVault,
    inspectNote: async () => ({ status: 'completed', drained: true }),
    processNote: async (vaultId, target, transform) => {
      bridgeCalls++;
      assert.equal(vaultId, currentVault);
      assert.equal(target, draft.target);
      noteContent = transform(noteContent);
      return { status: bridgeStatus };
    },
  });
  return { store, draft, updater: createUpdater(), createUpdater, stateDirectory, guardDirectory, setNote: (value) => { noteContent = value; }, setVault: (value) => { currentVault = value; }, getNote: () => noteContent, getBridgeCalls: () => bridgeCalls };
}

test('追加保留原文和独立草稿，可用最终笔记的回执关联工作项', async (t) => {
  const f = fixture(t);
  const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '3' };
  const d = f.store.saveDraft({ ...f.draft, issue, content: '# 新结论\n\n```js\n示例\n```\n' }, { expectedRevision: f.draft.revision });
  const original = '---\r\ntitle: 旧标题\r\n---\r\n\r\n旧结论\r\n\r\n其他正文\r\n';
  f.setNote(original);
  const start = original.indexOf('旧结论');
  const selection = { start, end: start + '旧结论'.length, text: '旧结论' };
  const input = { id: d.id, revision: d.revision, target: d.target, expectedContent: d.content, mode: 'append', vaultId: 'a'.repeat(64), beforeDigest: digest(original), selection };
  const preview = f.updater.preview(input);
  assert.equal(preview.beforeContent, original);
  assert.equal(preview.removed, '');
  assert.ok(preview.afterContent.startsWith(original));
  assert.equal(preview.selection.startLine, 5);
  assert.equal(preview.conclusionFormat, 'markdown-source');
  assert.ok(preview.afterContent.includes(`\r\n\x60\x60\x60\x60markdown\r\n${d.content}\r\n\x60\x60\x60\x60\r\n`));
  assert.equal(f.getBridgeCalls(), 0);
  const result = await f.updater.submit({ ...input, requestId: preview.requestId, confirmation: preview.confirmation, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(f.getNote(), preview.afterContent);
  assert.equal(f.store.list().drafts[0].content, d.content);
  assert.equal(result.updateReceipt.draftDigest, digest(d.content));
  assert.equal(result.updateReceipt.afterDigest, digest(preview.afterContent));
  assert.equal(f.store.list().pendingNoteLinks[0].contentDigest, result.updateReceipt.afterDigest);
  f.updater.link({ ...input, requestId: preview.requestId, confirmed: true, issue });
  assert.equal(f.store.list().noteLinks.length, 1);
});

test('追加预览拒绝错误选段和过期原文，确认令牌不能跨更新方式使用', async (t) => {
  const f = fixture(t);
  const original = f.getNote();
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, requestId: 'shared-id' };
  const append = { ...input, mode: 'append', vaultId: 'a'.repeat(64), beforeDigest: digest(original), selection: { start: 2, end: 4, text: '原文' } };
  assert.throws(() => f.updater.preview({ ...append, selection: undefined }), /选择被取代/);
  assert.throws(() => f.updater.preview({ ...append, selection: { ...append.selection, text: '错误' } }), /片段与原文不匹配/);
  assert.throws(() => f.updater.preview({ ...append, beforeDigest: '0'.repeat(64) }), /原文已变化/);
  f.setVault('b'.repeat(64));
  assert.throws(() => f.updater.preview(append), /知识库已变化/);
  f.setVault(append.vaultId);
  const replaced = f.updater.preview(input);
  const appended = f.updater.preview(append);
  await assert.rejects(f.updater.submit({ ...input, confirmation: replaced.confirmation, confirmed: true }), /确认与草稿或目标不匹配/);
  await assert.rejects(f.updater.submit({ ...input, expectedContent: appended.afterContent, confirmation: appended.confirmation, confirmed: true }), /确认与草稿或目标不匹配/);
  f.setNote('# 外部更新');
  assert.deepEqual(await f.updater.submit({ ...input, confirmation: appended.confirmation, confirmed: true }), { status: 'not_written', reason: '目标笔记在预览后已变化，请重新读取并预览' });
  assert.equal(f.store.list().drafts[0].updateLock, undefined);
  assert.equal(f.getBridgeCalls(), 0);
});

test('追加结果不确定后，可重启并按最终正文核对恢复，无需再次写入', async (t) => {
  const f = fixture(t, { bridgeStatus: 'unknown' });
  const original = f.getNote();
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, requestId: 'append-recovery' };
  const preview = f.updater.preview({ ...input, mode: 'append', vaultId: 'a'.repeat(64), beforeDigest: digest(original), selection: { start: 2, end: 4, text: '原文' } });
  assert.equal((await f.updater.submit({ ...input, confirmation: preview.confirmation, confirmed: true })).status, 'unknown');
  const restartedStore = new LocalStore(f.stateDirectory);
  const restartedUpdater = f.createUpdater(restartedStore);
  assert.equal(restartedStore.list().drafts[0].updateLock.draftDigest, digest(f.draft.content));
  f.setNote(f.draft.content);
  const args = { id: f.draft.id, revision: f.draft.revision, requestId: input.requestId };
  assert.equal((await restartedUpdater.inspect(args)).status, 'differs');
  await assert.rejects(restartedUpdater.recover({ ...args, confirmed: true }), /内容不一致/);
  f.setNote(preview.afterContent);
  assert.equal((await restartedUpdater.inspect(args)).status, 'matches_after');
  await restartedUpdater.recover({ ...args, confirmed: true });
  const recovered = restartedStore.list().drafts[0];
  assert.equal(recovered.updateLock, undefined);
  assert.equal(recovered.content, f.draft.content);
  assert.equal(recovered.updateReceipt.afterDigest, digest(preview.afterContent));
  assert.equal(f.getBridgeCalls(), 1);
});

test('多工作项更新保留完整收据并可逐项关联', async (t) => {
  const f = fixture(t);
  const issues = ['1', '2'].map((issueId) => ({ environment: 'https://example.test', tenantId: '1', projectId: '2', issueId }));
  const d = f.store.saveDraft({ ...f.draft, issues }, { expectedRevision: f.draft.revision });
  const request = { id: d.id, revision: d.revision, target: d.target, expectedContent: d.content };
  const preview = f.updater.preview(request);
  const result = await f.updater.submit({ ...request, ...preview, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.updateReceipt.issues.length, 2);
  assert.equal(f.store.list().pendingNoteLinks.length, 2);
  assert.throws(() => f.updater.link({ ...request, requestId: preview.requestId, confirmed: true }), /指定/);
  for (const issue of issues) f.updater.link({ ...request, requestId: preview.requestId, confirmed: true, issue });
  assert.equal(f.store.list().noteLinks.length, 2);
});

test('更新预览绑定当前草稿、原文与目标，提交前原文变化会要求重新预览', async (t) => {
  const f = fixture(t);
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, requestId: 'update-1' };
  const preview = f.updater.preview(input);
  assert.equal(preview.beforeContent, '# 原文\n');
  assert.equal(preview.afterContent, '# 更新后\n');
  assert.equal(preview.unchanged, false);
  assert.equal(preview.removed, '# 原文');
  f.setNote('# 外部修改\n');
  assert.equal((await f.updater.submit({ ...input, confirmation: preview.confirmation, confirmed: true })).status, 'not_written');
  assert.equal(f.getBridgeCalls(), 0);
  assert.equal(f.getNote(), '# 外部修改\n');
});

test('草稿版本、知识库或确认令牌变化时不触发更新', async (t) => {
  const f = fixture(t);
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, requestId: 'update-2' };
  const preview = f.updater.preview(input);
  await assert.rejects(f.updater.submit({ ...input, confirmation: preview.confirmation, confirmed: false }), /明确确认/);
  await assert.rejects(f.updater.submit({ ...input, confirmation: '0'.repeat(64), confirmed: true }), /不匹配/);
  const next = f.store.saveDraft({ ...f.draft, title: '已编辑' }, { expectedRevision: f.draft.revision });
  await assert.rejects(f.updater.submit({ ...input, revision: next.revision, confirmation: preview.confirmation, confirmed: true }), /不匹配/);
  assert.equal(f.getBridgeCalls(), 0);
});

test('未知结果可核对并且恢复只解除本地冻结，不调用笔记写入', async (t) => {
  const f = fixture(t);
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, requestId: 'update-3' };
  const preview = f.updater.preview(input);
  f.setNote(f.draft.content);
  f.store.beginDraftUpdate({
    id: f.draft.id,
    revision: f.draft.revision,
    target: f.draft.target,
    content: f.draft.content,
    updateLock: { requestId: input.requestId, ownerPid: 99999999, vaultId: 'a'.repeat(64), target: f.draft.target, beforeDigest: require('node:crypto').createHash('sha256').update('# 原文\n').digest('hex'), afterDigest: require('node:crypto').createHash('sha256').update(f.draft.content).digest('hex'), status: 'unknown' },
  });
  const state = await f.updater.inspect({ id: f.draft.id, revision: f.draft.revision, requestId: input.requestId });
  assert.equal(state.status, 'matches_after');
  await f.updater.recover({ id: f.draft.id, revision: f.draft.revision, requestId: input.requestId, confirmed: true });
  assert.equal(f.store.list().drafts[0].updateLock, undefined);
  assert.deepEqual(f.store.list().knowledgeEntries.map(({ path, origins }) => ({ path, origins })), [{ path: f.draft.target, origins: ['linked'] }]);
  assert.equal(f.getBridgeCalls(), 0);
  assert.equal(f.getNote(), f.draft.content);
  assert.equal(typeof preview.confirmation, 'string');
});

test('准备阶段核查识别未发送并可在进程退出后恢复', async (t) => {
  const f = fixture(t); const crypto = require('node:crypto');
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', '']);
  const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
  f.store.beginDraftUpdate({ id: f.draft.id, revision: f.draft.revision, target: f.draft.target, content: f.draft.content, updateLock: { requestId: 'prepare', ownerPid: child.pid, vaultId: 'a'.repeat(64), target: f.draft.target, beforeDigest: digest('# 原文\n'), afterDigest: digest(f.draft.content), status: 'preparing', lockId: 'c'.repeat(32) } });
  const input = { id: f.draft.id, revision: f.draft.revision, requestId: 'prepare' };
  assert.deepEqual(await f.updater.inspect(input), { status: 'not_sent', bridgeStatus: 'not_sent', remoteStatus: 'not_sent', recoverable: true });
  await f.updater.recover({ ...input, confirmed: true });
  assert.equal(f.getBridgeCalls(), 0);
  assert.equal(f.store.list().drafts[0].updateLock, undefined);
  assert.deepEqual(f.store.list().knowledgeEntries, []);
});

test('清理列表限定当前知识库，确认清理不调用笔记写入', async (t) => {
  const f = fixture(t);
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, requestId: 'cleanup' };
  const preview = f.updater.preview(input);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) { if (typeof file === 'string' && file.startsWith(f.guardDirectory) && file.endsWith('.lock')) throw new Error('模拟清理失败'); return unlink.call(this, file, ...args); };
  let result;
  try { result = await f.updater.submit({ ...input, confirmation: preview.confirmation, confirmed: true }); } finally { fs.unlinkSync = unlink; }
  assert.equal(result.cleanupPending, true);
  const [pending] = f.updater.listCleanups();
  assert.equal(pending.target, f.draft.target);
  assert.throws(() => f.updater.cleanup({ lockId: pending.lockId, confirmed: false }), /明确确认/);
  f.setVault('b'.repeat(64));
  assert.deepEqual(f.updater.listCleanups(), []);
  assert.throws(() => f.updater.cleanup({ lockId: pending.lockId, confirmed: true }), /知识库/);
  f.setVault('a'.repeat(64));
  assert.deepEqual(f.updater.cleanup({ lockId: pending.lockId, confirmed: true }), { cleaned: true });
  assert.equal(f.getBridgeCalls(), 1);
  assert.deepEqual(f.updater.listCleanups(), []);
});
