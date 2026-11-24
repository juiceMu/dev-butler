const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../src/core.cjs');
const { createDraftNoteUpdater } = require('../src/draft-note-update.cjs');
const { createObsidianBridgeClient } = require('../src/obsidian-bridge-client.cjs');
const { createBridge, hash } = require('../obsidian-plugin/bridge.cjs');

test('模拟 Obsidian 桥到更新服务完成持久化，再单独关联且不重复写入', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-bridge-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pluginDirectory = path.join(root, '.obsidian/plugins/x-assistant-bridge');
  fs.mkdirSync(pluginDirectory, { recursive: true });
  const markers = path.join(root, 'markers'); fs.mkdirSync(markers);
  let note = '# 原文\n'; let writes = 0; const attempts = [];
  let pause; let entered;
  class TFile { constructor() { this.path = 'note.md'; } }
  const bridge = createBridge({
    app: { vault: { adapter: { getBasePath: () => root }, getAbstractFileByPath: () => new TFile(), process: async (_file, transform) => { writes++; note = transform(note); if (entered) entered(); if (pause) await pause; return note; } } },
    TFile, token: 'b'.repeat(64), readAttempts: async () => attempts,
    writeAttempt: async (id, record) => { const index = attempts.findIndex((item) => item.attemptId === id); if (index < 0) attempts.push(record); else attempts[index] = record; },
    readReplayFilter: async () => ({ bits: '', count: 0 }),
    compactAttempts: async () => {},
  });
  const endpoint = await bridge.start(); t.after(() => bridge.close());
  fs.writeFileSync(path.join(pluginDirectory, 'bridge.json'), JSON.stringify(endpoint));
  const vaultId = hash(root);
  const client = createObsidianBridgeClient({ vaultRoot: root, vaultId });
  const store = new LocalStore(path.join(root, 'index'));
  const issue = { environment: 'https://example.test', tenantId: '1', projectId: '2', issueId: '3', title: '工作项' };
  const draft = store.saveDraft({ title: '知识', content: '# 新内容\n', target: 'note.md', issue, sourceSession: { id: 'session-1', title: '来源会话' } });
  const updater = createDraftNoteUpdater({
    store, directory: markers, currentVaultId: () => vaultId,
    knowledgeStore: () => ({ read: () => ({ content: note }) }),
    processNote: async (_vault, target, transform, metadata) => client.update({ attemptId: metadata.requestId, notePath: target, expectedDigest: metadata.beforeDigest, content: transform(note), confirmed: true }),
    inspectNote: async (_vault, target, metadata) => client.inspect({ attemptId: metadata.requestId, notePath: target, expectedDigest: metadata.beforeDigest, contentDigest: metadata.afterDigest }),
  });
  const input = { id: draft.id, revision: draft.revision, target: draft.target, expectedContent: draft.content };
  const preview = updater.preview(input);
  const result = await updater.submit({ ...input, requestId: preview.requestId, confirmation: preview.confirmation, confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(writes, 1);
  assert.deepEqual(store.list().knowledgeEntries.map(({ path, origins }) => ({ path, origins })), [{ path: 'note.md', origins: ['linked'] }]);
  const persisted = new LocalStore(store.directory).list().drafts[0].updateReceipt;
  assert.equal(persisted.requestId, preview.requestId);
  assert.equal(persisted.sourceSession.id, 'session-1');
  assert.equal(store.list().noteLinks.length, 0);
  const link = { id: draft.id, revision: draft.revision, requestId: preview.requestId, confirmed: true };
  updater.link(link); updater.link(link);
  assert.equal(store.list().noteLinks.length, 1);
  assert.equal(store.list().noteLinks[0].sourceSessions[0].id, 'session-1');
  assert.equal(writes, 1);
  note = '# 外部修改';
  assert.throws(() => updater.link(link), /已变化/);
  assert.equal(writes, 1);

  let release; let pending;
  pause = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const next = store.saveDraft({ title: '未知结果', content: '# 再次更新', target: 'note.md', issue });
  const uncertain = createDraftNoteUpdater({
    store, directory: markers, currentVaultId: () => vaultId,
    knowledgeStore: () => ({ read: () => ({ content: note }) }),
    processNote: async (_vault, target, transform, metadata) => {
      pending = client.update({ attemptId: metadata.requestId, notePath: target, expectedDigest: metadata.beforeDigest, content: transform(note), confirmed: true });
      await started;
      return { status: 'unknown' };
    },
    inspectNote: async (_vault, target, metadata) => client.inspect({ attemptId: metadata.requestId, notePath: target, expectedDigest: metadata.beforeDigest, contentDigest: metadata.afterDigest }),
  });
  const nextInput = { id: next.id, revision: next.revision, target: next.target, expectedContent: next.content };
  const nextPreview = uncertain.preview(nextInput);
  assert.equal((await uncertain.submit({ ...nextInput, ...nextPreview, confirmed: true })).status, 'unknown');
  const recovery = { id: next.id, revision: next.revision, requestId: nextPreview.requestId, confirmed: true };
  const active = await uncertain.inspect(recovery);
  assert.equal(active.status, 'matches_after');
  assert.equal(active.recoverable, false);
  await assert.rejects(uncertain.recover(recovery), /远端更新/);
  assert.ok(store.list().drafts.find((item) => item.id === next.id).updateLock);
  release(); await pending;
  assert.equal((await uncertain.inspect(recovery)).recoverable, true);
  await uncertain.recover(recovery);
  assert.equal(store.list().drafts.find((item) => item.id === next.id).updateLock, undefined);
  assert.equal(writes, 2);
});
