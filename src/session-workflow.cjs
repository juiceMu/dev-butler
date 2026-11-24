const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { issueKey } = require('./core.cjs');

function attemptId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(value)) throw new Error('创建尝试 ID 无效');
  return value;
}

function createSessionWorkflow({ directory, store, codex, verifyBeforeLink = async () => {} }) {
  const root = path.join(directory, 'session-attempts');
  function location(id) { return path.join(root, `${attemptId(id)}.json`); }
  function read(id) {
    try { return JSON.parse(fs.readFileSync(location(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('创建记录不存在'); throw error; }
  }
  function write(item, exclusive = false) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = location(item.attemptId);
    if (exclusive) {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(item)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return;
    }
    const temp = path.join(root, `.attempt-${crypto.randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(item)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function link(item) {
    const existing = store.list().links.find((link) => link.sessionId === item.sessionId && issueKey(link.issue) === issueKey(item.issue));
    if (!existing) store.addLink({ issue: item.issue, sessionId: item.sessionId, sessionTitle: item.sessionTitle || '', primary: item.primary });
    const linked = { ...item, status: 'linked' }; write(linked); return linked;
  }
  function locked(fn) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const lock = path.join(root, '.reservation.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error(`创建记录被锁定；如进程异常退出，请先确认没有创建操作运行，再检查锁文件 ${lock}`); throw error; }
    try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  function list() {
    try { return fs.readdirSync(root).filter((name) => /^[a-zA-Z0-9-]{16,100}\.json$/.test(name)).map((name) => read(name.slice(0, -5))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function sendInitial(id) {
    const sending = locked(() => {
      const current = read(id);
      if (current.status !== 'linked' || current.messageStatus !== 'not_sent' || !current.sessionId || !current.initialMessage) throw new Error('当前状态不能发送首条消息');
      const next = { ...current, messageStatus: 'sending' }; write(next); return next;
    });
    try {
      const result = await codex.initialTurn({ threadId: sending.sessionId, message: sending.initialMessage });
      sending.messageStatus = result.status === 'completed' ? 'completed' : ['failed', 'interrupted', 'cancelled'].includes(result.status) ? 'failed' : 'unknown';
      sending.turnStatus = result.status;
    } catch (error) {
      sending.messageStatus = error.code === 'CODEX_TURN_NOT_SENT' ? 'not_sent' : 'unknown';
    }
    try { write(sending); } catch { return { ...sending, messageStatus: 'unknown' }; }
    return sending;
  }
  return {
    get(id) { return read(id); },
    list,
    async create({ attemptId: id, issue, userId, projectId, cwd, primary = false, initialMessage }) {
      attemptId(id); issueKey(issue);
      const item = { attemptId: id, issue, userId, projectId, cwd, primary, initialMessage, status: 'creating' };
      const prior = locked(() => {
        const attempts = list();
        const prior = attempts.find((entry) => entry.attemptId === id);
        if (prior) {
          if (issueKey(prior.issue) !== issueKey(issue) || prior.userId !== userId || prior.projectId !== projectId || prior.cwd !== cwd || prior.primary !== primary || prior.initialMessage !== initialMessage) throw new Error('创建尝试 ID 已用于其他请求');
          return prior;
        }
        const pending = attempts.find((entry) => ['creating', 'unknown', 'created'].includes(entry.status) && issueKey(entry.issue) === issueKey(issue) && entry.projectId === projectId && entry.cwd === cwd);
        if (pending) throw new Error(`已有未完成的创建尝试 ${pending.attemptId}，请先处理`);
        write(item, true); return null;
      });
      if (prior) return prior;
      let created;
      try { created = await codex.create({ projectId, cwd, title: issue.title }); }
      catch (error) {
        item.status = 'unknown';
        if (typeof error.recoverySessionId === 'string') item.recoverySessionId = error.recoverySessionId;
        try { write(item); } catch {}
        return item;
      }
      item.sessionId = created.id; item.sessionTitle = created.title || ''; item.status = 'created';
      if (initialMessage) item.messageStatus = 'not_sent';
      try { write(item); } catch { return { ...item, status: 'unknown', recoverySessionId: created.id }; }
      try { await verifyBeforeLink(item); } catch { return item; }
      let linked;
      try { linked = link(item); } catch { return item; }
      if (!initialMessage) return linked;
      // 会话及关联已经保存，首条消息在后台处理，避免页面等待整轮回复。
      void sendInitial(id).catch(() => {});
      return read(id);
    },
    finish(id) {
      const item = read(id);
      if (item.status === 'linked') return item;
      if (item.status !== 'created' || !item.sessionId) throw new Error('创建结果尚未确认，不能自动重试');
      return link(item);
    },
    recover(id, session) {
      return locked(() => {
        const item = read(id);
        if (item.status !== 'unknown' || !item.recoverySessionId || session.id !== item.recoverySessionId || typeof session.cwd !== 'string' || !path.isAbsolute(session.cwd) || typeof item.cwd !== 'string' || !path.isAbsolute(item.cwd) || path.resolve(session.cwd) !== path.resolve(item.cwd)) throw new Error('创建记录或会话目录不匹配，请手动核查');
        const recovered = { ...item, status: 'created', sessionId: session.id, sessionTitle: session.title || '', ...(item.initialMessage ? { messageStatus: 'not_sent' } : {}) };
        write(recovered);
        return recovered;
      });
    },
    sendInitial,
    abandon(id) {
      return locked(() => {
        const item = read(id);
        if (item.status !== 'unknown') throw new Error('只有已结束且结果不确定的创建尝试可以解除阻止');
        const abandoned = { ...item, status: 'abandoned' }; write(abandoned); return abandoned;
      });
    },
  };
}
module.exports = { createSessionWorkflow };
