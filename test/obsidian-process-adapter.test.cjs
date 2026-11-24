const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createObsidianProcessAdapter } = require('../src/obsidian-process-adapter.cjs');
const { createNoteUpdatePrototype } = require('../src/note-update-prototype.cjs');

const vaultId = 'a'.repeat(64);
class TFile { constructor(path) { this.path = path; } }

function fixture() {
  let content = '原文';
  let currentId = vaultId;
  let calls = 0;
  const file = new TFile('目录/笔记.md');
  const vault = {
    getAbstractFileByPath: (name) => name === file.path ? file : null,
    process: async (target, callback) => { calls++; assert.equal(target, file); content = callback(content); return content; },
  };
  const adapter = createObsidianProcessAdapter({ vault, vaultId, currentVaultId: () => currentId, TFile });
  return { adapter, vault, file, getContent: () => content, getCalls: () => calls, setId: (id) => { currentId = id; } };
}

test('在同步回调中比较原文后更新模拟笔记', async () => {
  const { adapter, getContent, getCalls } = fixture();
  await adapter(vaultId, '目录/笔记.md', (current) => { assert.equal(current, '原文'); return '新文'; });
  assert.equal(getContent(), '新文');
  assert.equal(getCalls(), 1);
});

test('拒绝错误知识库、不安全路径及不存在或非文件的目标', async () => {
  const { adapter, vault, setId, getCalls } = fixture();
  await assert.rejects(adapter('b'.repeat(64), '目录/笔记.md', () => '新文'), /知识库/);
  setId('b'.repeat(64));
  await assert.rejects(adapter(vaultId, '目录/笔记.md', () => '新文'), /知识库/);
  setId(vaultId);
  for (const name of ['../笔记.md', '/笔记.md', '目录/../笔记.md', '目录\\笔记.md', '笔记.txt', 'missing.md']) {
    await assert.rejects(adapter(vaultId, name, () => '新文'));
  }
  vault.getAbstractFileByPath = () => ({ path: '目录/笔记.md' });
  await assert.rejects(adapter(vaultId, '目录/笔记.md', () => '新文'), /不是文件/);
  assert.equal(getCalls(), 0);
});

test('内容不匹配和 process 异常不会报告成功', async () => {
  const { adapter, vault, getContent } = fixture();
  await assert.rejects(adapter(vaultId, '目录/笔记.md', () => { throw new Error('原文已变化'); }), /原文已变化/);
  assert.equal(getContent(), '原文');
  vault.process = async () => { throw new Error('处理失败'); };
  await assert.rejects(adapter(vaultId, '目录/笔记.md', () => '新文'), /处理失败/);
});

test('拒绝错误回调行为、异步处理结果及变化的知识库绑定', async () => {
  const { adapter, vault, setId } = fixture();
  vault.process = async (file, callback) => { try { callback('原文'); callback('原文'); } catch {} return '新文'; };
  await assert.rejects(adapter(vaultId, '目录/笔记.md', () => '新文'), /无法确认/);
  vault.process = async (file, callback) => { try { callback('原文'); } catch {} return '新文'; };
  await assert.rejects(adapter(vaultId, '目录/笔记.md', async () => '新文'), /无法确认/);
  vault.process = async (file, callback) => { setId('b'.repeat(64)); return callback('原文'); };
  await assert.rejects(adapter(vaultId, '目录/笔记.md', () => '新文'), /知识库/);
});

test('与更新状态机联动时，在处理回调核对原文且不重复执行', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-adapter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { adapter, getContent, getCalls } = fixture();
  const workflow = createNoteUpdatePrototype({ directory, processNote: adapter });
  const input = { requestId: 'request-1', vaultId, notePath: '目录/笔记.md', draftId: 'draft', revision: 1, before: '原文', after: '新文' };
  const request = { ...input, confirmation: workflow.preview(input).confirmation, confirmed: true };
  assert.equal((await workflow.submit(request)).status, 'completed');
  assert.equal((await workflow.submit(request)).status, 'completed');
  assert.equal(getContent(), '新文');
  assert.equal(getCalls(), 1);

  const stale = { ...input, requestId: 'request-2', after: '另一版本' };
  const staleRequest = { ...stale, confirmation: workflow.preview(stale).confirmation, confirmed: true };
  assert.equal((await workflow.submit(staleRequest)).status, 'unknown');
  assert.equal(getContent(), '新文');
});
