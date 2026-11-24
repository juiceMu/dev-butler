const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalStore } = require('../src/core.cjs');
const { createMarkdownStore } = require('../src/markdown-store.cjs');
const { createDirectKnowledgeCreator } = require('../src/direct-knowledge-create.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-knowledge-'));
  const vault = path.join(root, 'vault'); fs.mkdirSync(vault);
  const store = new LocalStore(path.join(root, 'data'));
  const adapter = createMarkdownStore(vault);
  const id = 'a'.repeat(64); const currentVault = 'b'.repeat(64);
  const creator = createDirectKnowledgeCreator({ store, knowledgeStore: () => adapter, vaultId: () => currentVault });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, vault, store, adapter, creator, id, currentVault };
}

test('新建绑定附件并登记目录，重复操作不会写入', (t) => {
  const { vault, store, creator, id } = fixture(t);
  fs.writeFileSync(path.join(vault, 'image.png'), 'image');
  const args = { operationId: id, path: 'note.md', content: '# 内容', attachments: ['image.png'], confirmed: true };
  const result = creator.create(args);
  assert.equal(result.status, 'completed'); assert.equal(result.path, 'note.md');
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), '# 内容');
  assert.equal(store.list().knowledgeEntries[0].path, 'note.md');
  assert.throws(() => creator.create(args), /已有记录/);
  assert.equal(creator.inspect(id).status, 'completed');
  assert.equal(creator.list().items.length, 1);
});

test('未确认和缺失附件不创建笔记或预留', (t) => {
  const { vault, store, creator, id } = fixture(t);
  const args = { operationId: id, path: 'note.md', content: '正文', attachments: ['missing.png'] };
  assert.throws(() => creator.create({ ...args, confirmed: false }), /确认/);
  assert.throws(() => creator.create({ ...args, confirmed: true }));
  assert.equal(fs.existsSync(path.join(vault, 'note.md')), false);
  assert.equal(store.list().knowledgeReservations.length, 0);
});

test('写入结果未知时保留预留，不会再次提交或自动恢复', (t) => {
  const { store, adapter, id, currentVault } = fixture(t);
  const creator = createDirectKnowledgeCreator({ store, vaultId: () => currentVault, knowledgeStore: () => ({ prepare: adapter.prepare, create() { throw new Error('模拟结果未知'); } }) });
  const args = { operationId: id, path: 'note.md', content: '正文', confirmed: true };
  assert.equal(creator.create(args).status, 'unknown');
  assert.equal(creator.inspect(id).reserved, true);
  assert.throws(() => creator.recover({ operationId: id, confirmed: true }), /未知/);
  assert.throws(() => creator.create(args), /已有记录/);
});

test('目标已存在不覆盖并释放预留', (t) => {
  const { vault, store, creator, id } = fixture(t);
  fs.writeFileSync(path.join(vault, 'note.md'), '原文');
  assert.equal(creator.create({ operationId: id, path: 'note.md', content: '新文', confirmed: true }).status, 'target_exists');
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), '原文');
  assert.equal(store.list().knowledgeReservations.length, 0);
});

test('完成日志存在但索引提交失败时可只恢复目录', (t) => {
  const { store, creator, id } = fixture(t);
  const original = store.completeKnowledgeReservation.bind(store);
  let fail = true;
  store.completeKnowledgeReservation = (...args) => { if (fail) { fail = false; throw new Error('模拟索引失败'); } return original(...args); };
  assert.equal(creator.create({ operationId: id, path: 'note.md', content: '正文', confirmed: true }).status, 'unknown');
  assert.equal(creator.inspect(id).status, 'completed');
  assert.throws(() => creator.recover({ operationId: id, confirmed: false }), /确认/);
  assert.equal(creator.recover({ operationId: id, confirmed: true }).recovered, true);
  assert.equal(store.list().knowledgeEntries.length, 1);
});

test('另一存储实例释放 preparing 预留后迟到创建不得写入', (t) => {
  const { store, vault, adapter, creator, id, currentVault } = fixture(t);
  const otherStore = new LocalStore(store.directory);
  const other = createDirectKnowledgeCreator({ store: otherStore, knowledgeStore: () => adapter, vaultId: () => currentVault });
  const transaction = store.transaction.bind(store); let count = 0; let writes = 0;
  const delayed = createDirectKnowledgeCreator({ store, vaultId: () => currentVault, knowledgeStore: () => ({ ...adapter, create(args) { writes++; return adapter.create(args); } }) });
  store.transaction = (fn, capability) => {
    if (++count === 2) assert.deepEqual(other.recover({ operationId: id, confirmed: true }), { operationId: id, status: 'not_written', recovered: true });
    return transaction(fn, capability);
  };
  try { assert.throws(() => delayed.create({ operationId: id, path: 'note.md', content: '正文', confirmed: true }), /预留已变化/); }
  finally { store.transaction = transaction; }
  assert.equal(writes, 0);
  assert.equal(fs.existsSync(path.join(vault, 'note.md')), false);
  assert.equal(store.list().knowledgeReservations.length, 0);
  assert.equal(creator.inspect(id).status, 'preparing');
});

test('完成记录摘要损坏时不能恢复目录', (t) => {
  const { root, store, creator, id } = fixture(t);
  store.completeKnowledgeReservation = () => { throw new Error('模拟索引失败'); };
  assert.equal(creator.create({ operationId: id, path: 'note.md', content: '正文', confirmed: true }).status, 'unknown');
  const file = path.join(root, 'data', 'direct-knowledge-creations', `${id}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')); record.revision = 'c'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(record));
  assert.throws(() => creator.recover({ operationId: id, confirmed: true }), /损坏/);
  assert.equal(store.list().knowledgeEntries.length, 0);
});

test('未知写入经确认核对后可关联或放弃，不重写并可查询结果', (t) => {
  const { store, adapter, id, currentVault, vault } = fixture(t);
  const creator = createDirectKnowledgeCreator({ store, vaultId: () => currentVault, knowledgeStore: () => ({ ...adapter, create(args) { adapter.create(args); throw new Error('模拟响应丢失'); } }) });
  assert.equal(creator.create({ operationId: id, path: 'note.md', content: '正文', confirmed: true }).status, 'unknown');
  const generation = store.list().knowledgeReservations[0].generation;
  assert.throws(() => creator.resolve({ operationId: id, generation, decision: 'link', confirmed: true }), /确认/);
  assert.equal(creator.inspectResolution({ operationId: id, generation }).status, 'pending');
  const result = creator.resolve({ operationId: id, generation, decision: 'link', acceptUncertain: true, confirmed: true });
  assert.equal(result.writeStatus, 'unknown');
  assert.equal(creator.inspectResolution({ operationId: id, generation }).decision, 'link');
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), '正文');
  assert.deepEqual(store.list().knowledgeEntries[0].origins, ['linked']);
});

test('不同知识库的新建记录不显示为损坏，也不暴露标识', (t) => {
  const { store, adapter, creator, id } = fixture(t);
  assert.equal(creator.create({ operationId: id, path: 'note.md', content: '正文', confirmed: true }).status, 'completed');
  const other = createDirectKnowledgeCreator({ store, knowledgeStore: () => adapter, vaultId: () => 'f'.repeat(64) });
  assert.deepEqual(other.list(), { items: [], warnings: [] });
});

test('未知结果内容改变时拒绝关联，但用户可明确放弃', (t) => {
  const { store, adapter, id, currentVault, vault } = fixture(t);
  const creator = createDirectKnowledgeCreator({ store, vaultId: () => currentVault, knowledgeStore: () => ({ ...adapter, create(args) { adapter.create(args); throw new Error('模拟响应丢失'); } }) });
  creator.create({ operationId: id, path: 'note.md', content: '正文', confirmed: true });
  const generation = creator.inspect(id).generation;
  fs.writeFileSync(path.join(vault, 'note.md'), '修改后的正文');
  assert.throws(() => creator.resolve({ operationId: id, generation, decision: 'link', acceptUncertain: true, confirmed: true }), /变化/);
  assert.equal(creator.resolve({ operationId: id, generation, decision: 'discard', acceptUncertain: true, confirmed: true }).decision, 'discard');
  assert.equal(creator.inspectResolution({ operationId: id, generation }).decision, 'discard');
  assert.equal(store.list().knowledgeEntries.length, 0);
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), '修改后的正文');
});

test('适配器返回错误路径或摘要时保持未知，不登记或释放预留', (t) => {
  for (const [index, result] of [{ path: 'other.md', revision: '0'.repeat(64) }, { path: 'note.md', revision: '0'.repeat(64) }, null].entries()) {
    const { store, adapter, currentVault } = fixture(t);
    const operationId = String(index + 1).repeat(64);
    const creator = createDirectKnowledgeCreator({ store, vaultId: () => currentVault, knowledgeStore: () => ({ ...adapter, create() { return result; } }) });
    assert.equal(creator.create({ operationId, path: 'note.md', content: '正文', confirmed: true }).status, 'unknown');
    assert.equal(store.list().knowledgeEntries.length, 0);
    assert.equal(store.list().knowledgeReservations.length, 1);
    assert.equal(creator.inspect(operationId).status, 'submitting');
  }
});

test('目标已存在但终态记录失败时保留预留并报告未知', (t) => {
  const { vault, root, store, creator, id } = fixture(t);
  fs.writeFileSync(path.join(vault, 'note.md'), '原文');
  const rename = fs.renameSync;
  const journal = path.join(root, 'data', 'direct-knowledge-creations', `${id}.json`);
  let calls = 0;
  fs.renameSync = (...args) => {
    if (args[1] === journal && ++calls === 2) throw new Error('模拟终态记录失败');
    return rename(...args);
  };
  try {
    assert.equal(creator.create({ operationId: id, path: 'note.md', content: '正文', confirmed: true }).status, 'unknown');
  } finally { fs.renameSync = rename; }
  assert.equal(store.list().knowledgeReservations.length, 1);
  assert.equal(creator.inspect(id).status, 'submitting');
  assert.throws(() => creator.recover({ operationId: id, confirmed: true }), /未知/);
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), '原文');
});

test('目标目录同步失败时保留已写文件及预留，不伪报目标已存在', (t) => {
  const { vault, store, creator, id } = fixture(t);
  const sync = fs.fsyncSync;
  const vaultStat = fs.statSync(vault);
  fs.fsyncSync = (fd) => {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory() && stat.dev === vaultStat.dev && stat.ino === vaultStat.ino) {
      const error = new Error('模拟目录同步失败'); error.code = 'EEXIST'; throw error;
    }
    return sync(fd);
  };
  try {
    assert.equal(creator.create({ operationId: id, path: 'note.md', content: '正文', confirmed: true }).status, 'unknown');
  } finally { fs.fsyncSync = sync; }
  assert.equal(fs.readFileSync(path.join(vault, 'note.md'), 'utf8'), '正文');
  assert.equal(store.list().knowledgeEntries.length, 0);
  assert.equal(store.list().knowledgeReservations.length, 1);
  assert.equal(creator.inspect(id).status, 'unknown');
  assert.throws(() => creator.recover({ operationId: id, confirmed: true }), /未知/);
});
