const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../src/core.cjs');
const { createNoteUpdateGuard } = require('../src/note-update-guard.cjs');

function fixture(t, processNote) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'note-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const markerDir = path.join(directory, 'markers'); fs.mkdirSync(markerDir);
  const store = new LocalStore(path.join(directory, 'index'));
  const draft = store.saveDraft({ title: '记录', content: '新内容', target: 'note.md' });
  let noteContent = '旧内容'; let currentVault = 'a'.repeat(64);
  const process = async (vault, target, update, metadata) => {
    const wrappedUpdate = (current) => { noteContent = update(current); return noteContent; };
    if (processNote) return processNote(vault, target, wrappedUpdate, metadata);
    noteContent = wrappedUpdate(noteContent);
    return { status: 'completed' };
  };
  let remote = { status: 'completed', drained: true };
  const guard = createNoteUpdateGuard({ store, directory: markerDir, processNote: process, inspectNote: async () => remote, currentVaultId: () => currentVault, readNote: async (target) => ({ path: target, content: noteContent }) });
  const base = { requestId: 'request-1', vaultId: 'a'.repeat(64), draftId: draft.id, revision: draft.revision, target: draft.target, before: '旧内容', after: draft.content };
  const request = { ...base, confirmation: guard.preview(base).confirmation, confirmed: true };
  return { store, draft, guard, request, markerDir, setRemote: (value) => { remote = value; }, setNoteContent: (value) => { noteContent = value; }, setVaultId: (value) => { currentVault = value; }, getNoteContent: () => noteContent };
}

test('确认和原文绑定变化均拒绝且不占用', async (t) => {
  const { guard, request, markerDir } = fixture(t);
  await assert.rejects(guard.submit({ ...request, confirmed: false }), /确认/);
  await assert.rejects(guard.submit({ ...request, before: '另一原文' }), /确认/);
  await assert.rejects(guard.submit({ ...request, target: '../note.md' }), /无效/);
  assert.deepEqual(fs.readdirSync(markerDir), []);
});

test('桥接调用前创建标记失败时回滚本次锁并解除草稿冻结', async (t) => {
  let calls = 0;
  const { guard, request, store, markerDir } = fixture(t, async () => { calls++; });
  const originalLink = fs.linkSync;
  fs.linkSync = function (source, file, ...args) {
    if (typeof file === 'string' && file.startsWith(markerDir) && file.endsWith('.json')) {
      const error = new Error('模拟创建失败'); error.code = 'EIO'; throw error;
    }
    return originalLink.call(this, source, file, ...args);
  };
  try {
    assert.equal((await guard.submit(request)).status, 'not_written');
  } finally { fs.linkSync = originalLink; }
  assert.equal(calls, 0);
  assert.equal(store.list().drafts[0].updateLock, undefined);
  assert.deepEqual(fs.readdirSync(markerDir), []);
});

test('准备失败且回滚删除失败时持久记录清理，不调用桥接', async (t) => {
  let calls = 0;
  const { guard, request, store, markerDir } = fixture(t, async () => { calls++; });
  const originalLink = fs.linkSync; const originalUnlink = fs.unlinkSync;
  fs.linkSync = function (source, file, ...args) {
    if (typeof file === 'string' && file.startsWith(markerDir) && file.endsWith('.json')) throw new Error('模拟创建失败');
    return originalLink.call(this, source, file, ...args);
  };
  fs.unlinkSync = function (file, ...args) {
    if (typeof file === 'string' && file.startsWith(markerDir) && file.endsWith('.lock')) throw new Error('模拟清理失败');
    return originalUnlink.call(this, file, ...args);
  };
  let result;
  try { result = await guard.submit(request); } finally { fs.linkSync = originalLink; fs.unlinkSync = originalUnlink; }
  assert.equal(result.status, 'not_written');
  assert.equal(result.cleanupPending, true);
  assert.equal(calls, 0);
  assert.equal(store.list().drafts[0].updateLock, undefined);
  assert.throws(() => store.exportData(), /待清理/);
  guard.cleanupPending(store.list().updateCleanups[0].lockId);
  assert.deepEqual(fs.readdirSync(markerDir), []);
});

test('准备阶段进程退出后可恢复，且无需查询或重放桥接', async (t) => {
  const { store, draft, guard, request, markerDir } = fixture(t);
  const { spawnSync } = require('node:child_process');
  const script = `
    const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
    const { LocalStore } = require(process.argv[1]);
    const [directory, markerDir, id, target, vaultId] = process.argv.slice(2);
    const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const lock = { requestId: 'crashed', ownerPid: process.pid, vaultId, target, beforeDigest: digest('旧内容'), afterDigest: digest('新内容'), status: 'preparing', lockId: 'a'.repeat(32) };
    new LocalStore(directory).beginDraftUpdate({ id, revision: 1, target, content: '新内容', updateLock: lock });
    const filename = 'target-' + digest(JSON.stringify([vaultId, target])) + '.lock';
    fs.writeFileSync(path.join(markerDir, filename), JSON.stringify(lock));
  `;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('../src/core.cjs'), store.directory, markerDir, draft.id, draft.target, request.vaultId], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(store.list().drafts[0].updateLock.status, 'preparing');
  const recovered = await guard.recover({ draftId: draft.id, revision: draft.revision, requestId: 'crashed', confirmed: true });
  assert.equal(recovered.updateLock, undefined);
  assert.deepEqual(store.list().updateCleanups, []);
  assert.deepEqual(fs.readdirSync(markerDir), []);
});

test('硬链接发布锁后进程中断，留下的目标锁内容完整且可以恢复', async (t) => {
  const { store, draft, guard, request, markerDir } = fixture(t);
  const script = `
    const fs = require('node:fs');
    const { LocalStore } = require(process.argv[1]);
    const { createNoteUpdateGuard } = require(process.argv[2]);
    const [directory, markerDir, draftId, vaultId] = process.argv.slice(3);
    const originalLink = fs.linkSync;
    fs.linkSync = (source, target) => { originalLink(source, target); process.exit(73); };
    const guard = createNoteUpdateGuard({ store: new LocalStore(directory), directory: markerDir, currentVaultId: () => vaultId, processNote: async () => { throw Error('不得调用'); }, readNote: async () => ({ content: '旧内容' }) });
    const input = { requestId:'crash-link', vaultId, draftId, revision:1, target:'note.md', before:'旧内容', after:'新内容' };
    guard.submit({ ...input, confirmation: guard.preview(input).confirmation, confirmed:true });
  `;
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', script, require.resolve('../src/core.cjs'), require.resolve('../src/note-update-guard.cjs'), store.directory, markerDir, draft.id, request.vaultId], { encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  const target = fs.readdirSync(markerDir).find((name) => name.endsWith('.lock'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(markerDir, target), 'utf8')).lockId);
  await guard.recover({ draftId: draft.id, revision: draft.revision, requestId: 'crash-link', confirmed: true });
  assert.equal(fs.existsSync(path.join(markerDir, target)), false);
  assert.equal(store.list().drafts[0].updateLock, undefined);
});

test('提交阶段索引提交后抛错时记录未发送并清理，不请求桥接', async (t) => {
  let calls = 0;
  const { store, guard, request, markerDir } = fixture(t, async () => { calls++; });
  const dispatch = store.dispatchDraftUpdate.bind(store);
  store.dispatchDraftUpdate = (input) => {
    const originalFsync = fs.fsyncSync;
    fs.fsyncSync = (fd) => { if (fs.fstatSync(fd).isDirectory()) throw new Error('模拟提交后目录同步失败'); return originalFsync(fd); };
    try { return dispatch(input); } finally { fs.fsyncSync = originalFsync; }
  };
  const result = await guard.submit(request);
  assert.equal(result.status, 'not_written');
  assert.equal(calls, 0);
  assert.equal(store.list().drafts[0].updateLock, undefined);
  assert.deepEqual(store.list().updateCleanups, []);
  assert.deepEqual(fs.readdirSync(markerDir), []);
});

test('准备阶段的进程仍存活时不能恢复', async (t) => {
  const { store, draft, guard, request } = fixture(t);
  const crypto = require('node:crypto'); const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
  store.beginDraftUpdate({ id: draft.id, revision: draft.revision, target: draft.target, content: draft.content, updateLock: { requestId: 'running', ownerPid: process.pid, vaultId: request.vaultId, target: draft.target, beforeDigest: digest('旧内容'), afterDigest: digest(draft.content), status: 'preparing', lockId: 'b'.repeat(32) } });
  await assert.rejects(guard.recover({ draftId: draft.id, revision: draft.revision, requestId: 'running', confirmed: true }), /仍在运行/);
  assert.ok(store.list().drafts[0].updateLock);
});

test('旧版锁清理失败时保留独立记录，不自动删除无身份的遗留锁', async (t) => {
  const { store, draft, guard, request, markerDir, setNoteContent } = fixture(t);
  const crypto = require('node:crypto'); const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const lock = { requestId: 'legacy', ownerPid: process.pid, vaultId: request.vaultId, target: draft.target, beforeDigest: digest('旧内容'), afterDigest: digest(draft.content), status: 'unknown' };
  store.beginDraftUpdate({ id: draft.id, revision: draft.revision, target: draft.target, content: draft.content, updateLock: lock });
  const target = path.join(markerDir, `target-${digest(JSON.stringify([lock.vaultId, lock.target]))}.lock`);
  fs.writeFileSync(target, JSON.stringify(lock)); setNoteContent(draft.content);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) { if (file === target) throw new Error('模拟清理失败'); return unlink.call(this, file, ...args); };
  let result;
  try { result = await guard.recover({ draftId: draft.id, revision: draft.revision, requestId: lock.requestId, confirmed: true }); } finally { fs.unlinkSync = unlink; }
  assert.equal(result.cleanupPending, true);
  const pending = store.list().updateCleanups[0];
  assert.throws(() => guard.cleanupPending(pending.lockId), /身份无法核实/);
  assert.equal(fs.existsSync(target), true);
  fs.unlinkSync(target);
  assert.equal(guard.cleanupPending(pending.lockId), true);
});

test('写入完成后目标锁清理失败时保留持久记录并允许重启后清理', async (t) => {
  const { guard, request, store, markerDir } = fixture(t);
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (typeof file === 'string' && file.startsWith(markerDir) && file.endsWith('.lock')) {
      const error = new Error('模拟清理失败'); error.code = 'EIO'; throw error;
    }
    return originalUnlink.call(this, file, ...args);
  };
  let result;
  try { result = await guard.submit(request); } finally { fs.unlinkSync = originalUnlink; }
  assert.equal(result.status, 'completed');
  assert.equal(result.cleanupPending, true);
  assert.match(result.message, /外部锁清理失败/);
  assert.equal(store.list().drafts[0].updateLock, undefined);
  assert.equal(fs.readdirSync(markerDir).filter((name) => name.endsWith('.lock')).length, 1);
  const pending = store.list().updateCleanups[0];
  assert.ok(pending.lockId);
  store.deleteDraft(pending.draftId, pending.revision);
  const restartedStore = new LocalStore(store.directory);
  const restarted = createNoteUpdateGuard({ store: restartedStore, directory: markerDir, processNote: async () => {}, currentVaultId: () => 'a'.repeat(64), readNote: async () => ({ content: '新内容' }) });
  assert.equal(restarted.cleanupPending(pending.lockId), true);
  assert.deepEqual(fs.readdirSync(markerDir), []);
  assert.deepEqual(restartedStore.list().updateCleanups, []);
});

test('清理中断后重试不会删除后续请求的目标锁', async (t) => {
  const { guard, request, store, markerDir } = fixture(t);
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function (file, ...args) {
    if (typeof file === 'string' && file.startsWith(markerDir) && file.endsWith('.lock')) throw new Error('模拟中断');
    return originalUnlink.call(this, file, ...args);
  };
  try { await guard.submit(request); } finally { fs.unlinkSync = originalUnlink; }
  const pending = store.list().updateCleanups[0];
  const target = path.join(markerDir, fs.readdirSync(markerDir).find((name) => name.endsWith('.lock')));
  const foreign = { requestId: 'new', ownerPid: process.pid, vaultId: request.vaultId, target: request.target, lockId: 'f'.repeat(32) };
  fs.writeFileSync(target, JSON.stringify(foreign));
  guard.cleanupPending(pending.lockId);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), foreign);
  assert.deepEqual(store.list().updateCleanups, []);
});

test('桥接元数据使用已确认内容，completed 才成功，确定未写状态会安全释放锁', async (t) => {
  let seen;
  const completed = fixture(t, async (_vault, _target, update, metadata) => {
    seen = metadata;
    update('旧内容');
    return { status: 'completed' };
  });
  assert.equal((await completed.guard.submit(completed.request)).status, 'completed');
  assert.deepEqual(seen, {
    requestId: completed.request.requestId,
    beforeDigest: require('node:crypto').createHash('sha256').update('旧内容').digest('hex'),
    afterDigest: require('node:crypto').createHash('sha256').update('新内容').digest('hex'),
    content: '新内容',
  });

  for (const bridgeStatus of ['busy', 'unavailable', 'invalid', 'target_mismatch', 'conflict', 'limit_reached']) {
    const value = fixture(t, async () => ({ status: bridgeStatus }));
    const result = await value.guard.submit(value.request);
    assert.deepEqual(result, { status: 'not_written', bridgeStatus });
    assert.equal(value.store.list().drafts[0].updateLock, undefined);
    assert.deepEqual(fs.readdirSync(value.markerDir), []);
  }

  const unknown = fixture(t, async () => ({ status: 'unknown' }));
  assert.equal((await unknown.guard.submit(unknown.request)).status, 'unknown');
  assert.equal(unknown.store.list().drafts[0].updateLock.status, 'unknown');
  assert.equal(fs.readdirSync(unknown.markerDir).filter((name) => name.endsWith('.lock')).length, 1);

  const unverifiable = fixture(t, async () => ({ status: 'completed' }));
  const result = await unverifiable.guard.submit(unverifiable.request);
  assert.equal(result.status, 'unknown');
  assert.equal(unverifiable.store.list().drafts[0].updateLock.status, 'unknown');
  assert.equal(fs.readdirSync(unverifiable.markerDir).filter((name) => name.endsWith('.lock')).length, 1);
});

test('暂缓、舍弃、过期版本及敏感内容不提交', async (t) => {
  for (const status of ['deferred', 'discarded']) {
    const { store, draft, guard, request, markerDir } = fixture(t);
    store.saveDraft({ ...draft, status }, { expectedRevision: draft.revision });
    await assert.rejects(guard.submit(request), /草稿状态/);
    assert.deepEqual(fs.readdirSync(markerDir), []);
  }
  const { store, draft, guard, request, markerDir } = fixture(t);
  const changed = store.saveDraft({ ...draft, content: 'password=' + 'x'.repeat(12) }, { expectedRevision: draft.revision });
  await assert.rejects(guard.submit(request), /草稿状态/);
  const base = { ...request, revision: changed.revision, after: changed.content };
  await assert.rejects(guard.submit({ ...base, confirmation: guard.preview(base).confirmation }), /敏感/);
  assert.deepEqual(fs.readdirSync(markerDir), []);
});

test('同草稿版本并发请求被拒绝，异步执行期间冻结草稿并在完成后解锁', async (t) => {
  let resolve; let calls = 0;
  const { store, draft, guard, request, markerDir } = fixture(t, async (_vault, _target, update) => {
    calls++;
    await new Promise((done) => { resolve = done; });
    update('旧内容');
    return { status: 'completed' };
  });
  const first = guard.submit(request);
  const another = { ...request, requestId: 'request-2' };
  const second = await guard.submit({ ...another, confirmation: guard.preview(another).confirmation });
  assert.equal(second.status, 'unknown');
  assert.throws(() => store.saveDraft({ ...draft, title: '提交期间修改' }, { expectedRevision: draft.revision }), /不能修改/);
  assert.throws(() => store.deleteDraft(draft.id, draft.revision), /不能删除/);
  resolve(); assert.equal((await first).status, 'completed'); assert.equal(calls, 1);
  assert.equal(store.list().drafts[0].updateLock, undefined);
  store.saveDraft({ ...draft, title: '写入完成后修改' }, { expectedRevision: draft.revision });
  const restarted = createNoteUpdateGuard({ store: new LocalStore(store.directory), directory: markerDir, processNote: async () => { calls++; }, currentVaultId: () => 'a'.repeat(64), readNote: async () => ({ content: '新内容' }) });
  const stale = { ...request, revision: draft.revision + 1 };
  assert.equal((await restarted.submit({ ...stale, confirmation: restarted.preview(stale).confirmation })).status, 'unknown');
  assert.equal(calls, 2);
});

test('同一目标的不同草稿不能并发更新，提交中不能创建新版本', async (t) => {
  let resolve; let calls = 0;
  const { store, draft, guard, request } = fixture(t, async (_vault, _target, update) => {
    calls++;
    if (calls === 1) await new Promise((done) => { resolve = done; });
    update('旧内容');
    return { status: 'completed' };
  });
  const first = guard.submit(request);
  const differentDraft = store.saveDraft({ title: '另一个草稿', content: '另一内容', target: 'note.md' });
  const other = { ...request, requestId: 'other', draftId: differentDraft.id, revision: differentDraft.revision, after: differentDraft.content };
  assert.equal((await guard.submit({ ...other, confirmation: guard.preview(other).confirmation })).status, 'unknown');
  assert.throws(() => store.saveDraft({ ...draft, content: '更新内容' }, { expectedRevision: draft.revision }), /不能修改/);
  resolve();
  assert.equal((await first).status, 'completed');
  const newer = store.saveDraft({ ...draft, content: '更新内容' }, { expectedRevision: draft.revision });
  const next = { ...request, requestId: 'next', revision: newer.revision, after: newer.content };
  assert.equal((await guard.submit({ ...next, confirmation: guard.preview(next).confirmation })).status, 'completed');
  assert.equal(calls, 2);
});

test('未知结果保留草稿冻结，直到摘要核对恢复', async (t) => {
  let resolve; let returned = false;
  const { store, draft, guard, request } = fixture(t, async (_vault, _target, update) => {
    await new Promise((done) => { resolve = done; });
    update('旧内容');
    returned = true;
    return { status: 'completed' };
  });
  const first = guard.submit(request);
  assert.throws(() => store.saveDraft({ ...draft, status: 'discarded' }, { expectedRevision: draft.revision }), /不能修改/);
  resolve();
  assert.equal((await first).status, 'completed');
  assert.equal(returned, true);
  const uncertain = fixture(t, async () => { throw new Error('连接中断'); });
  assert.equal((await uncertain.guard.submit(uncertain.request)).status, 'unknown');
  assert.equal(uncertain.store.list().drafts[0].updateLock.status, 'unknown');
  assert.throws(() => uncertain.store.saveDraft({ ...uncertain.draft, title: '不能改' }, { expectedRevision: uncertain.draft.revision }), /不能修改/);
  await assert.rejects(uncertain.guard.recover({ draftId: uncertain.draft.id, revision: uncertain.draft.revision, requestId: uncertain.request.requestId, verifiedAfterDigest: '0'.repeat(64), confirmed: true }), /不一致/);
  uncertain.setVaultId('b'.repeat(64));
  await assert.rejects(uncertain.guard.recover({ draftId: uncertain.draft.id, revision: uncertain.draft.revision, requestId: uncertain.request.requestId, confirmed: true }), /知识库/);
  uncertain.setVaultId('a'.repeat(64));
  uncertain.setNoteContent(uncertain.draft.content);
  uncertain.setRemote({ status: 'busy', drained: false });
  await assert.rejects(uncertain.guard.recover({ draftId: uncertain.draft.id, revision: uncertain.draft.revision, requestId: uncertain.request.requestId, confirmed: true }), /远端更新/);
  assert.ok(uncertain.store.list().drafts[0].updateLock);
  uncertain.setRemote({ status: 'resolved_unknown', drained: true });
  const targetLock = path.join(uncertain.markerDir, fs.readdirSync(uncertain.markerDir).find((name) => name.endsWith('.lock')));
  const ownerRecord = fs.readFileSync(targetLock, 'utf8');
  fs.writeFileSync(targetLock, JSON.stringify({ ...JSON.parse(ownerRecord), requestId: 'someone-else' }));
  await assert.rejects(uncertain.guard.recover({ draftId: uncertain.draft.id, revision: uncertain.draft.revision, requestId: uncertain.request.requestId, confirmed: true }), /归属不匹配/);
  assert.equal(fs.existsSync(targetLock), true);
  fs.writeFileSync(targetLock, ownerRecord);
  const recoverDraftUpdate = uncertain.store.recoverDraftUpdate.bind(uncertain.store);
  uncertain.store.recoverDraftUpdate = (input) => {
    assert.equal(fs.existsSync(targetLock), true, '外部互斥必须保留到索引解锁事务提交之后');
    return recoverDraftUpdate(input);
  };
  await uncertain.guard.recover({ draftId: uncertain.draft.id, revision: uncertain.draft.revision, requestId: uncertain.request.requestId, confirmed: true });
  assert.equal(uncertain.store.list().drafts[0].updateLock, undefined);
});

test('原文变化、适配器异常及遗留占用均不重试', async (t) => {
  let calls = 0;
  const { guard, request } = fixture(t, async (_vault, _target, update) => { calls++; update('外部修改'); return { status: 'completed' }; });
  assert.equal((await guard.submit(request)).status, 'unknown');
  assert.equal((await guard.submit(request)).status, 'unknown');
  assert.equal(calls, 1);
  const failed = fixture(t, async () => { throw new Error('模拟崩溃'); });
  assert.equal((await failed.guard.submit(failed.request)).status, 'unknown');
  assert.equal((await failed.guard.submit(failed.request)).status, 'unknown');
});

test('中断后保留的占用记录在新实例中阻止不同请求重放', async (t) => {
  let calls = 0;
  const { guard, request, store, markerDir } = fixture(t, async () => { calls++; throw new Error('模拟进程中断'); });
  assert.equal((await guard.submit(request)).status, 'unknown');
  const restarted = createNoteUpdateGuard({ store: new LocalStore(store.directory), directory: markerDir, processNote: async () => { calls++; }, currentVaultId: () => 'a'.repeat(64), readNote: async () => ({ content: '旧内容' }) });
  const other = { ...request, requestId: 'new-request' };
  assert.equal((await restarted.submit({ ...other, confirmation: restarted.preview(other).confirmation })).status, 'unknown');
  assert.equal(calls, 1);
});
