const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../src/core.cjs');
const { createDraftPublisher } = require('../src/draft-publish.cjs');
const { createDraftNoteUpdater } = require('../src/draft-note-update.cjs');
const { createPendingNoteLinks } = require('../src/pending-note-links.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'state'); const guardDirectory = path.join(root, 'guard'); fs.mkdirSync(guardDirectory);
  const store = new LocalStore(directory); const vaultId = 'a'.repeat(64);
  const issue = { environment: 'env', tenantId: 'tenant', projectId: 'project', issueId: 'issue', title: '工作项' };
  const draft = store.saveDraft({ title: '标题', target: 'note.md', content: '新正文', issue, sourceSession: { id: 'session', title: '会话' } });
  let content = '原正文'; let calls = 0; let currentVault = vaultId;
  const knowledgeStore = () => ({ read: () => ({ content }), create: ({ content: value }) => { calls++; content = value; return { revision: '1' }; } });
  const publisher = createDraftPublisher({ store, knowledgeStore, vaultId: () => currentVault });
  const updater = createDraftNoteUpdater({ store, directory: guardDirectory, knowledgeStore, currentVaultId: () => currentVault, processNote: async (_vault, _path, update) => { calls++; content = update(content); return { status: 'completed' }; } });
  const pending = createPendingNoteLinks({ store, knowledgeStore, currentVaultId: () => currentVault, reconcilePublications: () => publisher.reconcilePendingLinks() });
  return { root, store, draft, publisher, updater, pending, getCalls: () => calls, setContent: (value) => { content = value; }, setVault: (value) => { currentVault = value; } };
}

test('新建完成后草稿删除，重启仍可只关联且不重写笔记', (t) => {
  const f = fixture(t);
  const request = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, confirmed: true };
  assert.equal(f.publisher.publish(request).status, 'completed');
  f.store.deleteDraft(f.draft.id, f.draft.revision);
  const restartedStore = new LocalStore(f.store.directory);
  const publisher = createDraftPublisher({ store: restartedStore, knowledgeStore: () => ({ read: () => ({ content: f.draft.content }) }), vaultId: () => 'a'.repeat(64) });
  const pending = createPendingNoteLinks({ store: restartedStore, knowledgeStore: () => ({ read: () => ({ content: f.draft.content }) }), currentVaultId: () => 'a'.repeat(64), reconcilePublications: () => publisher.reconcilePendingLinks() });
  const [entry] = pending.list().items; assert.equal(entry.kind, 'create');
  assert.throws(() => pending.link({ id: entry.id, confirmed: false }), /确认/);
  assert.equal(pending.link({ id: entry.id, confirmed: true }).issue.issueId, 'issue');
  assert.equal(f.getCalls(), 1);
  assert.deepEqual(pending.list().items, []);
  assert.deepEqual(restartedStore.list().noteLinks[0].sourceSessions, [{ id: 'session', title: '会话' }]);
});

test('新建成功但索引提交失败，可从完成日志重建待关联记录', (t) => {
  const f = fixture(t);
  const rename = fs.renameSync; let commits = 0;
  fs.renameSync = function (from, to) { if (to === f.store.file && ++commits === 2) throw new Error('模拟索引提交失败'); return rename.call(this, from, to); };
  try { assert.throws(() => f.publisher.publish({ id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, confirmed: true }), /索引提交失败/); } finally { fs.renameSync = rename; }
  assert.equal(f.store.list().pendingNoteLinks.length, 0);
  assert.equal(f.pending.list().items.length, 1);
  assert.equal(f.getCalls(), 1);
});

test('新建写入后索引失败，旧关联入口先补记录并持久标记已处理', (t) => {
  const f = fixture(t); const rename = fs.renameSync; let commits = 0;
  fs.renameSync = function (from, to) { if (to === f.store.file && ++commits === 2) throw new Error('模拟索引提交失败'); return rename.call(this, from, to); };
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, confirmed: true };
  try { assert.throws(() => f.publisher.publish(input), /索引提交失败/); } finally { fs.renameSync = rename; }
  f.publisher.linkPublished(input);
  assert.deepEqual(f.pending.list().items, []);
  assert.equal(f.store.list().processedNoteLinks.length, 1);
  assert.equal(f.getCalls(), 1);
});

test('损坏发布日志逐条报告且不阻断其他待关联记录', (t) => {
  const f = fixture(t);
  f.publisher.publish({ id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, confirmed: true });
  const name = `${'f'.repeat(64)}.json`;
  fs.writeFileSync(path.join(f.store.directory, 'draft-publications', name), '{invalid');
  const result = f.pending.list();
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.warnings, [{ file: name, reason: '发布记录损坏或无法恢复' }]);
});

test('最后的处理容量由更新锁预留，新建不得越过预留', (t) => {
  const f = fixture(t); const crypto = require('node:crypto');
  f.store.transaction((state) => { state.processedNoteLinks = Array.from({ length: 99999 }, (_, index) => index.toString(16).padStart(64, '0')); });
  const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
  f.store.beginDraftUpdate({ id: f.draft.id, revision: f.draft.revision, target: f.draft.target, content: f.draft.content, updateLock: { requestId: 'reserved', ownerPid: process.pid, vaultId: 'a'.repeat(64), target: f.draft.target, beforeDigest: digest('原正文'), afterDigest: digest(f.draft.content), status: 'submitting' } });
  const other = f.store.saveDraft({ title: '另一个', target: 'other.md', content: '正文', issue: f.draft.issue });
  assert.throws(() => f.publisher.publish({ id: other.id, revision: other.revision, target: other.target, expectedContent: other.content, confirmed: true }), /容量不足/);
  assert.equal(f.getCalls(), 0);
  f.store.finishDraftUpdate({ id: f.draft.id, revision: f.draft.revision, requestId: 'reserved', outcome: 'not_written' });
  assert.equal(f.publisher.publish({ id: other.id, revision: other.revision, target: other.target, expectedContent: other.content, confirmed: true }).status, 'completed');
});

test('待关联队列满时新建和更新都在外部写入前拒绝', async (t) => {
  const f = fixture(t); const crypto = require('node:crypto'); const { issueKey } = require('../src/core.cjs');
  const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
  f.store.transaction((state) => {
    state.pendingNoteLinks = Array.from({ length: 10000 }, (_, index) => {
      const item = { kind: 'create', operationId: `op-${index}`, draftId: `draft-${index}`, revision: 1, target: 'note.md', vaultId: 'a'.repeat(64), contentDigest: digest('正文'), title: '标题', issue: f.draft.issue };
      return { ...item, id: digest(JSON.stringify([item.kind, item.operationId, item.draftId, item.revision, item.vaultId, item.target, item.contentDigest, issueKey(item.issue)])) };
    });
  });
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, requestId: 'full' };
  assert.throws(() => f.publisher.publish({ ...input, confirmed: true }), /容量不足/);
  const preview = f.updater.preview(input);
  await assert.rejects(f.updater.submit({ ...input, confirmation: preview.confirmation, confirmed: true }), /容量不足/);
  assert.equal(f.getCalls(), 0);
  assert.equal(f.store.list().publicationReservations.length, 0);
});

test('发布预留后中断可核查释放，未写日志时不会写入笔记', (t) => {
  const f = fixture(t); const transaction = f.store.transaction.bind(f.store); let calls = 0;
  f.store.transaction = (...args) => { if (++calls === 2) throw new Error('模拟中断'); return transaction(...args); };
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, confirmed: true };
  try { assert.throws(() => f.publisher.publish(input), /模拟中断/); } finally { f.store.transaction = transaction; }
  const [reservation] = f.publisher.listReservations();
  assert.equal(reservation.status, 'not_started');
  assert.throws(() => f.publisher.releaseReservation({ id: reservation.id, generation: reservation.generation, confirmed: false }), /明确确认/);
  assert.deepEqual(f.publisher.releaseReservation({ id: reservation.id, generation: reservation.generation, confirmed: true }), { released: true, status: 'not_started' });
  assert.equal(f.getCalls(), 0);
  assert.deepEqual(f.publisher.listReservations(), []);
});

test('预留核查释放后迟到的发布不得越过容量预留', (t) => {
  const f = fixture(t); const transaction = f.store.transaction.bind(f.store); let calls = 0;
  f.store.transaction = (...args) => {
    calls++;
    if (calls === 2) {
      const [reservation] = f.publisher.listReservations();
      f.publisher.releaseReservation({ id: reservation.id, generation: reservation.generation, confirmed: true });
    }
    return transaction(...args);
  };
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, confirmed: true };
  try { assert.throws(() => f.publisher.publish(input), /预留已变化/); } finally { f.store.transaction = transaction; }
  assert.equal(f.getCalls(), 0);
});

test('跨进程释放并重建同一预留后，旧代次不得使用新代次写入', async (t) => {
  const f = fixture(t); const signal = path.join(f.root, 'resume'); const wrote = path.join(f.root, 'wrote');
  const script = `
    const fs = require('node:fs');
    const { LocalStore } = require(process.argv[1]); const { createDraftPublisher } = require(process.argv[2]);
    const [directory, signal, wrote, id] = process.argv.slice(3);
    const store = new LocalStore(directory); const draft = store.list().drafts.find((item) => item.id === id);
    const transaction = store.transaction.bind(store); let count = 0;
    store.transaction = (...args) => { const result = transaction(...args); if (++count === 1) { process.send('reserved'); while (!fs.existsSync(signal)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } return result; };
    const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { fs.writeFileSync(wrote, 'written'); return { revision: '1' }; } }) });
    try { publisher.publish({ id, revision: draft.revision, target: draft.target, expectedContent: draft.content, confirmed: true }); process.send({ error: '未拒绝' }); }
    catch (error) { process.send({ error: error.message }); }
  `;
  const child = require('node:child_process').spawn(process.execPath, ['-e', script, require.resolve('../src/core.cjs'), require.resolve('../src/draft-publish.cjs'), f.store.directory, signal, wrote, f.draft.id], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', (code) => reject(new Error(`子进程提前退出: ${code}`))); });
  const [first] = f.publisher.listReservations();
  const snapshot = f.store.list().publicationReservations[0];
  f.publisher.releaseReservation({ id: first.id, generation: first.generation, confirmed: true });
  const nextGeneration = 'f'.repeat(32);
  f.store.transaction((state) => f.store.reservePublishedLink(state, snapshot, nextGeneration));
  fs.writeFileSync(signal, 'continue');
  const result = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  assert.match(result.error, /预留已变化/);
  await new Promise((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  assert.equal(fs.existsSync(wrote), false);
  const [second] = f.publisher.listReservations();
  assert.equal(second.id, first.id); assert.equal(second.generation, nextGeneration);
  assert.throws(() => f.publisher.releaseReservation({ id: first.id, generation: first.generation, confirmed: true }), /代次已变化/);
});

test('结果未知或损坏的发布日志不能释放容量预留', (t) => {
  const f = fixture(t); const transaction = f.store.transaction.bind(f.store); let calls = 0;
  f.store.transaction = (...args) => { if (++calls === 2) throw new Error('模拟中断'); return transaction(...args); };
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, confirmed: true };
  try { assert.throws(() => f.publisher.publish(input), /模拟中断/); } finally { f.store.transaction = transaction; }
  const [reservation] = f.publisher.listReservations();
  const root = path.join(f.store.directory, 'draft-publications'); fs.mkdirSync(root, { recursive: true });
  const name = require('node:crypto').createHash('sha256').update(JSON.stringify([f.draft.id, f.draft.revision])).digest('hex');
  fs.writeFileSync(path.join(root, `${name}.json`), '{invalid');
  assert.equal(f.publisher.listReservations()[0].status, 'unknown');
  assert.throws(() => f.publisher.releaseReservation({ id: reservation.id, generation: reservation.generation, confirmed: true }), /不能释放/);
  assert.equal(f.store.list().publicationReservations.length, 1);
});

test('目标已存在且索引提交失败时，可以核对记录并释放预留', (t) => {
  const f = fixture(t); const vaultId = 'a'.repeat(64);
  const publisher = createDraftPublisher({ store: f.store, vaultId: () => vaultId, knowledgeStore: () => ({ create: () => { const error = new Error('已存在'); error.code = 'EEXIST'; throw error; } }) });
  const rename = fs.renameSync; let commits = 0;
  fs.renameSync = function (from, to) { if (to === f.store.file && ++commits === 2) throw new Error('模拟索引提交失败'); return rename.call(this, from, to); };
  const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, confirmed: true };
  try { assert.throws(() => publisher.publish(input), /模拟索引提交失败/); } finally { fs.renameSync = rename; }
  const [reservation] = publisher.listReservations();
  assert.equal(reservation.status, 'not_written');
  assert.deepEqual(publisher.releaseReservation({ id: reservation.id, generation: reservation.generation, confirmed: true }), { released: true, status: 'not_written' });
});

test('更新完成后独立保存待关联，库或内容改变时拒绝', async (t) => {
  const f = fixture(t); const input = { id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, requestId: 'update' };
  const preview = f.updater.preview(input);
  assert.equal((await f.updater.submit({ ...input, confirmation: preview.confirmation, confirmed: true })).status, 'completed');
  f.store.deleteDraft(f.draft.id, f.draft.revision);
  const [entry] = f.pending.list().items; assert.equal(entry.kind, 'update');
  f.setVault('b'.repeat(64)); assert.deepEqual(f.pending.list().items, []);
  assert.throws(() => f.pending.link({ id: entry.id, confirmed: true }), /当前知识库/);
  f.setVault('a'.repeat(64)); f.setContent('外部修改');
  assert.throws(() => f.pending.link({ id: entry.id, confirmed: true }), /已变化/);
  f.setContent(f.draft.content); f.pending.link({ id: entry.id, confirmed: true });
  assert.equal(f.getCalls(), 1);
  assert.deepEqual(f.pending.list().items, []);
});

test('索引备份恢复待关联记录，不会丢失待办', (t) => {
  const f = fixture(t);
  f.publisher.publish({ id: f.draft.id, revision: f.draft.revision, target: f.draft.target, expectedContent: f.draft.content, confirmed: true });
  const backup = f.store.exportData();
  const restored = new LocalStore(path.join(f.root, 'restored'));
  const preview = restored.previewImport(backup);
  assert.equal(preview.counts.pendingNoteLinks, 1);
  restored.importData(backup, preview.token, {});
  assert.deepEqual(restored.list().pendingNoteLinks, backup.pendingNoteLinks);
});
