const { spawn } = require('node:child_process');
const readline = require('node:readline');

const METHODS = new Set(['project/list', 'thread/list', 'thread/read', 'thread/start', 'thread/turns/list']);

function createAppServerRequest({ command = 'codex', timeoutMs = 30000, spawnProcess = spawn } = {}) {
  if (typeof command !== 'string' || !command || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Codex 服务配置无效');
  return async function request(method, params, options = {}) {
    if (!METHODS.has(method)) throw new Error('不允许调用此 Codex 方法');
    const title = typeof options.title === 'string' && options.title.trim() ? options.title : '开发管家工作项会话';
    return new Promise((resolve, reject) => {
      let child;
      let lines;
      let settled = false;
      let stage = 'initialize';
      let created;
      let size = 0;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (lines) lines.close();
        if (child) { child.stdin?.end(); child.kill('SIGTERM'); }
        if (error) reject(error); else resolve(value);
      };
      const fail = () => {
        const uncertain = method === 'thread/start' && ['request', 'name'].includes(stage);
        const error = new Error(uncertain ? '创建结果不确定，请先检查会话列表，勿重复创建' : 'Codex 服务连接失败或不支持所需能力');
        error.code = uncertain ? 'CODEX_CREATE_UNCERTAIN' : 'CODEX_UNAVAILABLE';
        if (created?.thread?.id) error.recoverySessionId = created.thread.id;
        finish(error);
      };
      const timer = setTimeout(fail, timeoutMs);
      try {
        child = spawnProcess(command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.on('error', fail);
        child.on('exit', () => { if (!settled) fail(); });
        child.stdin.on('error', fail);
        child.stderr.on('data', () => {});
        lines = readline.createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          size += Buffer.byteLength(line);
          if (size > 8 * 1024 * 1024) return fail();
          let message;
          try { message = JSON.parse(line); } catch { return fail(); }
          if (message.id === 1 && stage === 'initialize') {
            if (message.error || !message.result) return fail();
            child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
            stage = 'request';
            child.stdin.write(JSON.stringify({ id: 2, method, params }) + '\n');
          } else if (message.id === 2 && stage === 'request') {
            if (message.error) {
              const error = new Error('Codex 请求被拒绝或当前版本不支持该功能');
              error.code = 'CODEX_REQUEST_REJECTED';
              return finish(error);
            }
            if (method === 'thread/start') {
              if (typeof message.result?.thread?.id !== 'string') return fail();
              created = message.result; stage = 'name';
              child.stdin.write(JSON.stringify({ id: 3, method: 'thread/name/set', params: { threadId: created.thread.id, name: title } }) + '\n');
            } else finish(null, message.result);
          } else if (message.id === 3 && stage === 'name') {
            if (message.error || !message.result) return fail();
            created.thread.name = title;
            finish(null, created);
          }
        });
        child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'x-assistant', version: '1.0.0' }, capabilities: { experimentalApi: true } } }) + '\n');
      } catch { fail(); }
    });
  };
}

module.exports = { createAppServerRequest };

function createInitialTurn({ command = 'codex', timeoutMs = 90000, spawnProcess = spawn } = {}) {
  return async ({ threadId, message }) => new Promise((resolve, reject) => {
    let child; let lines; let settled = false; let stage = 'initialize'; let sent = false; let turnId; let completed;
    let size = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); lines?.close();
      if (child) { child.stdin?.end(); child.kill('SIGTERM'); }
      if (error) reject(error); else resolve(value);
    };
    const fail = () => {
      const error = new Error(sent ? '首条消息的发送结果不确定，请检查会话，勿重复发送' : '无法启动首条消息');
      error.code = sent ? 'CODEX_TURN_UNCERTAIN' : 'CODEX_TURN_NOT_SENT';
      finish(error);
    };
    const timer = setTimeout(fail, timeoutMs);
    try {
      child = spawnProcess(command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', fail); child.on('exit', () => { if (!settled) fail(); }); child.stdin.on('error', fail); child.stderr.on('data', () => {});
      lines = readline.createInterface({ input: child.stdout });
      const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
      lines.on('line', (line) => {
        size += Buffer.byteLength(line); if (size > 8 * 1024 * 1024) return fail();
        let value; try { value = JSON.parse(line); } catch { return fail(); }
        if (value.method === 'turn/completed' && value.params?.threadId === threadId) {
          completed = value.params.turn;
          if (turnId && completed?.id === turnId) finish(null, { status: completed.status });
        }
        if (value.id === 1 && stage === 'initialize') {
          if (value.error || !value.result) return fail();
          send({ method: 'initialized', params: {} }); stage = 'resume';
          send({ id: 2, method: 'thread/resume', params: { threadId, excludeTurns: true } });
        } else if (value.id === 2 && stage === 'resume') {
          if (value.error || value.result?.thread?.id !== threadId) return fail();
          stage = 'turn'; sent = true;
          send({ id: 3, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: message }] } });
        } else if (value.id === 3 && stage === 'turn') {
          if (value.error || typeof value.result?.turn?.id !== 'string') return fail();
          turnId = value.result.turn.id;
          if (completed?.id === turnId) finish(null, { status: completed.status });
        }
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'x-assistant', version: '1.0.0' }, capabilities: { experimentalApi: true } } });
    } catch { fail(); }
  });
}

module.exports.createInitialTurn = createInitialTurn;
