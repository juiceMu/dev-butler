const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMarkdownStore } = require('../src/markdown-store.cjs');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-store-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'notes'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'image.png'), 'image');
  return { dir, store: createMarkdownStore(dir) };
}

test('明确确认后创建标准 Markdown 并保持正文原样', (t) => {
  const { store } = fixture(t);
  const content = '# 标题\n\n    缩进\n\n![图](../assets/image.png)\n';
  assert.throws(() => store.create({ path: 'notes/a.md', content }), /明确确认/);
  store.create({ path: 'notes/a.md', content, confirmed: true, attachments: ['../assets/image.png'] });
  assert.equal(store.read('notes/a.md').content, content);
  assert.deepEqual(store.list(), ['notes/a.md']);
  assert.throws(() => store.create({ path: 'notes/a.md', content: '覆盖', confirmed: true }), { code: 'EEXIST' });
  assert.equal(store.read('notes/a.md').content, content);
});

test('目录浏览包含空目录且分页，不读取正文、不暴露隐藏项或符号链接', (t) => {
  const { dir, store } = fixture(t);
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.mkdirSync(path.join(dir, '.obsidian'));
  fs.writeFileSync(path.join(dir, 'notes', 'a.md'), '# 正文');
  fs.writeFileSync(path.join(dir, 'notes', 'b.MD'), '# 另一个文档');
  fs.writeFileSync(path.join(dir, 'notes', 'ignore.txt'), '其他');
  fs.writeFileSync(path.join(dir, 'notes', 'invalid\\name.md'), '无效路径');
  fs.symlinkSync(path.join(dir, 'notes'), path.join(dir, 'link'));
  assert.deepEqual(store.browse().items.map((item) => item.name), ['assets', 'empty', 'notes']);
  assert.deepEqual(store.browse({ directory: 'empty' }).items, []);
  const first = store.browse({ directory: 'notes', limit: 1 });
  assert.deepEqual(first.items, [{ name: 'a.md', path: 'notes/a.md', kind: 'note' }]);
  assert.equal(first.nextCursor, 'a.md');
  assert.deepEqual(store.browse({ directory: 'notes', cursor: first.nextCursor, limit: 1 }).items.map((item) => item.path), ['notes/b.MD']);
  assert.throws(() => store.browse({ directory: '../' }), /无效路径段/);
  assert.throws(() => store.browse({ directory: '.obsidian' }), /隐藏目录/);
  assert.throws(() => store.browse({ directory: 'link' }), /符号链接/);
  assert.throws(() => store.browse({ cursor: '../bad' }), /游标/);
  assert.throws(() => store.browse({ limit: 0 }), /上限/);
  assert.equal(store.read('notes/a.md').content, '# 正文');
});

test('拒绝越界、绝对路径及符号链接', (t) => {
  const { dir, store } = fixture(t);
  fs.symlinkSync(path.dirname(dir), path.join(dir, 'escape'));
  fs.symlinkSync(path.join(dir, 'assets', 'image.png'), path.join(dir, 'notes', 'link.png'));
  assert.throws(() => store.read('../outside.md'), /无效路径段/);
  assert.throws(() => store.create({ path: '/outside.md', content: 'x', confirmed: true }), /相对路径/);
  assert.throws(() => store.create({ path: 'escape/a.md', content: 'x', confirmed: true }), /符号链接/);
  assert.throws(() => store.validateAttachments('notes/a.md', ['../../outside']), /无效路径段/);
  assert.throws(() => store.validateAttachments('notes/a.md', ['link.png']), /符号链接/);
  assert.throws(() => store.validateAttachments('notes/a.md', ['https://example.com/a.png']), /相对路径/);
  assert.deepEqual(store.list(), []);
});

test('附件必须存在且必须是普通文件', (t) => {
  const { store } = fixture(t);
  assert.deepEqual(store.validateAttachments('notes/a.md', ['../assets/image.png']), ['../assets/image.png']);
  assert.throws(() => store.validateAttachments('notes/a.md', ['missing.png']), { code: 'ENOENT' });
  assert.throws(() => store.validateAttachments('notes/a.md', ['../assets']), /路径类型/);
});

test('正文搜索只读、返回匹配行并限制扫描范围', (t) => {
  const { store, dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'notes', 'a.md'), '# 事件流\n记录原因\n');
  fs.writeFileSync(path.join(dir, 'notes', 'b.md'), '其他内容\n');
  assert.deepEqual(store.search('事件流').results[0].matches, [{ line: '# 事件流', number: 1 }]);
  assert.equal(store.search('事件流', { limit: 1 }).truncated, true);
  assert.throws(() => store.search(''), /非空/);
  assert.throws(() => store.search('x', { limit: 0 }), /上限/);
  assert.equal(store.read('notes/a.md').content, '# 事件流\n记录原因\n');
});

test('正文搜索可继续扫描后续笔记并拒绝无效游标', (t) => {
  const { store, dir } = fixture(t);
  for (const name of ['a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(dir, 'notes', name), '目标内容');
  const first = store.search('目标', { limit: 1 });
  assert.equal(first.nextCursor, 'notes/a.md');
  const second = store.search('目标', { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.results.map((item) => item.path), ['notes/b.md']);
  const last = store.search('目标', { limit: 1, cursor: second.nextCursor });
  assert.deepEqual(last.results.map((item) => item.path), ['notes/c.md']);
  assert.equal(last.nextCursor, null);
  assert.equal(last.truncated, false);
  assert.throws(() => store.search('目标', { cursor: '../outside.md' }), /无效路径段/);
});

test('按路径推荐现有笔记和目录，说明匹配依据且不读取正文', (t) => {
  const { store, dir } = fixture(t);
  fs.mkdirSync(path.join(dir, 'notes', '订单项目'));
  fs.writeFileSync(path.join(dir, 'notes', '订单项目', '支付设计.md'), '私密正文');
  fs.writeFileSync(path.join(dir, 'notes', '订单项目', '无关.txt'), '不推荐');
  fs.symlinkSync(path.dirname(dir), path.join(dir, '订单项目外部'));
  const result = store.recommendLocations({ title: '支付', project: '订单项目' });
  assert.equal(result.candidates[0].path, 'notes/订单项目/支付设计.md');
  assert.equal(result.candidates[0].kind, 'note');
  assert.deepEqual(result.candidates[0].reasons.map((reason) => reason.type), ['title', 'project']);
  assert.ok(result.candidates.some((item) => item.path === 'notes/订单项目' && item.kind === 'directory'));
  assert.ok(result.candidates.every((item) => !item.path.includes('外部') && !item.path.endsWith('.txt')));
  assert.equal(JSON.stringify(result).includes('私密正文'), false);
  assert.equal(store.read('notes/订单项目/支付设计.md').content, '私密正文');
});

test('推荐限制扫描范围并拒绝无效条件', (t) => {
  const { store, dir } = fixture(t);
  for (let index = 0; index < 5; index++) fs.writeFileSync(path.join(dir, 'notes', `项目${index}.md`), '');
  const result = store.recommendLocations({ project: '项目', scanLimit: 1 });
  assert.equal(result.scanned, 1);
  assert.ok(result.nextCursor);
  assert.equal(result.truncated, false);
  const paths = result.candidates.map((entry) => entry.path);
  let cursor = result.nextCursor;
  while (cursor) {
    const page = createMarkdownStore(dir).recommendLocations({ project: '项目', scanLimit: 1, cursor });
    paths.push(...page.candidates.map((entry) => entry.path));
    cursor = page.nextCursor;
  }
  assert.deepEqual(paths, Array.from({ length: 5 }, (_, index) => `notes/项目${index}.md`));
  assert.throws(() => store.recommendLocations({ project: '项目', cursor: result.nextCursor }), /游标无效/);
  assert.throws(() => store.recommendLocations({}), /至少提供/);
  assert.throws(() => store.recommendLocations({ title: '项目', scanLimit: 1001 }), /推荐条件无效/);
  assert.throws(() => store.recommendLocations({ keywords: ['a', 1] }), /推荐条件无效/);
});

test('推荐拆分标题匹配，并排除现有路径接口不接受的名称', (t) => {
  const { store, dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'notes', '订单支付.md'), '');
  fs.writeFileSync(path.join(dir, 'notes', '支付\\非法.md'), '');
  const result = store.recommendLocations({ title: '修复订单支付问题' });
  assert.deepEqual(result.candidates.map((entry) => entry.path), ['notes/订单支付.md']);
  assert.ok(result.candidates[0].reasons.some((reason) => reason.value === '支付'));
  const first = store.recommendLocations({ project: '项目', scanLimit: 1 });
  assert.throws(() => store.recommendLocations({ project: '其他', cursor: first.nextCursor }), /游标无效/);
});

test('推荐游标绑定知识库和查询，后续页保持已建立的路径快照', (t) => {
  const { store, dir } = fixture(t);
  const other = fixture(t);
  fs.writeFileSync(path.join(dir, 'notes', '主题a.md'), '');
  fs.writeFileSync(path.join(dir, 'notes', '主题b.md'), '');
  const first = store.recommendLocations({ title: '主题', scanLimit: 1 });
  assert.throws(() => other.store.recommendLocations({ title: '主题', cursor: first.nextCursor }), /游标无效/);
  fs.writeFileSync(path.join(dir, 'notes', '主题c.md'), '');
  let cursor = first.nextCursor;
  const paths = first.candidates.map((entry) => entry.path);
  while (cursor) {
    const page = store.recommendLocations({ title: '主题', scanLimit: 1, cursor });
    paths.push(...page.candidates.map((entry) => entry.path));
    cursor = page.nextCursor;
  }
  assert.deepEqual(paths, ['notes/主题a.md', 'notes/主题b.md']);
});

test('只读检查标准 Markdown 引用并区分缺失、越界与外部资源', (t) => {
  const { store, dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'assets', '空 格.png'), 'image');
  fs.symlinkSync(path.join(dir, 'assets', 'image.png'), path.join(dir, 'notes', 'link.png'));
  const content = '![图][ref]\n\n[文件](../assets/%E7%A9%BA%20%E6%A0%BC.png)\n\n![缺失](missing.png)\n\n[越界](../../secret)\n\n[链接](link.png)\n\n[外部](https://example.com/a) [本页](#heading)\n\n`![代码](ignored.png)`\n\n[ref]: ../assets/image.png\n';
  fs.writeFileSync(path.join(dir, 'notes', 'a.md'), content);
  const result = store.inspectReferences('notes/a.md');
  assert.deepEqual(result.references.map(({ status }) => status), ['available', 'available', 'missing', 'invalid', 'invalid', 'external', 'fragment']);
  assert.equal(result.references[0].path, 'assets/image.png');
  assert.equal(result.references[1].path, 'assets/空 格.png');
  assert.equal(store.read('notes/a.md').content, content);
});

test('可在目标笔记尚不存在时检查草稿引用，不写入内容', (t) => {
  const { store, dir } = fixture(t);
  const result = store.inspectContentReferences('notes/new.md', '![存在](../assets/image.png) ![缺失](missing.png) [外链](https://example.com)');
  assert.deepEqual(result.references.map((item) => item.status), ['available', 'missing', 'external']);
  assert.equal(fs.existsSync(path.join(dir, 'notes', 'new.md')), false);
  assert.throws(() => store.inspectContentReferences('../outside.md', '内容'), /无效路径段/);
});
