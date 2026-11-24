const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalStore } = require('../src/core.cjs');
const { createMarkdownStore } = require('../src/markdown-store.cjs');
const { createDraftPublisher } = require('../src/draft-publish.cjs');

function fixture(t, knowledgeFactory) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'draft-publish-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const vault = path.join(directory, 'vault'); fs.mkdirSync(vault);
  const store = new LocalStore(path.join(directory, 'state'));
  const draft = store.saveDraft({ id: 'draft-1', title: '标题', content: '# 内容\n\n正文\n', target: 'note.md' });
  const publisher = createDraftPublisher({ store, knowledgeStore: knowledgeFactory || (() => createMarkdownStore(vault)) });
  const request = { id: draft.id, revision: draft.revision, target: draft.target, expectedContent: draft.content, confirmed: true };
  return { directory, vault, store, draft, publisher, request };
}

test('原知识库存在未知更新锁时切换知识库也不能新建，不调用适配器', (t) => {
  const { store, draft } = fixture(t);
  const digest = (content) => crypto.createHash('sha256').update(content).digest('hex');
  store.beginDraftUpdate({ id: draft.id, revision: draft.revision, target: draft.target, content: draft.content, updateLock: { requestId: 'cross-vault', ownerPid: process.pid, vaultId: 'a'.repeat(64), target: draft.target, beforeDigest: digest('旧内容'), afterDigest: digest(draft.content), status: 'unknown' } });
  let calls = 0;
  const publisher = createDraftPublisher({ store, vaultId: () => 'b'.repeat(64), knowledgeStore: () => { calls++; return { create() { calls++; } }; } });
  assert.throws(() => publisher.publish({ id: draft.id, revision: draft.revision, target: draft.target, expectedContent: draft.content, confirmed: true }), /核对完成前不能发布/);
  assert.equal(calls, 0);
  assert.equal(store.list().publicationReservations.length, 0);
  assert.equal(store.list().knowledgeReservations.length, 0);
  assert.equal(store.list().drafts[0].updateLock.vaultId, 'a'.repeat(64));
});

test('多工作项发布生成独立待办，逐项确认且旧无参入口拒绝歧义', (t) => {
  const { store, vault } = fixture(t);
  const issues = ['1', '2'].map((issueId) => ({ environment: 'https://example.test', tenantId: '1', projectId: '2', issueId }));
  const d = store.saveDraft({ title: '多项', content: '正文', target: 'multi.md', issues });
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => createMarkdownStore(vault) });
  const request = { id: d.id, revision: d.revision, target: d.target, expectedContent: d.content, confirmed: true };
  assert.equal(publisher.publish(request).status, 'completed');
  assert.equal(store.list().pendingNoteLinks.length, 2);
  assert.throws(() => publisher.linkPublished(request), /指定/);
  publisher.linkPublished({ ...request, issue: issues[1] });
  assert.equal(store.list().pendingNoteLinks.length, 1);
  store.transaction((state) => { state.pendingNoteLinks = []; });
  const restarted = createDraftPublisher({ store: new LocalStore(store.directory), vaultId: () => 'a'.repeat(64), knowledgeStore: () => createMarkdownStore(vault) });
  assert.deepEqual(restarted.reconcilePendingLinks(), []);
  assert.equal(store.list().pendingNoteLinks.length, 1);
  assert.equal(store.list().pendingNoteLinks[0].issue.issueId, '1');
  publisher.linkPublished({ ...request, issue: issues[0] });
  assert.equal(store.list().noteLinks.length, 2);
  const transact = store.transaction;
  store.transaction = () => { throw new Error('不应重写已知索引'); };
  try { assert.deepEqual(publisher.reconcilePendingLinks(), []); } finally { store.transaction = transact; }
  const third = { ...issues[0], issueId: '3' };
  store.transaction((state) => { const draft = state.drafts.find((item) => item.id === d.id); draft.issues.push(third); });
  assert.throws(() => publisher.linkPublished({ ...request, issue: third }), /无法确认/);
  const record = publisher.get(d.id, d.revision, d.target, d.content);
  delete record.pendingLinks;
  const recordName = crypto.createHash('sha256').update(JSON.stringify([d.id, d.revision])).digest('hex');
  fs.writeFileSync(path.join(store.directory, 'draft-publications', `${recordName}.json`), JSON.stringify(record));
  assert.equal(publisher.reconcilePendingLinks().length, 1);
  assert.throws(() => publisher.linkPublished({ ...request, issue: issues[0] }), /无法恢复/);
});

test('旧单项 pendingLink 完成日志仍能恢复和无参确认关联', (t) => {
  const { store, vault } = fixture(t);
  const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '1' };
  const d = store.saveDraft({ title: '旧单项', content: '正文', target: 'legacy.md', issue });
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => createMarkdownStore(vault) });
  const request = { id: d.id, revision: d.revision, target: d.target, expectedContent: d.content, confirmed: true };
  const record = publisher.publish(request);
  record.pendingLink = record.pendingLinks[0]; record.issueKey = record.issueKeys[0];
  delete record.pendingLinks; delete record.issueKeys;
  const name = crypto.createHash('sha256').update(JSON.stringify([d.id, d.revision])).digest('hex');
  fs.writeFileSync(path.join(store.directory, 'draft-publications', `${name}.json`), JSON.stringify(record));
  store.transaction((state) => { state.pendingNoteLinks = []; });
  assert.deepEqual(publisher.reconcilePendingLinks(), []);
  assert.equal(store.list().pendingNoteLinks.length, 1);
  assert.equal(publisher.linkPublished(request).issue.issueId, '1');
});

test('多项未知结果处置前一项不释放共享目录预留，混合选择保留 linked', (t) => {
  const { store, vault } = fixture(t);
  const issues = ['1', '2'].map((issueId) => ({ environment: 'https://example.test', tenantId: '1', projectId: '2', issueId }));
  const d = store.saveDraft({ title: '多项', content: '正文', target: 'multi.md', issues });
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create() { fs.writeFileSync(path.join(vault, 'multi.md'), '正文'); throw new Error('未知'); }, read: (target) => createMarkdownStore(vault).read(target) }) });
  assert.equal(publisher.publish({ id: d.id, revision: d.revision, target: d.target, expectedContent: d.content, confirmed: true }).status, 'unknown');
  const [first, second] = publisher.listReservations();
  publisher.resolveUncertainReservation({ ...first, confirmed: true, acceptUncertain: true, decision: 'link' });
  assert.equal(store.list().knowledgeReservations.length, 1);
  publisher.resolveUncertainReservation({ ...second, confirmed: true, acceptUncertain: true, decision: 'discard' });
  assert.equal(store.list().knowledgeReservations.length, 0);
  assert.equal(store.list().noteLinks.length, 1);
  assert.ok(store.list().knowledgeEntries[0].origins.includes('linked'));
});

test('多项处置索引失败不会把其他项误报成功，可按项重新选择', (t) => {
  const { store } = fixture(t);
  const issues = ['1', '2'].map((issueId) => ({ environment: 'https://example.test', tenantId: '1', projectId: '2', issueId }));
  const d = store.saveDraft({ title: '多项', content: '正文', target: 'multi.md', issues });
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create() { throw new Error('未知'); } }) });
  publisher.publish({ id: d.id, revision: d.revision, target: d.target, expectedContent: d.content, confirmed: true });
  const [first, second] = publisher.listReservations();
  const action = { confirmed: true, acceptUncertain: true, decision: 'discard' };
  publisher.resolveUncertainReservation({ ...first, ...action });
  const resolve = store.resolveUncertainReservation;
  store.resolveUncertainReservation = () => { throw new Error('模拟索引失败'); };
  assert.throws(() => publisher.resolveUncertainReservation({ ...second, ...action }), /模拟索引失败/);
  store.resolveUncertainReservation = resolve;
  assert.equal(publisher.inspectReservationResolution(first).status, 'resolved');
  assert.equal(publisher.inspectReservationResolution(second).status, 'pending');
  assert.equal(store.list().knowledgeReservations.length, 1);
  publisher.resolveUncertainReservation({ ...second, ...action });
  assert.equal(publisher.inspectReservationResolution(second).status, 'resolved');
  assert.equal(store.list().knowledgeReservations.length, 0);
});

test('只读预览已有笔记与草稿的变化并校验草稿版本和目标', (t) => {
  const { publisher, request, vault, draft } = fixture(t);
  const file = path.join(vault, 'note.md');
  fs.writeFileSync(file, '# 内容\n\n旧正文\n');
  const preview = publisher.previewUpdate(request);
  assert.equal(preview.beforeContent, '# 内容\n\n旧正文\n');
  assert.equal(preview.startLine, 3);
  assert.equal(preview.removed, '旧正文');
  assert.equal(preview.added, '正文');
  assert.equal(preview.unchanged, false);
  assert.equal(preview.noteRevision, crypto.createHash('sha256').update('# 内容\n\n旧正文\n').digest('hex'));
  assert.equal(fs.readFileSync(file, 'utf8'), '# 内容\n\n旧正文\n');
  assert.throws(() => publisher.previewUpdate({ ...request, revision: 2 }), /变化/);
  assert.throws(() => publisher.previewUpdate({ ...request, target: 'other.md' }), /变化/);
  assert.throws(() => publisher.previewUpdate({ ...request, expectedContent: '过期内容' }), /变化/);
  fs.writeFileSync(file, draft.content);
  const same = publisher.previewUpdate(request);
  assert.equal(same.beforeContent, draft.content);
  assert.equal(same.unchanged, true);
  assert.equal(same.removed, '');
  assert.equal(same.added, '');
  assert.equal(fs.readFileSync(file, 'utf8'), draft.content);
  fs.unlinkSync(file);
  assert.throws(() => publisher.previewUpdate(request));
});

test('写入草稿须确认且版本、目标一致，重复提交不能覆盖', (t) => {
  const { publisher, request, vault, store } = fixture(t);
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent), null);
  assert.throws(() => publisher.publish({ ...request, confirmed: false }), /确认/);
  assert.throws(() => publisher.publish({ ...request, revision: 2 }), /修改/);
  assert.throws(() => publisher.publish({ ...request, target: 'other.md' }), /目标/);
  assert.throws(() => publisher.publish({ ...request, expectedContent: '不同的正文' }), /内容已变化/);
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent), null);
  assert.equal(publisher.publish(request).status, 'completed');
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), '# 内容\n\n正文\n');
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent).status, 'completed');
  assert.equal(publisher.get(request.id, request.revision, request.target, '其他正文').status, 'conflict');
  assert.equal(publisher.get(request.id, request.revision, 'other.md', request.expectedContent).status, 'conflict');
  assert.throws(() => publisher.publish(request), /不能重复/);
  assert.equal(store.list().drafts.length, 1);
});

for (const status of ['deferred', 'discarded']) {
  test(`${status} 草稿须恢复待确认后才能以新版本发布`, (t) => {
    let adapterCalls = 0;
    const { publisher, request, vault, store, draft, directory } = fixture(t, () => {
      adapterCalls++;
      return createMarkdownStore(vault);
    });
    const paused = store.saveDraft({ ...draft, status }, { expectedRevision: draft.revision });
    const pausedRequest = { ...request, revision: paused.revision };
    const indexBefore = fs.readFileSync(store.file, 'utf8');
    assert.throws(() => publisher.publish(pausedRequest), /先恢复为待确认/);
    assert.equal(adapterCalls, 0);
    assert.equal(fs.existsSync(path.join(vault, 'note.md')), false);
    assert.equal(fs.existsSync(path.join(directory, 'state', 'draft-publications')), false);
    assert.equal(fs.readFileSync(store.file, 'utf8'), indexBefore);
    const restored = store.saveDraft({ ...paused, status: 'pending' }, { expectedRevision: paused.revision });
    assert.throws(() => publisher.publish(pausedRequest), /已被修改/);
    assert.equal(publisher.publish({ ...pausedRequest, revision: restored.revision }).status, 'completed');
    assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), draft.content);
  });
}

test('已有目标不会覆盖且记录冲突', (t) => {
  const { publisher, request, vault } = fixture(t);
  fs.writeFileSync(path.join(vault, 'note.md'), '已有内容');
  assert.equal(publisher.publish(request).status, 'target_exists');
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent).status, 'target_exists');
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), '已有内容');
  assert.throws(() => publisher.publish(request), /不能重复/);
});

test('草稿删除后同 ID 同版本重建，旧预览不能写入新正文', (t) => {
  const { store, draft, request, publisher, vault } = fixture(t);
  store.deleteDraft(draft.id, draft.revision);
  store.saveDraft({ id: draft.id, title: '新草稿', content: '新正文', target: draft.target });
  assert.throws(() => publisher.publish(request), /内容已变化/);
  assert.equal(fs.existsSync(path.join(vault, request.target)), false);
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent), null);
});

test('写入结果不确定时保留记录，不自动再次执行', (t) => {
  let calls = 0;
  const { publisher, request } = fixture(t, () => ({ create: () => { calls++; throw new Error('unknown'); } }));
  assert.equal(publisher.publish(request).status, 'unknown');
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent).status, 'unknown');
  assert.throws(() => publisher.publish(request), /不能重复/);
  assert.equal(calls, 1);
});

test('独立草稿发布登记知识目录，索引失败后从完成日志恢复且不重写', (t) => {
  const { store, draft, vault, request } = fixture(t);
  let writes = 0;
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: (args) => { writes++; return createMarkdownStore(vault).create(args); } }) });
  const rename = fs.renameSync; let commits = 0;
  fs.renameSync = function (from, to) { if (to === store.file && ++commits === 2) throw new Error('模拟索引提交失败'); return rename.call(this, from, to); };
  try { assert.throws(() => publisher.publish(request), /模拟索引提交失败/); } finally { fs.renameSync = rename; }
  assert.equal(store.list().knowledgeEntries.length, 0);
  assert.equal(publisher.listKnowledgeReservations()[0].status, 'completed');
  store.deleteDraft(draft.id, draft.revision);
  assert.deepEqual(publisher.reconcileKnowledgeEntries(), []);
  assert.equal(store.list().knowledgeEntries[0].path, 'note.md');
  assert.deepEqual(store.list().knowledgeEntries[0].origins, ['created']);
  assert.equal(store.list().knowledgeReservations.length, 0);
  assert.equal(writes, 1);
});

test('完成日志截断或绑定摘要被篡改时不能恢复知识目录', (t) => {
  const { store, vault, request } = fixture(t);
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => createMarkdownStore(vault) });
  const rename = fs.renameSync; let commits = 0;
  fs.renameSync = function (from, to) { if (to === store.file && ++commits === 2) throw new Error('模拟索引提交失败'); return rename.call(this, from, to); };
  try { assert.throws(() => publisher.publish(request), /模拟索引提交失败/); } finally { fs.renameSync = rename; }
  const [entry] = publisher.listKnowledgeReservations();
  const file = path.join(store.directory, 'draft-publications', `${entry.operationId}.json`);
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const falseDigest = 'f'.repeat(64);
  for (const damaged of ['{', JSON.stringify({ ...original, revision: '1' }), JSON.stringify({ ...original, contentDigest: falseDigest }), JSON.stringify({ ...original, noteRevision: '0'.repeat(64) }), JSON.stringify({ ...original, contentDigest: falseDigest, noteRevision: falseDigest, knowledgeEntry: { ...original.knowledgeEntry, contentDigest: falseDigest } }), JSON.stringify({ ...original, knowledgeEntry: { ...original.knowledgeEntry, title: '错误' } })]) {
    fs.writeFileSync(file, damaged);
    assert.equal(publisher.listKnowledgeReservations()[0].status, 'unknown');
    publisher.reconcileKnowledgeEntries();
    assert.equal(store.list().knowledgeEntries.length, 0);
    assert.equal(store.list().knowledgeReservations.length, 1);
  }
});

test('独立草稿未知结果保留预留，不能仅凭目标内容自动登记或释放', (t) => {
  const { store, draft, vault, request } = fixture(t);
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { throw new Error('未知'); } }) });
  assert.equal(publisher.publish(request).status, 'unknown');
  fs.writeFileSync(path.join(vault, 'note.md'), draft.content);
  const [reservation] = publisher.listKnowledgeReservations();
  assert.equal(reservation.status, 'unknown');
  assert.deepEqual(publisher.reconcileKnowledgeEntries(), [{ operationId: reservation.operationId, reason: '知识目录预留尚未完成，请核查' }]);
  assert.equal(store.list().knowledgeEntries.length, 0);
  assert.throws(() => publisher.releaseKnowledgeReservation({ ...reservation, confirmed: true }), /无法证明/);
  assert.throws(() => publisher.publish(request), /不能重复/);
});

test('知识目录恢复仅处理当前知识库，不泄露其他库的待办', (t) => {
  const { store, request } = fixture(t);
  let currentVault = 'a'.repeat(64);
  const publisher = createDraftPublisher({ store, vaultId: () => currentVault, knowledgeStore: () => ({ create: () => { throw new Error('未知'); } }) });
  publisher.publish(request);
  const first = publisher.listKnowledgeReservations()[0];
  const other = store.saveDraft({ title: '另一库', content: '内容', target: 'other.md' });
  currentVault = 'b'.repeat(64);
  publisher.publish({ id: other.id, revision: other.revision, target: other.target, expectedContent: other.content, confirmed: true });
  const second = publisher.listKnowledgeReservations()[0];
  assert.deepEqual(publisher.reconcileKnowledgeEntries(), [{ operationId: second.operationId, reason: '知识目录预留尚未完成，请核查' }]);
  currentVault = 'a'.repeat(64);
  assert.deepEqual(publisher.reconcileKnowledgeEntries(), [{ operationId: first.operationId, reason: '知识目录预留尚未完成，请核查' }]);
});

test('草稿恢复入口不读取或处置直接创建预留及缺少绑定的旧预留', (t) => {
  const { store, request } = fixture(t);
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { throw new Error('未知'); } }) });
  publisher.publish(request);
  const state = store.list();
  const legacy = state.knowledgeReservations[0];
  delete legacy.kind; delete legacy.contentDigest;
  fs.writeFileSync(store.file, JSON.stringify(state));
  const direct = { kind: 'direct', operationId: 'f'.repeat(64), vaultId: 'a'.repeat(64), path: 'direct.md', title: '直接创建', contentDigest: 'e'.repeat(64) };
  store.transaction((current) => store.reserveKnowledgeEntry(current, direct, 'c'.repeat(32)));
  assert.deepEqual(publisher.listKnowledgeReservations(), []);
  assert.deepEqual(publisher.reconcileKnowledgeEntries(), []);
  assert.throws(() => publisher.releaseKnowledgeReservation({ operationId: direct.operationId, generation: 'c'.repeat(32), confirmed: true }), /不存在|不属于/);
  assert.throws(() => publisher.resolveKnowledgeReservation({ operationId: direct.operationId, generation: 'c'.repeat(32), confirmed: true, acceptUncertain: true, decision: 'discard' }), /不存在|不属于/);
  assert.equal(store.list().knowledgeReservations.length, 2);
});

test('关联工作项的草稿预留不能从独立知识入口绕过工作项授权', (t) => {
  const { store, draft } = fixture(t);
  const linked = store.saveDraft({ ...draft, issue: { environment: 'env', tenantId: '1', projectId: '2', issueId: '3' } }, { expectedRevision: draft.revision });
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { throw new Error('未知'); } }) });
  publisher.publish({ id: linked.id, revision: linked.revision, target: linked.target, expectedContent: linked.content, confirmed: true });
  const [entry] = store.list().knowledgeReservations;
  assert.deepEqual(publisher.listKnowledgeReservations(), []);
  assert.throws(() => publisher.resolveKnowledgeReservation({ operationId: entry.operationId, generation: entry.generation, decision: 'discard', acceptUncertain: true, confirmed: true }), /工作项处置/);
  assert.equal(store.list().publicationReservations.length, 1);
});

for (const decision of ['link', 'discard']) test(`独立草稿未知结果需明确确认后${decision === 'link' ? '关联' : '放弃'}，持久查询不推断写入来源`, (t) => {
  const { store, draft, vault, request } = fixture(t);
  let writes = 0;
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { writes++; throw new Error('未知'); }, read: (target) => createMarkdownStore(vault).read(target) }) });
  assert.equal(publisher.publish(request).status, 'unknown');
  const [reservation] = publisher.listKnowledgeReservations();
  const input = { operationId: reservation.operationId, generation: reservation.generation, decision, acceptUncertain: true, confirmed: true };
  assert.throws(() => publisher.resolveKnowledgeReservation({ ...input, confirmed: false }), /明确/);
  if (decision === 'link') {
    assert.throws(() => publisher.resolveKnowledgeReservation(input));
    fs.writeFileSync(path.join(vault, 'note.md'), '不同内容');
    assert.throws(() => publisher.resolveKnowledgeReservation(input), /已变化/);
    fs.writeFileSync(path.join(vault, 'note.md'), draft.content);
  }
  assert.equal(publisher.inspectKnowledgeResolution(input).status, 'pending');
  assert.equal(publisher.resolveKnowledgeReservation(input).writeStatus, 'unknown');
  assert.deepEqual(store.list().knowledgeEntries.map((entry) => entry.origins), decision === 'link' ? [['linked']] : []);
  assert.equal(publisher.inspectKnowledgeResolution(input).decision, decision);
  assert.equal(publisher.inspectKnowledgeResolution(input).status, 'resolved');
  assert.throws(() => publisher.publish(request), /不能重复/);
  assert.equal(writes, 1);
});

test('独立草稿处置意向已记但索引失败时保持待办并可重新选择', (t) => {
  const { store, draft, vault, request } = fixture(t);
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { throw new Error('未知'); }, read: (target) => createMarkdownStore(vault).read(target) }) });
  publisher.publish(request);
  fs.writeFileSync(path.join(vault, 'note.md'), draft.content);
  const [entry] = publisher.listKnowledgeReservations();
  const input = { operationId: entry.operationId, generation: entry.generation, decision: 'link', acceptUncertain: true, confirmed: true };
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) { if (to === store.file) throw new Error('模拟索引失败'); return rename.call(this, from, to); };
  try { assert.throws(() => publisher.resolveKnowledgeReservation(input), /模拟索引失败/); } finally { fs.renameSync = rename; }
  assert.equal(publisher.inspectKnowledgeResolution(input).status, 'pending');
  fs.writeFileSync(path.join(vault, 'note.md'), '已修改');
  assert.throws(() => publisher.resolveKnowledgeReservation(input), /已变化/);
  assert.equal(publisher.resolveKnowledgeReservation({ ...input, decision: 'discard' }).decision, 'discard');
  assert.equal(publisher.inspectKnowledgeResolution(input).decision, 'discard');
});

test('独立草稿写入前中断可核查并释放预留，再次发布须重新确认', (t) => {
  const { store, vault, request } = fixture(t);
  let writes = 0; const original = store.transaction.bind(store); let calls = 0;
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: (args) => { writes++; return createMarkdownStore(vault).create(args); } }) });
  store.transaction = (fn, capability) => {
    if (++calls === 2) throw new Error('模拟中断');
    return original(fn, capability);
  };
  try { assert.throws(() => publisher.publish(request), /模拟中断/); } finally { store.transaction = original; }
  const [entry] = publisher.listKnowledgeReservations();
  assert.equal(entry.status, 'not_started');
  assert.throws(() => publisher.releaseKnowledgeReservation({ ...entry, confirmed: false }), /确认/);
  assert.deepEqual(publisher.releaseKnowledgeReservation({ ...entry, confirmed: true }), { released: true, status: 'not_started' });
  assert.equal(writes, 0);
  assert.equal(publisher.publish(request).status, 'completed');
  assert.equal(writes, 1);
});

test('目标已存在但终态日志持久化失败时保留预留并报告未知', (t) => {
  const { store, request } = fixture(t);
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { const error = new Error('已存在'); error.code = 'EEXIST'; throw error; } }) });
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) { if (path.basename(from).startsWith('.publication-')) throw new Error('模拟终态写入失败'); return rename.call(this, from, to); };
  try { assert.equal(publisher.publish(request).status, 'unknown'); } finally { fs.renameSync = rename; }
  const [entry] = publisher.listKnowledgeReservations();
  assert.equal(entry.status, 'unknown');
  assert.throws(() => publisher.releaseKnowledgeReservation({ ...entry, confirmed: true }), /无法证明/);
  assert.equal(store.list().knowledgeEntries.length, 0);
  assert.throws(() => publisher.publish(request), /不能重复/);
});

test('不确定的写入只读核对目标内容，不改变记录或重复写入', (t) => {
  const { store, draft, vault, request } = fixture(t);
  let currentVault = 'a'.repeat(64); let writes = 0;
  const publisher = createDraftPublisher({ store, vaultId: () => currentVault, knowledgeStore: () => ({
    create: () => { writes++; throw new Error('结果未知'); },
    read: (target) => createMarkdownStore(vault).read(target),
  }) });
  assert.equal(publisher.publish(request).status, 'unknown');
  assert.deepEqual(publisher.inspectUncertain(request), { status: 'unavailable' });
  fs.writeFileSync(path.join(vault, 'note.md'), '不同内容');
  assert.deepEqual(publisher.inspectUncertain(request), { status: 'differs' });
  fs.writeFileSync(path.join(vault, 'note.md'), draft.content);
  assert.deepEqual(publisher.inspectUncertain(request), { status: 'matches' });
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent).status, 'unknown');
  assert.equal(writes, 1);
  currentVault = 'b'.repeat(64);
  assert.throws(() => publisher.inspectUncertain(request), /知识库与提交时不同/);
  assert.throws(() => publisher.inspectUncertain({ ...request, expectedContent: '不同' }), /草稿或目标已变化/);
});

test('人工处置未知结果须明确确认，放弃后仍阻止重复发布', (t) => {
  const { store, draft, vault } = fixture(t);
  const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '3', title: '工作项' };
  const linkedDraft = store.saveDraft({ ...draft, issue }, { expectedRevision: draft.revision });
  let currentVault = 'a'.repeat(64); let writes = 0;
  const publisher = createDraftPublisher({ store, vaultId: () => currentVault, knowledgeStore: () => ({ create: () => { writes++; throw new Error('结果未知'); }, read: () => createMarkdownStore(vault).read('note.md') }) });
  const request = { id: linkedDraft.id, revision: linkedDraft.revision, target: linkedDraft.target, expectedContent: linkedDraft.content, confirmed: true };
  assert.equal(publisher.publish(request).status, 'unknown');
  const reservation = publisher.listReservations()[0];
  assert.equal(reservation.status, 'unknown');
  assert.equal(reservation.issue.issueId, '3');
  const action = { id: reservation.id, generation: reservation.generation, confirmed: true, acceptUncertain: true, decision: 'discard' };
  assert.throws(() => publisher.resolveUncertainReservation({ ...action, acceptUncertain: false }), /人工检查/);
  assert.throws(() => publisher.resolveUncertainReservation({ ...action, generation: 'b'.repeat(32) }), /代次/);
  currentVault = 'b'.repeat(64);
  assert.throws(() => publisher.resolveUncertainReservation(action), /知识库/);
  currentVault = 'a'.repeat(64);
  assert.deepEqual(publisher.resolveUncertainReservation(action), { resolved: true, status: 'unknown', decision: 'discard', association: null });
  assert.equal(store.list().publicationReservations.length, 0);
  assert.equal(store.list().pendingNoteLinks.length, 0);
  assert.equal(store.list().noteLinks.length, 0);
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent).status, 'unknown');
  assert.throws(() => publisher.publish(request), /不能重复/);
  assert.equal(writes, 1);
});

test('未知预留的提交记录损坏时不能通过人工确认释放', (t) => {
  const { store, draft, directory } = fixture(t);
  const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '3' };
  const linkedDraft = store.saveDraft({ ...draft, issue }, { expectedRevision: draft.revision });
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { throw new Error('未知'); } }) });
  const request = { id: linkedDraft.id, revision: linkedDraft.revision, target: linkedDraft.target, expectedContent: linkedDraft.content, confirmed: true };
  publisher.publish(request);
  const reservation = publisher.listReservations()[0];
  const name = crypto.createHash('sha256').update(JSON.stringify([request.id, request.revision])).digest('hex');
  fs.writeFileSync(path.join(directory, 'state', 'draft-publications', `${name}.json`), '{');
  assert.throws(() => publisher.resolveUncertainReservation({ id: reservation.id, generation: reservation.generation, confirmed: true, acceptUncertain: true, decision: 'discard' }), /记录损坏/);
  assert.equal(store.list().publicationReservations.length, 1);
});

test('未知结果明确关联前必须核对笔记内容，关联不改变未知状态', (t) => {
  const { store, draft, vault } = fixture(t);
  const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '3' };
  const linked = store.saveDraft({ ...draft, issue }, { expectedRevision: draft.revision });
  let writes = 0;
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { writes++; throw new Error('未知'); }, read: (target) => createMarkdownStore(vault).read(target) }) });
  const request = { id: linked.id, revision: linked.revision, target: linked.target, expectedContent: linked.content, confirmed: true };
  publisher.publish(request);
  const reservation = publisher.listReservations()[0];
  const action = { id: reservation.id, generation: reservation.generation, confirmed: true, acceptUncertain: true, decision: 'link' };
  fs.writeFileSync(path.join(vault, 'note.md'), '不同');
  assert.throws(() => publisher.resolveUncertainReservation(action), /不一致/);
  assert.equal(publisher.listReservations().length, 1);
  fs.writeFileSync(path.join(vault, 'note.md'), linked.content);
  const result = publisher.resolveUncertainReservation(action);
  assert.equal(result.status, 'unknown'); assert.equal(result.association.issue.issueId, '3');
  assert.equal(store.list().noteLinks.length, 1);
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent).status, 'unknown');
  assert.equal(writes, 1);
});

test('处置意向持久化后索引提交失败可核查并重新选择', (t) => {
  const { store, draft, vault } = fixture(t);
  const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '3' };
  const linked = store.saveDraft({ ...draft, issue }, { expectedRevision: draft.revision });
  const publisher = createDraftPublisher({ store, vaultId: () => 'a'.repeat(64), knowledgeStore: () => ({ create: () => { throw new Error('未知'); }, read: (target) => createMarkdownStore(vault).read(target) }) });
  const request = { id: linked.id, revision: linked.revision, target: linked.target, expectedContent: linked.content, confirmed: true };
  publisher.publish(request);
  fs.writeFileSync(path.join(vault, 'note.md'), linked.content);
  const reservation = publisher.listReservations()[0];
  const action = { id: reservation.id, generation: reservation.generation, confirmed: true, acceptUncertain: true, decision: 'link' };
  const resolve = store.resolveUncertainReservation;
  store.resolveUncertainReservation = () => { throw new Error('模拟索引失败'); };
  assert.throws(() => publisher.resolveUncertainReservation(action), /模拟索引失败/);
  store.resolveUncertainReservation = resolve;
  assert.equal(publisher.listReservations().length, 1);
  assert.deepEqual(publisher.inspectUncertainResolution(request), { status: 'pending', writeStatus: 'unknown' });
  fs.writeFileSync(path.join(vault, 'note.md'), '外部更改');
  assert.throws(() => publisher.resolveUncertainReservation(action), /不一致/);
  assert.equal(publisher.resolveUncertainReservation({ ...action, decision: 'discard' }).status, 'unknown');
  assert.deepEqual(publisher.inspectUncertainResolution(request), { status: 'resolved', decision: 'discard', writeStatus: 'unknown' });
  store.deleteDraft(linked.id, linked.revision);
  const independent = publisher.inspectReservationResolution({ id: reservation.id, generation: reservation.generation });
  assert.equal(independent.decision, 'discard'); assert.equal(independent.status, 'resolved');
  assert.equal(independent.issue.issueId, '3'); assert.equal(independent.vaultId, 'a'.repeat(64));
  assert.throws(() => publisher.inspectReservationResolution({ id: reservation.id, generation: 'b'.repeat(32) }), /不存在/);
  const otherVault = createDraftPublisher({ store, vaultId: () => 'b'.repeat(64), knowledgeStore: () => createMarkdownStore(vault) });
  assert.throws(() => otherVault.inspectReservationResolution({ id: reservation.id, generation: reservation.generation }), /知识库/);
  const recordFile = path.join(store.directory, 'draft-publications', `${crypto.createHash('sha256').update(JSON.stringify([request.id, request.revision])).digest('hex')}.json`);
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  record.manualDisposition.type = 'link';
  fs.writeFileSync(recordFile, JSON.stringify(record));
  assert.deepEqual(publisher.inspectUncertainResolution(request), { status: 'resolved', decision: 'discard', writeStatus: 'unknown' });
  const backup = store.exportData();
  const conflict = structuredClone(backup); conflict.uncertainResolutions[0].decision = 'link';
  assert.throws(() => store.previewImport(conflict), /处置记录冲突/);
  assert.equal(store.list().noteLinks.length, 0);
});

test('缺少原知识库标识的历史记录不自动核对', (t) => {
  const { publisher, request } = fixture(t, () => ({ create: () => { throw new Error('unknown'); } }));
  publisher.publish(request);
  assert.throws(() => publisher.inspectUncertain(request), /无法核实/);
});

test('疑似凭据阻止写入且不生成提交记录或在结果中回显', (t) => {
  const { publisher, store, draft, vault } = fixture(t);
  const secret = 'example' + '123456789';
  const updated = store.saveDraft({ ...draft, content: `password=${secret}` }, { expectedRevision: draft.revision });
  const request = { id: updated.id, revision: updated.revision, target: updated.target, expectedContent: updated.content, confirmed: true };
  const result = publisher.publish(request);
  assert.equal(result.status, 'sensitive_detected');
  assert.deepEqual(result.findings, ['密码或访问密钥']);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent), null);
  assert.equal(fs.existsSync(path.join(vault, request.target)), false);
});

test('写入前路径校验失败不生成提交记录，修复目录后可重试', (t) => {
  const { publisher, store, draft, vault } = fixture(t);
  const updated = store.saveDraft({ ...draft, target: 'missing/note.md' }, { expectedRevision: draft.revision });
  const request = { id: updated.id, revision: updated.revision, target: updated.target, expectedContent: updated.content, confirmed: true };
  assert.equal(publisher.publish(request).status, 'preflight_failed');
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent), null);
  fs.mkdirSync(path.join(vault, 'missing'));
  assert.equal(publisher.publish(request).status, 'completed');
  assert.equal(fs.readFileSync(path.join(vault, request.target), 'utf8'), request.expectedContent);
});

test('已有提交记录优先于写前校验，不能误报未写入', (t) => {
  let available = true;
  const { publisher, request } = fixture(t, () => {
    if (!available) throw new Error('不可用');
    return { create: () => ({ revision: 'hash' }) };
  });
  assert.equal(publisher.publish(request).status, 'completed');
  available = false;
  assert.throws(() => publisher.publish(request), /不能重复/);
});

test('不完整的写入记录视为结果未知，不能重复提交', (t) => {
  const { publisher, request, directory } = fixture(t);
  const records = path.join(directory, 'state', 'draft-publications'); fs.mkdirSync(records);
  const key = crypto.createHash('sha256').update(JSON.stringify([request.id, request.revision])).digest('hex');
  fs.writeFileSync(path.join(records, `${key}.json`), '{');
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent).status, 'unknown');
  assert.throws(() => publisher.publish(request), /不能重复/);
});

test('历史记录缺少正文摘要时不能误判为当前内容已发布', (t) => {
  const { publisher, request, directory } = fixture(t);
  const records = path.join(directory, 'state', 'draft-publications'); fs.mkdirSync(records);
  const key = crypto.createHash('sha256').update(JSON.stringify([request.id, request.revision])).digest('hex');
  fs.writeFileSync(path.join(records, `${key}.json`), JSON.stringify({ draftId: request.id, revision: request.revision, target: request.target, status: 'completed' }));
  assert.equal(publisher.get(request.id, request.revision, request.target, request.expectedContent).status, 'conflict');
  assert.throws(() => publisher.publish(request), /不能重复/);
});

test('已发布的工作项草稿可幂等补关联，不重复写入且拒绝知识库或正文变化', (t) => {
  const { store, draft, vault } = fixture(t);
  const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '3', title: '工作项' };
  const linkedDraft = store.saveDraft({ ...draft, issue }, { expectedRevision: draft.revision });
  let currentVault = 'a'.repeat(64);
  const publisher = createDraftPublisher({ store, knowledgeStore: () => createMarkdownStore(vault), vaultId: () => currentVault });
  const request = { id: linkedDraft.id, revision: linkedDraft.revision, target: linkedDraft.target, expectedContent: linkedDraft.content, confirmed: true };
  assert.throws(() => publisher.linkPublished(request), /无法确认/);
  assert.equal(publisher.publish(request).status, 'completed');
  currentVault = 'b'.repeat(64);
  assert.throws(() => publisher.linkPublished(request), /知识库/);
  currentVault = 'a'.repeat(64);
  fs.writeFileSync(path.join(vault, 'note.md'), '外部更改');
  assert.throws(() => publisher.linkPublished(request), /内容已变化/);
  fs.writeFileSync(path.join(vault, 'note.md'), linkedDraft.content);
  assert.equal(publisher.linkPublished(request).issue.issueId, '3');
  assert.equal(publisher.linkPublished(request).issue.issueId, '3');
  assert.equal(store.list().noteLinks.length, 1);
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), linkedDraft.content);
});

test('发布草稿后补关联保留来源会话，重试不会重复来源或再次写入笔记', (t) => {
  const { store, draft, vault } = fixture(t);
  const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '3', title: '工作项' };
  const sourceSession = { id: 'source-session', title: '开发记录' };
  const linkedDraft = store.saveDraft({ ...draft, issue, sourceSession }, { expectedRevision: draft.revision });
  let writeCount = 0;
  const adapter = createMarkdownStore(vault);
  const publisher = createDraftPublisher({
    store,
    knowledgeStore: () => ({ ...adapter, create: (input) => { writeCount++; return adapter.create(input); } }),
    vaultId: () => 'a'.repeat(64),
  });
  const request = { id: linkedDraft.id, revision: linkedDraft.revision, target: linkedDraft.target, expectedContent: linkedDraft.content, confirmed: true };
  assert.equal(publisher.publish(request).status, 'completed');
  assert.deepEqual(publisher.linkPublished(request).sourceSessions, [sourceSession]);
  assert.deepEqual(publisher.linkPublished(request).sourceSessions, [sourceSession]);
  assert.equal(writeCount, 1);
  const persisted = new LocalStore(store.directory).list();
  assert.equal(persisted.noteLinks.length, 1);
  assert.deepEqual(persisted.noteLinks[0].sourceSessions, [sourceSession]);
  assert.deepEqual(persisted.drafts[0].sourceSession, sourceSession);
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), linkedDraft.content);
});
