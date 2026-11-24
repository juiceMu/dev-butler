const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNoteUpdatePrototype } = require('../src/note-update-prototype.cjs');

function fixture(t, processNote) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'note-prototype-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prototype = createNoteUpdatePrototype({ directory, processNote });
  const input = { requestId: 'attempt-1', vaultId: 'a'.repeat(64), notePath: '项目/记录.md', draftId: 'draft-1', revision: 1, before: '原文', after: '新文' };
  return { prototype, input, directory, confirmed: () => ({ ...input, confirmation: prototype.preview(input).confirmation, confirmed: true }) };
}

test('确认绑定所有目标及正文，成功后相同请求不能再执行', async (t) => {
  let note = '原文'; let calls = 0;
  const f = fixture(t, async (vault, target, update) => { calls++; assert.equal(vault, f.input.vaultId); assert.equal(target, f.input.notePath); note = update(note); });
  const request = f.confirmed();
  for (const change of [{ vaultId: 'b'.repeat(64) }, { notePath: 'other.md' }, { revision: 2 }, { before: '其他' }, { after: '其他' }, { draftId: 'other' }]) {
    await assert.rejects(f.prototype.submit({ ...request, ...change }), /确认与内容不一致/);
  }
  await assert.rejects(f.prototype.submit({ ...request, confirmed: false }), /明确确认/);
  assert.equal((await f.prototype.submit(request)).status, 'completed');
  assert.equal(note, '新文');
  assert.equal((await f.prototype.submit(request)).status, 'completed');
  const changed = { ...f.input, after: '另一版本' };
  assert.equal((await f.prototype.submit({ ...changed, confirmation: f.prototype.preview(changed).confirmation, confirmed: true })).status, 'conflict');
  assert.equal(calls, 1);
});

test('重启后已有提交记录禁止再次处理，错误路径在持久化之前拒绝', async (t) => {
  let calls = 0;
  const f = fixture(t, async (_vault, _target, update) => { calls++; update('原文'); });
  assert.throws(() => f.prototype.preview({ ...f.input, notePath: '../other.md' }), /请求无效/);
  assert.deepEqual(fs.readdirSync(f.directory), []);
  const request = f.confirmed();
  assert.equal((await f.prototype.submit(request)).status, 'completed');
  const restarted = createNoteUpdatePrototype({ directory: f.directory, processNote: async () => { calls++; } });
  assert.equal((await restarted.query(request)).status, 'completed');
  assert.equal((await restarted.submit(request)).status, 'completed');
  assert.equal(calls, 1);
});

test('结果记录缺失、损坏或绑定不匹配均为未知且不重复执行', async (t) => {
  let calls = 0;
  const f = fixture(t, async (_vault, _target, update) => { calls++; update('原文'); });
  const request = f.confirmed();
  assert.equal((await f.prototype.submit(request)).status, 'completed');
  const record = fs.readdirSync(f.directory).find((name) => name.endsWith('.json'));
  const result = path.join(f.directory, `${record}.result`);
  const original = JSON.parse(fs.readFileSync(result, 'utf8'));
  fs.writeFileSync(result, '{');
  assert.equal(f.prototype.query(request).status, 'unknown');
  fs.writeFileSync(result, JSON.stringify({ ...original, vaultId: 'b'.repeat(64) }));
  assert.equal((await f.prototype.submit(request)).status, 'unknown');
  fs.unlinkSync(result);
  assert.equal(f.prototype.query(request).status, 'unknown');
  fs.writeFileSync(path.join(f.directory, record), '{}');
  assert.equal(f.prototype.query(request).status, 'unknown');
  assert.equal(calls, 1);
});

test('原文已改变或更新抛错均不重试', async (t) => {
  let calls = 0; let note = '外部修改';
  const f = fixture(t, async (_vault, _target, update) => { calls++; note = update(note); });
  const request = f.confirmed();
  assert.equal((await f.prototype.submit(request)).status, 'unknown');
  assert.equal(note, '外部修改');
  assert.equal((await f.prototype.submit(request)).status, 'unknown');
  assert.equal(calls, 1);
});

test('适配器发现知识库不匹配时结果未知且不重复请求', async (t) => {
  let calls = 0;
  const f = fixture(t, async (vault) => { calls++; if (vault !== 'b'.repeat(64)) throw new Error('知识库不匹配'); });
  const request = f.confirmed();
  assert.equal((await f.prototype.submit(request)).status, 'unknown');
  assert.equal((await f.prototype.submit(request)).status, 'unknown');
  assert.equal(calls, 1);
});

test('适配器吞掉原文不一致或重复回调的错误仍不能报告完成', async (t) => {
  for (const mode of ['mismatch', 'duplicate']) {
    let calls = 0;
    const f = fixture(t, async (_vault, _target, update) => {
      calls++;
      try {
        if (mode === 'mismatch') update('外部修改');
        else { update('原文'); update('原文'); }
      } catch { /* 模拟不可靠适配器吞掉回调异常。 */ }
    });
    const request = f.confirmed();
    assert.equal((await f.prototype.submit(request)).status, 'unknown');
    assert.equal(f.prototype.query(request).status, 'unknown');
    assert.equal((await f.prototype.submit(request)).status, 'unknown');
    assert.equal(calls, 1);
  }
});

test('写入后记录失败仍不重试', async (t) => {
  let calls = 0; let note = '原文';
  const f = fixture(t, async (_vault, _target, update) => {
    calls++; note = update(note);
    const attempt = fs.readdirSync(f.directory).find((name) => name.endsWith('.json'));
    fs.mkdirSync(path.join(f.directory, `${attempt}.result`));
  });
  const request = f.confirmed();
  assert.equal((await f.prototype.submit(request)).status, 'unknown');
  assert.equal(note, '新文');
  assert.equal((await f.prototype.submit(request)).status, 'unknown');
  assert.equal(calls, 1);
});

test('并发相同请求只调用一次适配器', async (t) => {
  let calls = 0; let resolve;
  const f = fixture(t, async (_vault, _target, update) => { calls++; await new Promise((done) => { resolve = done; }); update('原文'); });
  const request = f.confirmed();
  const first = f.prototype.submit(request);
  assert.equal((await f.prototype.submit(request)).status, 'unknown');
  resolve();
  assert.equal((await first).status, 'completed');
  assert.equal(calls, 1);
});

test('异步处理期间修改请求不会改变已确认的写入内容', async (t) => {
  let release; let note = '原文';
  const f = fixture(t, async (_vault, _target, update) => {
    await new Promise((resolve) => { release = resolve; });
    note = update(note);
  });
  const request = f.confirmed();
  const original = { ...request };
  const pending = f.prototype.submit(request);
  request.after = '未确认的内容';
  request.before = '其他原文';
  request.vaultId = 'b'.repeat(64);
  request.notePath = 'other.md';
  request.confirmation = 'invalid';
  release();
  assert.equal((await pending).status, 'completed');
  assert.equal(note, original.after);
  assert.equal(f.prototype.query(original).status, 'completed');
});
