const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const MarkdownIt = require('markdown-it');
const { createHistoryCandidate } = require('../src/history-candidate.cjs');

const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
function input(before, text, conclusion = '新方案') {
  const start = before.indexOf(text);
  return { before, beforeDigest: digest(before), selection: { start, end: start + text.length, text }, conclusion };
}

test('保留原文并明确呈现指定历史片段与当前结论', () => {
  const before = '# 原有说明\r\n\r\n旧结论\r\n其他正文';
  const candidate = createHistoryCandidate(input(before, '旧结论', '新结论'));
  assert.ok(candidate.afterContent.startsWith(before));
  assert.match(candidate.appendedContent, /\*\*引用原文\*\*\r\n\r\n```\r\n旧结论\r\n```/);
  assert.match(candidate.appendedContent, /\*\*新结论\*\*\r\n\r\n新结论/);
  const recordMarker = `%% 记录标识：${candidate.recordId} %%`;
  assert.equal(candidate.afterContent, [before, '', recordMarker, '', candidate.appendedContent, ''].join('\r\n'));
  assert.doesNotMatch(candidate.appendedContent, /记录标识|UTF-16/);
  assert.equal(candidate.selection.startLine, 3);
  assert.equal(candidate.afterDigest, digest(candidate.afterContent));
  assert.equal(candidate.beforeDigest, digest(before));
});

test('重复文本以明确偏移绑定，过期摘要与错误范围拒绝', () => {
  const before = '旧结论，旧结论';
  const value = input(before, '旧结论');
  value.selection.start = 4;
  value.selection.end = 7;
  const second = createHistoryCandidate(value);
  assert.equal(second.selection.start, 4);
  assert.notEqual(second.recordId, createHistoryCandidate(input(before, '旧结论')).recordId);
  assert.throws(() => createHistoryCandidate({ ...value, beforeDigest: '0'.repeat(64) }), /摘要无效/);
  assert.throws(() => createHistoryCandidate({ ...value, selection: { ...value.selection, start: 0, end: 2 } }), /片段与原文不匹配/);
  const emoji = input('旧😀方案', '😀');
  emoji.selection = { start: 1, end: 2, text: '😀'[0] };
  assert.throws(() => createHistoryCandidate(emoji), /拆分字符/);
  const newline = input('旧\r\n结论', '\n结论');
  assert.throws(() => createHistoryCandidate(newline), /拆分换行/);
});

test('新结论不得引入影响原文的引用定义、标题或块标识', () => {
  for (const conclusion of ['[旧引用]: https://example.com', '> [旧引用]: /target', '[^脚注]: 内容', '# 标题', '标题\n===', '内容 ^block-id']) {
    assert.throws(() => createHistoryCandidate(input('[旧引用]', '[旧引用]', conclusion)), /全局引用定义|原有锚点|块标识/);
  }
  const candidate = createHistoryCandidate(input('[旧引用]', '[旧引用]', '常规结论，可包含 [内联链接](https://example.com)。'));
  assert.ok(candidate.afterContent.startsWith('[旧引用]'));
  const markdown = new MarkdownIt();
  assert.ok(markdown.render(candidate.afterContent).startsWith(markdown.render('[旧引用]')));
});

test('引用内容包含围栏与标题时不会破坏引用边界', () => {
  const before = '旧结论\n```\n# 内容\n```';
  const result = createHistoryCandidate(input(before, before));
  assert.ok(result.afterContent.includes('````\n旧结论\n```\n# 内容\n```\n````'));
});

test('拒绝未闭合结构及无法可靠处理的 HTML', () => {
  for (const before of ['旧结论\n```', '旧结论\n```js\n代码', '---\n未闭合', '旧结论\n<!-- 未闭合', '旧结论\n<div>内容</div>', '旧结论\n$$\n公式', '旧结论\n%%未闭合']) {
    assert.throws(() => createHistoryCandidate(input(before, '旧结论')));
  }
  assert.throws(() => createHistoryCandidate(input('旧结论', '旧结论', '```\n未闭合')), /围栏未闭合/);
});

test('拒绝重复记录、无效输入和超长候选', () => {
  const original = '旧结论';
  const first = createHistoryCandidate(input(original, original));
  assert.throws(() => createHistoryCandidate(input(first.afterContent, original)), /相同结论已存在/);
  for (const marker of [`记录标识：${first.recordId}`, `## 结论变更 ${first.recordId}`]) {
    assert.throws(() => createHistoryCandidate(input(`${original}\n\n${marker}`, original)), /相同结论已存在/);
  }
  assert.doesNotThrow(() => createHistoryCandidate(input(first.afterContent, original, '后续的新结论')));
  assert.throws(() => createHistoryCandidate(input(original, original, ' ')), /新结论无效/);
  const large = `${'x'.repeat(99990)}旧结论`;
  assert.throws(() => createHistoryCandidate(input(large, '旧结论')), /超过更新预览限制/);
});
