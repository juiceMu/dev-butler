const crypto = require('node:crypto');
const MarkdownIt = require('markdown-it');

const MAX_CONTENT = 100000;
const MAX_SELECTION = 10000;
const markdown = new MarkdownIt({ html: true });
const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function assertClosedStructures(text) {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[0]?.replace(/^\uFEFF/, '') === '---' && !lines.slice(1).some((line) => /^(?:---|\.\.\.)\s*$/.test(line))) throw new Error('YAML 头部未闭合，不能追加');
  const tokens = markdown.parse(text, {});
  const excluded = new Set();
  for (const token of tokens) {
    if (token.type === 'html_block' || token.children?.some((child) => child.type === 'html_inline')) throw new Error('包含 HTML 结构，不能安全追加');
    if (token.type !== 'fence') continue;
    for (let index = token.map[0]; index < token.map[1]; index++) excluded.add(index);
    const closing = lines[token.map[1] - 1].replace(/^\s*(?:>\s*)*/, '').trim();
    const marker = token.markup[0];
    if (token.map[1] - token.map[0] < 2 || !closing || [...closing].some((character) => character !== marker) || closing.length < token.markup.length) throw new Error('代码围栏未闭合，不能追加');
  }
  const plain = lines.filter((_, index) => !excluded.has(index)).join('\n');
  if ((plain.match(/%%/g) || []).length % 2) throw new Error('Obsidian 注释未闭合，不能追加');
  if ((plain.match(/\$\$/g) || []).length % 2) throw new Error('公式块未闭合，不能追加');
}

function assertIsolatedConclusion(text) {
  const environment = {};
  const tokens = markdown.parse(text, environment);
  if (environment.references && Object.keys(environment.references).length) throw new Error('新结论不能包含全局引用定义');
  if (tokens.some((token) => token.type === 'heading_open')) throw new Error('新结论不能包含标题，以免影响原有锚点');
  if (/(?:^|\s)\^[\p{L}\p{N}_-]+\s*$/mu.test(text)) throw new Error('新结论不能包含块标识，以免影响原有引用');
}

function lineAt(text, offset) {
  return (text.slice(0, offset).match(/\r\n|\r|\n/g) || []).length + 1;
}

function codeFence(text) {
  return '`'.repeat(Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)) + 1);
}

function createHistoryCandidate({ before, beforeDigest, selection, conclusion, fenceUnsafeConclusion = false } = {}) {
  if (typeof before !== 'string' || before.length > MAX_CONTENT || typeof beforeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(beforeDigest) || hash(before) !== beforeDigest) throw new Error('原文或摘要无效，请重新读取');
  if (!selection || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) ||
      selection.start < 0 || selection.end <= selection.start || selection.end > before.length ||
      typeof selection.text !== 'string' || selection.text.length > MAX_SELECTION ||
      before.slice(selection.start, selection.end) !== selection.text || !selection.text.trim()) throw new Error('历史片段与原文不匹配');
  if ((selection.start > 0 && /[\uD800-\uDBFF]/.test(before[selection.start - 1]) && /[\uDC00-\uDFFF]/.test(before[selection.start])) ||
      (selection.end < before.length && /[\uD800-\uDBFF]/.test(before[selection.end - 1]) && /[\uDC00-\uDFFF]/.test(before[selection.end]))) throw new Error('历史片段不能拆分字符');
  if ((before[selection.start - 1] === '\r' && before[selection.start] === '\n') || (before[selection.end - 1] === '\r' && before[selection.end] === '\n')) throw new Error('历史片段不能拆分换行');
  if (typeof conclusion !== 'string' || !conclusion.trim() || conclusion.length > (fenceUnsafeConclusion ? MAX_CONTENT : MAX_SELECTION)) throw new Error('新结论无效或过长');
  assertClosedStructures(before);
  let conclusionFence;
  try {
    assertClosedStructures(conclusion);
    assertIsolatedConclusion(conclusion);
  } catch (error) {
    if (!fenceUnsafeConclusion) throw error;
    conclusionFence = codeFence(conclusion);
  }
  const recordId = hash(JSON.stringify([selection.start, selection.end, selection.text, conclusion]));
  const recordMarker = `记录标识：${recordId}`;
  if (before.includes(recordMarker) || before.includes(`## 结论变更 ${recordId}`)) throw new Error('相同结论已存在，请先检查原文');
  const fence = codeFence(selection.text);
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const quoted = selection.text.replace(/\r\n|\r|\n/g, eol);
  const startLine = lineAt(before, selection.start);
  const endLine = lineAt(before, selection.end - 1);
  const appendedContent = [
    '**引用原文**', '', fence, quoted, fence,
    '', '**新结论**', '', ...(conclusionFence ? [`${conclusionFence}markdown`, conclusion, conclusionFence] : [conclusion]),
  ].join(eol);
  const afterContent = [before, '', `%% ${recordMarker} %%`, '', appendedContent, ''].join(eol);
  if (afterContent.length > MAX_CONTENT) throw new Error('生成内容超过更新预览限制');
  return { beforeDigest, afterDigest: hash(afterContent), afterContent, appendedContent, recordId, selection: { ...selection, startLine, endLine }, ...(conclusionFence ? { conclusionFormat: 'markdown-source' } : {}) };
}

module.exports = { createHistoryCandidate };
