const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LocalStore } = require('../src/core.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-core-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new LocalStore(dir);
}

const issue = (id) => ({ environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: id, title: `项目 ${id}` });
const makeLink = (id, sessionId = 's1', primary = false) => ({ issue: issue(id), sessionId, primary });
const vaultId = 'a'.repeat(64);

test('多项草稿支持明确替换、去重验证、旧编辑保护和备份', (t) => {
  const store = fixture(t);
  const d = store.saveDraft({ title: '多项', content: '正文', issues: [issue('1'), issue('2')] });
  assert.equal(d.issues.length, 2);
  assert.deepEqual(d.issue, d.issues[0]);
  assert.throws(() => store.saveDraft({ ...d, issues: [issue('1'), issue('1')] }, { expectedRevision: 1 }), /重复/);
  const { issues, ...legacy } = d;
  assert.throws(() => store.saveDraft(legacy, { expectedRevision: 1 }), /完整工作项/);
  const read = store.previewImport(store.exportData());
  assert.equal(read.counts.drafts, 1);
  assert.equal(store.exportData().drafts[0].issues.length, 2);
  const next = store.saveDraft({ ...d, issues: [issue('2')] }, { expectedRevision: 1 });
  assert.equal(next.revision, 2);
  assert.equal(next.issue.issueId, '2');
});

test('多项导入合并保留并集、替换使用传入快照，v13单项按旧格式迁移', (t) => {
  const store = fixture(t); const other = fixture(t);
  store.saveDraft({ id: 'shared', title: '本地', content: '本地正文', issues: [issue('1'), issue('2')] });
  other.saveDraft({ id: 'shared', title: '外部', content: '外部正文', issues: [issue('2'), issue('3')] });
  const backup = other.exportData();
  for (const decision of ['merge', 'replace']) {
    const preview = store.previewImport(backup);
    store.importData(backup, preview.token, Object.fromEntries(preview.conflicts.map((conflict) => [JSON.stringify([conflict.collection, conflict.key]), decision])));
    const d = store.list().drafts[0];
    assert.deepEqual(d.issues.map((item) => item.issueId), decision === 'merge' ? ['1', '2', '3'] : ['2', '3']);
    assert.equal(d.revision, decision === 'merge' ? 2 : 3);
  }
  const legacy = other.exportData(); legacy.version = 13;
  delete legacy.drafts[0].issues;
  fs.writeFileSync(other.file, JSON.stringify(legacy));
  const migrated = new LocalStore(other.directory).list();
  assert.equal(migrated.version, 14);
  assert.equal(migrated.drafts[0].issues.length, 1);
  legacy.drafts[0].issues = [issue('2')];
  assert.throws(() => store.previewImport(legacy), /旧版本/);
});

test('多工作项更新未知恢复一次性生成全部待关联，容量预留按项计算', (t) => {
  const store = fixture(t);
  const d = store.saveDraft({ title: '多项', target: 'multi.md', content: '正文', issues: [issue('1'), issue('2')] });
  const afterDigest = crypto.createHash('sha256').update(d.content).digest('hex');
  const lock = { requestId: 'multi-recover', ownerPid: 99999999, vaultId, target: d.target, beforeDigest: 'b'.repeat(64), afterDigest, status: 'preparing' };
  const seed = { kind: 'create', operationId: 'seed', draftId: 'seed', revision: 1, vaultId, target: 'seed.md', contentDigest: 'c'.repeat(64), title: '种子', issue: issue('seed') };
  store.transaction((state) => {
    state.pendingNoteLinks = Array.from({ length: 9999 }, (_, index) => {
      const entry = { ...seed, operationId: `seed-${index}` };
      const id = crypto.createHash('sha256').update(JSON.stringify([entry.kind, entry.operationId, entry.draftId, entry.revision, entry.vaultId, entry.target, entry.contentDigest, JSON.stringify([entry.issue.environment, entry.issue.tenantId, entry.issue.projectId, entry.issue.issueId])])).digest('hex');
      return { ...entry, id };
    });
  });
  assert.throws(() => store.beginDraftUpdate({ id: d.id, revision: 1, target: d.target, content: d.content, updateLock: lock }), /容量/);
  assert.equal(store.list().drafts[0].updateLock, undefined);
  store.transaction((state) => { state.pendingNoteLinks = []; });
  store.beginDraftUpdate({ id: d.id, revision: 1, target: d.target, content: d.content, updateLock: lock });
  store.finishDraftUpdate({ id: d.id, revision: 1, requestId: lock.requestId, outcome: 'unknown' });
  store.recoverDraftUpdate({ id: d.id, revision: 1, requestId: lock.requestId, verifiedAfterDigest: afterDigest, confirmed: true });
  assert.equal(store.list().pendingNoteLinks.length, 2);
  assert.equal(store.list().drafts[0].updateReceipt.issues.length, 2);
});

test('更新锁预留目录容量，历史超额锁可完成但不能增加占用', (t) => {
  const store = fixture(t);
  const draft = store.saveDraft({ title: '更新', target: 'target.md', content: '更新内容' });
  const digest = crypto.createHash('sha256').update(draft.content).digest('hex');
  const lock = { requestId: 'capacity-update', ownerPid: 99999999, vaultId, target: draft.target, beforeDigest: 'b'.repeat(64), afterDigest: digest, status: 'unknown' };
  const state = store.list();
  state.knowledgeEntries = Array.from({ length: 100000 }, (_, index) => ({ vaultId, path: `notes/${index}.md`, title: '', origins: ['linked'], registeredAt: '2026-01-01' }));
  fs.writeFileSync(store.file, JSON.stringify(state));
  assert.throws(() => store.beginDraftUpdate({ id: draft.id, revision: draft.revision, target: draft.target, content: draft.content, updateLock: lock }), /容量不足/);
  state.drafts[0].updateLock = lock;
  fs.writeFileSync(store.file, JSON.stringify(state));
  assert.equal(store.list().drafts[0].updateLock.requestId, lock.requestId);
  const extra = { vaultId, path: 'extra.md', title: '', operationId: 'c'.repeat(64), kind: 'direct', contentDigest: 'd'.repeat(64) };
  assert.throws(() => store.transaction((current) => store.reserveKnowledgeEntry(current, extra, 'e'.repeat(32))), /容量不足/);
  const incoming = fixture(t).exportData();
  incoming.knowledgeEntries.push({ vaultId, path: 'imported.md', title: '', origins: ['linked'], registeredAt: '2026-01-01' });
  const preview = store.previewImport(incoming);
  const beforeImport = crypto.createHash('sha256').update(fs.readFileSync(store.file)).digest('hex');
  assert.throws(() => store.importData(incoming, preview.token, {}), /容量不足/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(store.file)).digest('hex'), beforeImport);
  store.recoverDraftUpdate({ id: draft.id, revision: draft.revision, requestId: lock.requestId, verifiedAfterDigest: digest, confirmed: true });
  const after = store.list();
  assert.equal(after.knowledgeEntries.length, 100001);
  assert.deepEqual(after.knowledgeEntries.find((entry) => entry.path === draft.target).origins, ['linked']);
  assert.equal(after.drafts[0].updateLock, undefined);
});

test('更新锁与新建目录预留不能占用同一目标', (t) => {
  const store = fixture(t);
  const draft = store.saveDraft({ title: '更新', target: 'topic.md', content: '新内容' });
  const digest = crypto.createHash('sha256').update(draft.content).digest('hex');
  const lock = { requestId: 'same-target', ownerPid: 99999999, vaultId, target: draft.target, beforeDigest: 'b'.repeat(64), afterDigest: digest, status: 'unknown' };
  const input = { vaultId, path: draft.target, title: '新建', operationId: 'c'.repeat(64), kind: 'direct', contentDigest: digest };
  const generation = 'd'.repeat(32);
  store.transaction((state) => store.reserveKnowledgeEntry(state, input, generation));
  assert.throws(() => store.beginDraftUpdate({ id: draft.id, revision: draft.revision, target: draft.target, content: draft.content, updateLock: lock }), /未完成的知识目录操作/);
  store.transaction((state) => store.releaseKnowledgeReservation(state, input, generation));
  store.beginDraftUpdate({ id: draft.id, revision: draft.revision, target: draft.target, content: draft.content, updateLock: lock });
  assert.throws(() => store.transaction((state) => store.reserveKnowledgeEntry(state, input, generation)), /正在更新/);
  assert.equal(store.list().drafts[0].updateLock.requestId, lock.requestId);
});

test('知识目录去重、预留绑定和来源随备份保留', (t) => {
  const store = fixture(t); const other = fixture(t);
  const note = { issue: issue('1'), provider: 'markdown', path: 'design.md', vaultId, title: '设计' };
  store.addNoteLink(note);
  store.addNoteLink({ ...note, issue: issue('2') });
  store.removeNoteLink(note.issue, note.provider, note.path, vaultId);
  assert.equal(store.list().knowledgeEntries.length, 1);
  const input = { vaultId, path: 'new.md', title: '新记录', operationId: 'b'.repeat(64), kind: 'draft', contentDigest: 'd'.repeat(64) };
  const generation = 'c'.repeat(32);
  store.transaction((state) => store.reserveKnowledgeEntry(state, input, generation));
  assert.throws(() => store.exportData(), /预留/);
  assert.throws(() => store.transaction((state) => store.reserveKnowledgeEntry(state, { ...input, operationId: 'd'.repeat(64) }, generation)), /已有预留/);
  assert.throws(() => store.transaction((state) => store.completeKnowledgeReservation(state, input, 'e'.repeat(32))), /预留已变化/);
  store.transaction((state) => store.completeKnowledgeReservation(state, input, generation));
  assert.deepEqual(store.list().knowledgeEntries.find((entry) => entry.path === 'new.md').origins, ['created']);
  store.addNoteLink({ ...note, path: 'new.md' });
  assert.deepEqual(store.list().knowledgeEntries.find((entry) => entry.path === 'new.md').origins, ['created', 'linked']);
  const backup = store.exportData(); const preview = other.previewImport(backup);
  other.importData(backup, preview.token, {});
  assert.deepEqual(other.list().knowledgeEntries, backup.knowledgeEntries);
});

test('未知目录预留的处置与目录变化原子提交并可备份', (t) => {
  const store = fixture(t); const other = fixture(t);
  const input = { vaultId, path: 'uncertain.md', title: '核查', operationId: 'f'.repeat(64), kind: 'draft', contentDigest: 'd'.repeat(64) };
  const generation = 'e'.repeat(32);
  store.transaction((state) => store.reserveKnowledgeEntry(state, input, generation));
  store.transaction((state) => store.resolveKnowledgeReservation(state, input, generation, 'link'));
  assert.deepEqual(store.list().knowledgeEntries[0].origins, ['linked']);
  assert.equal(store.list().knowledgeReservations.length, 0);
  assert.equal(store.list().knowledgeResolutions[0].decision, 'link');
  assert.throws(() => store.transaction((state) => store.reserveKnowledgeEntry(state, input, generation)), /已有预留或处置/);
  const backup = store.exportData(); const preview = other.previewImport(backup);
  other.importData(backup, preview.token, {});
  assert.deepEqual(other.list().knowledgeResolutions, backup.knowledgeResolutions);
  const different = structuredClone(backup); different.knowledgeResolutions[0].decision = 'discard';
  assert.throws(() => other.previewImport(different), /处置记录冲突/);
});

test('旧索引仅迁移有知识库标识的 Markdown 关联', (t) => {
  const store = fixture(t);
  const legacy = { version: 12, links: [], drafts: [], noteLinks: [
    { issue: issue('1'), provider: 'markdown', path: 'known.md', vaultId, title: '已知', linkedAt: '2026-01-01', sourceSessions: [] },
    { issue: issue('2'), provider: 'markdown', path: 'unknown.md', vaultId: '', title: '', linkedAt: '2026-01-01', sourceSessions: [] },
  ], updateCleanups: [], pendingNoteLinks: [], processedNoteLinks: [], publicationReservations: [], uncertainResolutions: [], projectLinks: [] };
  fs.writeFileSync(store.file, JSON.stringify(legacy));
  assert.deepEqual(store.list().knowledgeEntries.map((entry) => entry.path), ['known.md']);
  assert.equal(store.list().noteLinks.length, 2);
});

test('当前版本导入或替换目录时保留实际笔记关联的 linked 来源', (t) => {
  const source = fixture(t); const destination = fixture(t);
  const note = { issue: issue('1'), provider: 'markdown', path: 'design.md', vaultId, title: '设计' };
  source.addNoteLink(note);
  const incomplete = source.exportData(); incomplete.knowledgeEntries = [];
  const preview = destination.previewImport(incomplete);
  assert.equal(preview.counts.knowledgeEntries, 1);
  destination.importData(incomplete, preview.token, {});
  assert.deepEqual(destination.list().knowledgeEntries[0].origins, ['linked']);
  const backup = destination.exportData();
  backup.knowledgeEntries[0].origins = ['created'];
  const next = destination.previewImport(backup);
  const decisions = Object.fromEntries(next.conflicts.map((item) => [JSON.stringify([item.collection, item.key]), item.collection === 'knowledgeEntries' ? 'replace' : 'skip']));
  destination.importData(backup, next.token, decisions);
  assert.deepEqual(destination.list().knowledgeEntries[0].origins, ['created', 'linked']);
  destination.removeNoteLink(note.issue, note.provider, note.path, vaultId);
  assert.equal(destination.list().knowledgeEntries.length, 1);
});

test('关联工作项的草稿可持久化、更新并随备份恢复，旧草稿保持兼容', (t) => {
  const store = fixture(t); const other = fixture(t);
  const created = store.saveDraft({ title: '工作项记录', content: '设计原因', issue: issue('12') });
  const updated = store.saveDraft({ ...created, content: '更新后的原因' }, { expectedRevision: created.revision });
  assert.equal(new LocalStore(store.directory).list().drafts[0].issue.issueId, '12');
  const backup = store.exportData(); const preview = other.previewImport(backup);
  other.importData(backup, preview.token, {});
  assert.deepEqual(other.list().drafts[0].issue, updated.issue);
  const standalone = store.saveDraft({ title: '独立记录', content: '内容' });
  assert.equal(standalone.issue, undefined);
  assert.throws(() => store.saveDraft({ title: '错误', content: '内容', issue: { issueId: '12' } }), /环境/);
});

test('草稿会话来源随编辑和备份保留，可明确移除', (t) => {
  const store = fixture(t); const other = fixture(t);
  const created = store.saveDraft({ title: '记录', content: '正文', sourceSession: { id: 'session-1', title: '开发会话' } });
  const updated = store.saveDraft({ id: created.id, title: '记录', content: '更新' }, { expectedRevision: created.revision });
  assert.deepEqual(updated.sourceSession, { id: 'session-1', title: '开发会话' });
  const backup = store.exportData(); const preview = other.previewImport(backup);
  other.importData(backup, preview.token, {});
  assert.deepEqual(other.list().drafts[0].sourceSession, updated.sourceSession);
  const cleared = store.saveDraft({ ...updated, sourceSession: null }, { expectedRevision: updated.revision });
  assert.equal(cleared.sourceSession, undefined);
  const old = structuredClone(backup); old.version = 4; delete old.updateCleanups; delete old.pendingNoteLinks; delete old.processedNoteLinks; delete old.publicationReservations; delete old.uncertainResolutions; delete old.projectLinks; delete old.knowledgeEntries; delete old.knowledgeReservations; delete old.knowledgeResolutions;
  assert.throws(() => other.previewImport(old), /旧版本备份不能包含会话来源/);
});

test('已发布笔记关联累积会话来源并随备份保留', (t) => {
  const store = fixture(t); const other = fixture(t);
  const note = { issue: issue('1'), provider: 'markdown', path: 'note.md', vaultId, title: '记录' };
  store.addNoteLink(note);
  store.linkPublishedNote(note, { id: 's1', title: '会话一' });
  store.linkPublishedNote(note, { id: 's1', title: '新标题' });
  store.linkPublishedNote(note, { id: 's2', title: '会话二' });
  assert.deepEqual(store.list().noteLinks[0].sourceSessions, [{ id: 's1', title: '会话一' }, { id: 's2', title: '会话二' }]);
  const backup = store.exportData(); const preview = other.previewImport(backup);
  other.importData(backup, preview.token, {});
  assert.deepEqual(other.list().noteLinks[0].sourceSessions, store.list().noteLinks[0].sourceSessions);
  const invalid = structuredClone(backup); invalid.version = 5;
  assert.throws(() => other.previewImport(invalid), /旧版本备份不能包含知识会话来源/);
});

test('v5 知识关联迁移为空来源列表且保留草稿来源，首次写入才升级磁盘版本', (t) => {
  const store = fixture(t);
  const sourceSession = { id: 'legacy-session', title: '旧版开发会话' };
  const legacy = {
    version: 5, links: [],
    drafts: [{ id: 'legacy-draft', title: '旧版草稿', content: '正文', target: 'note.md', status: 'pending', revision: 1, updatedAt: '2026-01-01T00:00:00.000Z', issue: issue('1'), sourceSession }],
    noteLinks: [{ issue: issue('1'), provider: 'markdown', path: 'note.md', vaultId, title: '旧版笔记', linkedAt: '2026-01-01T00:00:00.000Z' }],
  };
  fs.writeFileSync(store.file, JSON.stringify(legacy));
  const migrated = store.list();
  assert.equal(migrated.version, 14);
  assert.deepEqual(migrated.noteLinks[0].sourceSessions, []);
  assert.deepEqual(migrated.drafts[0].sourceSession, sourceSession);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), legacy);
  store.linkPublishedNote(legacy.noteLinks[0], sourceSession);
  const persisted = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(persisted.version, 14);
  assert.deepEqual(persisted.noteLinks[0].sourceSessions, [sourceSession]);
  assert.deepEqual(persisted.drafts[0].sourceSession, sourceSession);
});

test('v9 索引迁移保留已处理记录且不推断人工处置结果', (t) => {
  const store = fixture(t);
  const legacy = { version: 9, links: [], drafts: [], noteLinks: [], updateCleanups: [], pendingNoteLinks: [], processedNoteLinks: ['a'.repeat(64)], publicationReservations: [] };
  fs.writeFileSync(store.file, JSON.stringify(legacy));
  const migrated = store.list();
  assert.equal(migrated.version, 14);
  assert.deepEqual(migrated.processedNoteLinks, legacy.processedNoteLinks);
  assert.deepEqual(migrated.uncertainResolutions, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), legacy);
});

test('v10 人工处置记录迁移不凭空补充工作项上下文', (t) => {
  const store = fixture(t);
  const legacy = { version: 10, links: [], drafts: [], noteLinks: [], updateCleanups: [], pendingNoteLinks: [], processedNoteLinks: ['a'.repeat(64)], publicationReservations: [], uncertainResolutions: [{ id: 'a'.repeat(64), generation: 'b'.repeat(32), decision: 'discard' }] };
  fs.writeFileSync(store.file, JSON.stringify(legacy));
  assert.deepEqual(store.list().uncertainResolutions, legacy.uncertainResolutions);
});

test('多对多关联持久化及主工作项保护', (t) => {
  const store = fixture(t);
  store.addLink(makeLink('1', 's1', true));
  store.addLink(makeLink('2', 's1'));
  store.addLink(makeLink('1', 's2'));
  assert.equal(new LocalStore(store.directory).list().links.length, 3);
  assert.throws(() => store.addLink(makeLink('1')), /关联已存在/);
  assert.throws(() => store.removeLink('s1', issue('1')), /明确确认/);
  store.setPrimary('s1', issue('2'));
  store.removeLink('s1', issue('1'));
  assert.equal(store.list().links.find((item) => item.sessionId === 's1').issue.issueId, '2');
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test('工作项关联多个工程，按工作项、工程标识和目录去重，解除不修改目录', (t) => {
  const store = fixture(t);
  const root = path.join(store.directory, 'project');
  fs.mkdirSync(root);
  const first = { issue: issue('1'), projectId: 'project-1', cwd: root, projectName: '工程一' };
  store.addProjectLink(first);
  store.addProjectLink({ ...first, projectId: 'project-2' });
  store.addProjectLink({ ...first, issue: issue('2') });
  assert.throws(() => store.addProjectLink(first), /已存在/);
  assert.throws(() => store.addProjectLink({ ...first, cwd: 'relative' }), /绝对路径/);
  assert.throws(() => store.addProjectLink({ ...first, cwd: `${root}/../other` }), /规范化/);
  assert.equal(new LocalStore(store.directory).list().projectLinks.length, 3);
  store.removeProjectLink(first.issue, first.projectId, first.cwd);
  assert.equal(store.list().projectLinks.length, 2);
  assert.equal(fs.existsSync(root), true);
  assert.throws(() => store.removeProjectLink(first.issue, first.projectId, first.cwd), /不存在/);
});

test('工程关联支持旧索引迁移、备份和显式冲突处理', (t) => {
  const store = fixture(t); const other = fixture(t);
  const legacy = { version: 11, links: [], drafts: [], noteLinks: [], updateCleanups: [], pendingNoteLinks: [], processedNoteLinks: [], publicationReservations: [], uncertainResolutions: [] };
  fs.writeFileSync(store.file, JSON.stringify(legacy));
  assert.deepEqual(store.list().projectLinks, []);
  const entry = { issue: issue('1'), projectId: 'project-1', cwd: '/project', projectName: '原名称' };
  store.addProjectLink(entry);
  other.addProjectLink({ ...entry, projectName: '备份名称' });
  const backup = other.exportData(); const preview = store.previewImport(backup);
  assert.equal(preview.counts.projectLinks, 1);
  assert.equal(preview.conflicts[0].collection, 'projectLinks');
  assert.throws(() => store.importData(backup, preview.token, {}), /明确选择/);
  store.importData(backup, preview.token, { [JSON.stringify(['projectLinks', preview.conflicts[0].key])]: 'replace' });
  assert.equal(store.list().projectLinks[0].projectName, '备份名称');
  assert.throws(() => store.previewImport({ ...legacy, projectLinks: [] }), /旧版本数据不能包含工程关联/);
  const invalid = structuredClone(backup); invalid.projectLinks.push(invalid.projectLinks[0]);
  assert.throws(() => store.previewImport(invalid), /重复工程关联/);
});

test('工作项知识关联按来源、工作项及路径区分，解除只修改索引', (t) => {
  const store = fixture(t);
  store.addNoteLink({ issue: issue('1'), provider: 'markdown', path: '项目/设计.md', title: '设计', vaultId });
  store.addNoteLink({ issue: issue('2'), provider: 'markdown', path: '项目/设计.md', vaultId });
  store.addNoteLink({ issue: issue('1'), provider: 'yuque', path: 'space/book/doc' });
  assert.throws(() => store.addNoteLink({ issue: issue('1'), provider: 'markdown', path: '项目/设计.md', vaultId }), /已存在/);
  for (const name of ['../设计.md', '/设计.md', '目录/../设计.md', '目录\\设计.md', '设计.txt']) {
    assert.throws(() => store.addNoteLink({ issue: issue('1'), provider: 'markdown', path: name }), /相对路径/);
  }
  assert.equal(new LocalStore(store.directory).list().noteLinks.length, 3);
  store.removeNoteLink(issue('1'), 'markdown', '项目/设计.md', vaultId);
  assert.equal(store.list().noteLinks.length, 2);
  assert.throws(() => store.removeNoteLink(issue('1'), 'markdown', '项目/设计.md', vaultId), /不存在/);
});

test('旧版索引迁移以及知识关联导入冲突必须显式处理', (t) => {
  const store = fixture(t);
  fs.writeFileSync(store.file, JSON.stringify({ version: 2, links: [], drafts: [] }));
  assert.deepEqual(store.list().noteLinks, []);
  store.addNoteLink({ issue: issue('1'), provider: 'markdown', path: '设计.md', title: '原名称', vaultId });
  const incomingStore = fixture(t);
  incomingStore.addNoteLink({ issue: issue('1'), provider: 'markdown', path: '设计.md', title: '新名称', vaultId });
  incomingStore.addNoteLink({ issue: issue('2'), provider: 'markdown', path: '设计.md', vaultId });
  const incoming = incomingStore.exportData();
  const preview = store.previewImport(incoming);
  assert.equal(preview.counts.noteLinks, 2);
  assert.equal(preview.conflicts.length, 2);
  assert.throws(() => store.importData(incoming, preview.token, {}), /明确选择/);
  assert.equal(store.list().noteLinks.length, 1);
  const key = JSON.stringify(['noteLinks', preview.conflicts[0].key]);
  const decisions = Object.fromEntries(preview.conflicts.map((conflict) => [JSON.stringify([conflict.collection, conflict.key]), 'skip']));
  decisions[key] = 'replace';
  store.importData(incoming, preview.token, decisions);
  assert.equal(store.list().noteLinks.length, 2);
  assert.equal(store.list().noteLinks.find((entry) => entry.issue.issueId === '1').title, '新名称');
});

test('同路径跨知识库区分，旧无标识关联保留未验证', (t) => {
  const store = fixture(t);
  const legacy = { version: 3, links: [], drafts: [], noteLinks: [{ issue: issue('1'), provider: 'markdown', path: '设计.md', title: '旧记录', linkedAt: '2026-01-01T00:00:00.000Z' }] };
  fs.writeFileSync(store.file, JSON.stringify(legacy));
  assert.equal(store.list().noteLinks[0].vaultId, '');
  assert.throws(() => store.addNoteLink({ issue: issue('1'), provider: 'markdown', path: '设计.md' }), /知识库标识/);
  assert.throws(() => store.addNoteLink({ issue: issue('1'), provider: 'markdown', path: '设计.md', vaultId: 'bad' }), /知识库标识/);
  store.addNoteLink({ issue: issue('1'), provider: 'markdown', path: '设计.md', vaultId });
  store.addNoteLink({ issue: issue('1'), provider: 'markdown', path: '设计.md', vaultId: 'b'.repeat(64) });
  assert.equal(store.list().noteLinks.length, 3);
  store.removeNoteLink(issue('1'), 'markdown', '设计.md');
  assert.equal(store.list().noteLinks.length, 2);
});

test('草稿持久化并显式删除', (t) => {
  const store = fixture(t);
  const item = store.saveDraft({ title: '设计原因', content: '原因待确认' });
  assert.equal(new LocalStore(store.directory).list().drafts[0].content, '原因待确认');
  store.deleteDraft(item.id, item.revision);
  assert.deepEqual(store.list().drafts, []);
});

test('删除草稿需要匹配当前版本', (t) => {
  const store = fixture(t);
  const first = store.saveDraft({ title: '标题', content: '初始内容' });
  const second = store.saveDraft({ ...first, content: '其他入口更新' }, { expectedRevision: first.revision });
  assert.throws(() => store.deleteDraft(first.id), /预期版本/);
  assert.throws(() => store.deleteDraft(first.id, first.revision), /草稿已被修改/);
  assert.equal(store.list().drafts[0].content, '其他入口更新');
  store.deleteDraft(second.id, second.revision);
  assert.deepEqual(store.list().drafts, []);
});

test('草稿更新需要匹配版本，过期编辑及导入后的编辑不能覆盖新内容', (t) => {
  const store = fixture(t);
  const first = store.saveDraft({ title: '标题', content: '初始内容' });
  assert.equal(first.revision, 1);
  assert.throws(() => store.saveDraft({ ...first, content: '无版本' }), /必须提供预期版本/);
  const second = store.saveDraft({ ...first, content: '新内容' }, { expectedRevision: first.revision });
  assert.equal(second.revision, 2);
  assert.throws(() => store.saveDraft({ ...first, content: '过期内容' }, { expectedRevision: first.revision }), /草稿已被修改/);
  const backup = store.exportData();
  const preview = store.previewImport(backup);
  const key = JSON.stringify(['drafts', preview.conflicts[0].key]);
  store.importData(backup, preview.token, { [key]: 'replace' });
  assert.equal(store.list().drafts[0].revision, 3);
  assert.throws(() => store.saveDraft(second, { expectedRevision: second.revision }), /草稿已被修改/);
  assert.throws(() => store.saveDraft({ ...first, id: 'missing' }, { expectedRevision: 1 }), /草稿不存在/);
});

test('草稿更新锁跨重启持久化并阻止编辑、删除、导入覆盖，只有核对摘要后可恢复', (t) => {
  const store = fixture(t);
  const item = store.saveDraft({ title: '安全更新', content: '新正文', target: 'note.md' });
  const backup = store.exportData();
  const beforeDigest = crypto.createHash('sha256').update('旧正文').digest('hex');
  const afterDigest = crypto.createHash('sha256').update(item.content).digest('hex');
  store.beginDraftUpdate({ id: item.id, revision: item.revision, target: item.target, content: item.content, updateLock: {
    requestId: 'update-1', ownerPid: process.pid, vaultId, target: item.target, beforeDigest, afterDigest, status: 'submitting',
  } });
  assert.throws(() => store.recoverDraftUpdate({ id: item.id, revision: item.revision, requestId: 'update-1', verifiedAfterDigest: afterDigest, confirmed: true }), /进程仍在运行/);
  for (const mutate of [
    (state) => { state.drafts[0].content = '旁路修改'; },
    (state) => { state.drafts[0].target = 'other.md'; },
    (state) => { state.drafts[0].revision++; },
    (state) => { state.drafts[0].status = 'discarded'; },
    (state) => { delete state.drafts[0].updateLock; },
    (state) => { state.drafts.splice(0, 1); },
  ]) assert.throws(() => store.transaction(mutate), /不能通过通用事务修改/);
  store.finishDraftUpdate({ id: item.id, revision: item.revision, requestId: 'update-1', outcome: 'unknown' });
  const restarted = new LocalStore(store.directory);
  const locked = restarted.list().drafts[0];
  assert.equal(locked.updateLock.status, 'unknown');
  assert.throws(() => restarted.saveDraft({ ...locked, content: '覆盖' }, { expectedRevision: item.revision }), /不能修改/);
  assert.throws(() => restarted.deleteDraft(item.id, item.revision), /不能删除/);
  assert.throws(() => restarted.exportData(), /不能导出/);
  const preview = restarted.previewImport(backup);
  const conflict = JSON.stringify(['drafts', preview.conflicts[0].key]);
  assert.throws(() => restarted.importData(backup, preview.token, { [conflict]: 'replace' }), /不能替换或合并/);
  assert.throws(() => restarted.recoverDraftUpdate({ id: item.id, revision: item.revision, requestId: 'update-1', verifiedAfterDigest: beforeDigest, confirmed: true }), /不一致/);
  restarted.recoverDraftUpdate({ id: item.id, revision: item.revision, requestId: 'update-1', verifiedAfterDigest: afterDigest, confirmed: true });
  assert.equal(restarted.list().drafts[0].updateLock, undefined);
  assert.equal(restarted.saveDraft({ ...item, content: '恢复后可编辑' }, { expectedRevision: item.revision }).revision, item.revision + 1);
});

test('索引校验拒绝草稿更新锁与目标或正文不匹配', (t) => {
  const store = fixture(t);
  const item = store.saveDraft({ title: '安全更新', content: '新正文', target: 'note.md' });
  store.beginDraftUpdate({ id: item.id, revision: item.revision, target: item.target, content: item.content, updateLock: {
    requestId: 'update-2', ownerPid: process.pid, vaultId, target: item.target,
    beforeDigest: crypto.createHash('sha256').update('旧正文').digest('hex'),
    afterDigest: crypto.createHash('sha256').update(item.content).digest('hex'), status: 'submitting',
  } });
  const persisted = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  persisted.drafts[0].content = '被篡改的正文';
  fs.writeFileSync(store.file, JSON.stringify(persisted));
  assert.throws(() => store.list(), /目标或内容不匹配/);
});

test('草稿正文的空白在保存及导出导入后保持不变', (t) => {
  const store = fixture(t);
  const content = '  缩进正文\n\n末尾空格  \n';
  const created = store.saveDraft({ title: '格式', content });
  assert.equal(store.list().drafts[0].content, content);
  const other = fixture(t);
  const backup = store.exportData();
  const preview = other.previewImport(backup);
  other.importData(backup, preview.token, {});
  assert.equal(other.list().drafts[0].content, content);
  assert.throws(() => store.saveDraft({ ...created, content: ' \n ' }, { expectedRevision: 1 }), /草稿内容/);
});

test('导出遇到疑似凭据时阻止输出且不修改草稿', (t) => {
  const store = fixture(t);
  const value = 'password=' + 'example123456';
  const draft = store.saveDraft({ title: '笔记', content: value });
  assert.throws(() => store.exportData(), (error) => /敏感信息/.test(error.message) && !error.message.includes(value));
  assert.equal(store.list().drafts[0].content, value);
  store.saveDraft({ ...draft, content: '已处理' }, { expectedRevision: draft.revision });
  assert.equal(store.exportData().drafts[0].content, '已处理');
});

test('旧版存储和备份迁移草稿版本，其他无效数据仍被拒绝', (t) => {
  const store = fixture(t);
  const legacy = { version: 1, links: [], drafts: [{ id: 'old', title: '标题', content: '  正文\n', target: '', status: 'pending', updatedAt: '2026-01-01T00:00:00.000Z' }] };
  fs.writeFileSync(store.file, JSON.stringify(legacy));
  const migrated = store.list();
  assert.equal(migrated.version, 14);
  assert.deepEqual(migrated.noteLinks, []);
  assert.equal(migrated.drafts[0].revision, 1);
  assert.equal(migrated.drafts[0].content, '  正文\n');
  store.saveDraft({ ...migrated.drafts[0], content: '更新' }, { expectedRevision: 1 });
  assert.equal(JSON.parse(fs.readFileSync(store.file)).version, 14);
  const other = fixture(t);
  const preview = other.previewImport(legacy);
  other.importData(legacy, preview.token, {});
  assert.equal(other.list().drafts[0].revision, 1);
  assert.equal(other.list().drafts[0].content, '  正文\n');
  assert.throws(() => other.previewImport({ ...legacy, version: 2 }), /草稿版本无效/);
  assert.throws(() => other.previewImport({ ...legacy, drafts: [{ ...legacy.drafts[0], revision: 0 }] }), /草稿版本无效/);
  assert.throws(() => other.previewImport({ ...legacy, drafts: [{ ...legacy.drafts[0], content: '' }] }), /草稿内容/);
});

test('导入必须预览、逐项决策并防止过期', (t) => {
  const store = fixture(t);
  store.addLink(makeLink('1', 's1', true));
  const backup = store.exportData();
  backup.links[0].sessionTitle = '新标题';
  const preview = store.previewImport(backup);
  assert.equal(preview.conflicts.length, 1);
  assert.throws(() => store.importData(backup, preview.token, {}), /明确选择/);
  const key = JSON.stringify(['links', preview.conflicts[0].key]);
  const decisions = Object.fromEntries(preview.conflicts.map((conflict) => [JSON.stringify([conflict.collection, conflict.key]), 'merge']));
  store.importData(backup, preview.token, decisions);
  assert.equal(store.list().links[0].sessionTitle, '新标题');
  const stale = store.previewImport(backup);
  store.saveDraft({ title: '新草稿', content: '内容' });
  assert.throws(() => store.importData(backup, stale.token, { [key]: 'replace' }), /预览已失效/);
});

test('合并知识关联保留双方来源，按 ID 去重且只补齐空会话标题', (t) => {
  const store = fixture(t); const other = fixture(t);
  const note = { issue: issue('1'), provider: 'markdown', path: 'note.md', vaultId };
  store.addNoteLink({ ...note, sourceSessions: [{ id: 's1', title: '' }, { id: 's3', title: '本地标题' }] });
  other.addNoteLink({ ...note, sourceSessions: [{ id: 's2', title: '导入会话' }, { id: 's1', title: '补齐标题' }, { id: 's3', title: '不同标题' }] });
  const backup = other.exportData(); const preview = store.previewImport(backup);
  assert.equal(preview.conflicts.length, 2);
  store.importData(backup, preview.token, Object.fromEntries(preview.conflicts.map((conflict) => [JSON.stringify([conflict.collection, conflict.key]), 'merge'])));
  assert.deepEqual(new LocalStore(store.directory).list().noteLinks[0].sourceSessions, [
    { id: 's1', title: '补齐标题' }, { id: 's3', title: '本地标题' }, { id: 's2', title: '导入会话' },
  ]);
  const again = store.previewImport(backup);
  store.importData(backup, again.token, Object.fromEntries(again.conflicts.map((conflict) => [JSON.stringify([conflict.collection, conflict.key]), 'merge'])));
  assert.equal(store.list().noteLinks[0].sourceSessions.length, 3);
});

test('合并知识来源超过上限时整笔导入不改变磁盘', (t) => {
  const store = fixture(t); const other = fixture(t);
  const note = { issue: issue('1'), provider: 'markdown', path: 'note.md', vaultId };
  store.addNoteLink({ ...note, sourceSessions: Array.from({ length: 1000 }, (_, index) => ({ id: `local-${index}`, title: '' })) });
  other.saveDraft({ title: '不应导入的草稿', content: '正文' });
  other.addNoteLink({ ...note, sourceSessions: [{ id: 'new-source', title: '新增会话' }] });
  const backup = other.exportData(); const preview = store.previewImport(backup);
  const before = fs.readFileSync(store.file, 'utf8');
  const key = JSON.stringify(['noteLinks', preview.conflicts[0].key]);
  assert.throws(() => store.importData(backup, preview.token, { [key]: 'merge' }));
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  assert.equal(store.list().drafts.length, 0);
  assert.equal(store.list().noteLinks[0].sourceSessions.length, 1000);
  assert.equal(fs.existsSync(store.lock), false);
});

test('导入主工作项冲突需要决策', (t) => {
  const store = fixture(t);
  store.addLink(makeLink('1', 's1', true));
  const other = fixture(t);
  other.addLink(makeLink('2', 's1', true));
  const data = other.exportData();
  const preview = store.previewImport(data);
  assert.equal(preview.conflicts[0].reason, 'primary');
  const key = JSON.stringify(['links', preview.conflicts[0].key]);
  store.importData(data, preview.token, { [key]: 'replace' });
  assert.equal(store.list().links.find((item) => item.primary).issue.issueId, '2');
});

test('拒绝无效数据与已占用锁，失败不修改数据', (t) => {
  const store = fixture(t);
  assert.throws(() => store.addLink(makeLink('')), /工作项 ID/);
  store.addLink(makeLink('1'));
  fs.writeFileSync(store.lock, '');
  assert.throws(() => store.saveDraft({ title: 'x', content: 'y' }), /其他进程/);
  assert.equal(store.list().drafts.length, 0);
  assert.throws(() => store.previewImport({ version: 5, links: [], drafts: [] }), /版本无效/);
});
