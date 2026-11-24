// 隔离原型：适配器 resolve 必须代表持久完成；本模块无法自行验证，亦不保证跨进程条件写。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function createNoteUpdatePrototype({ directory, processNote }) {
  if (!path.isAbsolute(directory) || typeof processNote !== 'function') throw new Error('原型配置无效');
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('原型记录目录无效');

  function validate(input) {
    const { requestId, vaultId, notePath, draftId, revision, before, after, confirmation } = input;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) ||
        typeof vaultId !== 'string' || !/^[a-f0-9]{64}$/.test(vaultId) ||
        typeof notePath !== 'string' || !notePath.endsWith('.md') || notePath.startsWith('/') || notePath.includes('\\') || notePath.includes('\0') || notePath.split('/').some((part) => !part || part === '.' || part === '..') ||
        typeof draftId !== 'string' || !draftId || draftId.length > 200 || !Number.isSafeInteger(revision) || revision < 1 ||
        typeof before !== 'string' || typeof after !== 'string' || !after.trim() || before.length > 100000 || after.length > 100000) throw new Error('请求无效');
    const binding = { requestId, vaultId, notePath, draftId, revision, beforeDigest: hash(before), afterDigest: hash(after) };
    if (confirmation !== hash(JSON.stringify(binding))) throw new Error('确认与内容不一致');
    return binding;
  }

  function preview(input) {
    const binding = { requestId: input.requestId, vaultId: input.vaultId, notePath: input.notePath, draftId: input.draftId, revision: input.revision, beforeDigest: hash(input.before), afterDigest: hash(input.after) };
    const confirmation = hash(JSON.stringify(binding));
    validate({ ...input, confirmation });
    return { ...binding, confirmation };
  }

  function writeExclusive(file, value) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const parent = fs.openSync(directory, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }

  function query(input) {
    const binding = validate(input);
    const attempt = path.join(directory, `${hash(binding.requestId)}.json`);
    let previous;
    try { previous = JSON.parse(fs.readFileSync(attempt, 'utf8')); }
    catch { return { status: 'unknown', message: '记录不存在或不完整，请核查' }; }
    if (!previous || typeof previous !== 'object' || Array.isArray(previous) || previous.status !== 'submitting' ||
        ['requestId', 'vaultId', 'notePath', 'draftId', 'beforeDigest', 'afterDigest'].some((key) => typeof previous[key] !== 'string' || !previous[key]) ||
        !Number.isSafeInteger(previous.revision) || previous.revision < 1 || !/^[a-f0-9]{64}$/.test(previous.vaultId) ||
        !/^[a-f0-9]{64}$/.test(previous.beforeDigest) || !/^[a-f0-9]{64}$/.test(previous.afterDigest)) return { status: 'unknown', message: '请求记录无效，请核查' };
    if (Object.keys(binding).some((key) => previous[key] !== binding[key])) return { status: 'conflict', message: '请求标识已绑定其他内容' };
    try {
      const result = JSON.parse(fs.readFileSync(`${attempt}.result`, 'utf8'));
      if (Object.keys(binding).some((key) => result[key] !== binding[key]) || !['completed', 'unknown'].includes(result.status)) throw new Error('记录无效');
      return { status: result.status };
    } catch { return { status: 'unknown', message: '结果记录缺失或无效，请核查' }; }
  }

  async function submit(input) {
    const snapshot = { ...input };
    if (snapshot.confirmed !== true) throw new Error('必须明确确认');
    const binding = validate(snapshot);
    const attempt = path.join(directory, `${hash(binding.requestId)}.json`);
    try { writeExclusive(attempt, { ...binding, status: 'submitting' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return query(snapshot);
    }
    let status = 'unknown';
    let invoked = false;
    let matched = false;
    let callbackFailed = false;
    try {
      await processNote(binding.vaultId, binding.notePath, (current) => {
        if (invoked) { callbackFailed = true; throw new Error('重复调用'); }
        invoked = true;
        if (typeof current !== 'string' || hash(current) !== binding.beforeDigest) { callbackFailed = true; throw new Error('原笔记已变化'); }
        matched = true;
        return snapshot.after;
      });
      if (matched && !callbackFailed) status = 'completed';
    } catch { /* 更新结果不能从异常推断。 */ }
    const terminal = `${attempt}.result`;
    try { writeExclusive(terminal, { ...binding, status }); } catch { status = 'unknown'; }
    return { status };
  }
  return { preview, submit, query };
}

module.exports = { createNoteUpdatePrototype };
