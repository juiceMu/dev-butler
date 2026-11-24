const { spawn } = require('node:child_process');
const readline = require('node:readline');

const SUMMARY_PROMPT = '请直接输出 Markdown 正文，不调用工具、不执行命令、不修改文件。仅依据已有会话上下文生成可审核的知识草稿，概括问题、背景、关键决策、实现或排查结果、验证情况和未解决事项；仅陈述有依据的内容，不确定之处标记待确认，不包含凭据。';
const ENDED_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const TEXT_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction']);

function createSessionSummary({ command = 'codex', timeoutMs = 90000, spawnProcess = spawn } = {}) {
  return async (threadId) => {
    if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200) throw new Error('会话标识无效');
    return new Promise((resolve, reject) => {
      let child; let lines; let stage = 'initialize'; let sourceTurnId; let forkId; let turnId; let summary;
      let settled = false; let size = 0;
      const messages = new Map();
      const completedTurns = new Map();
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); lines?.close();
        if (child) { child.stdin?.end(); child.kill('SIGTERM'); }
        if (error) reject(error); else resolve(result);
      };
      const fail = (message = '无法基于会话生成总结，请稍后重试') => finish(new Error(message));
      const failService = (error) => {
        const message = typeof error?.message === 'string' ? error.message : '';
        if (/timed?\s*out|timeout/i.test(message)) return fail('会话总结请求超时，未生成草稿，请稍后重试');
        if (/encrypted|continuation context/i.test(message)) return fail('原会话上下文无法被模型服务读取，请先在原会话中确认能正常继续对话');
        if (/stale|expected.?turn|active|in.?progress/i.test(message)) return fail('原会话正在执行或上下文已变化，请等待回合结束后重试');
        if (error?.code === -32601) return fail('当前 Codex 版本不支持会话总结，请更新 Codex 后重试');
        return fail('模型服务未能完成会话总结，请稍后重试');
      };
      const timer = setTimeout(() => fail('生成总结超时，结果未保存'), timeoutMs);
      try {
        child = spawnProcess(command, ['app-server', '--stdio', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'plugins', '--disable', 'apps', '--disable', 'multi_agent', '--disable', 'goals', '-c', 'mcp_servers={}'], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.on('error', () => fail()); child.on('exit', () => { if (!settled) fail(); }); child.stdin.on('error', () => fail()); child.stderr.on('data', () => {});
        const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
        const list = (id) => send({ id, method: 'thread/turns/list', params: { threadId, limit: 1, sortDirection: 'desc' } });
        const complete = () => {
          if (stage !== 'turn' || !turnId || !completedTurns.has(turnId)) return;
          const completed = completedTurns.get(turnId);
          if (completed.status !== 'completed') return failService(completed.error);
          const items = messages.get(turnId) || [];
          const finalItems = items.filter((item) => item.phase === 'final');
          summary = (finalItems.length ? finalItems : items.filter((item) => item.phase !== 'commentary')).map((item) => item.text).join('\n\n');
          if (!summary.trim()) return fail('模型未返回文档正文，请重试');
          if (summary.length > 100000) return fail('生成正文超过长度限制，请在原会话中缩小总结范围');
          stage = 'verify'; list(6);
        };
        lines = readline.createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          if (settled) return;
          size += Buffer.byteLength(line); if (size > 8 * 1024 * 1024) return fail();
          let value; try { value = JSON.parse(line); } catch { return fail(); }
          // 临时副本只允许文本生成；拒绝审批及工具请求，避免等待无法处理的交互。
          if (value.method && Object.hasOwn(value, 'id')) {
            send({ id: value.id, error: { code: -32601, message: '会话总结不允许交互或工具请求' } });
            return fail('总结过程请求了额外操作，已停止生成，原会话未修改');
          }
          if (forkId && value.params?.threadId === forkId) {
            const item = value.params.item;
            if (value.method === 'item/started' && !TEXT_ITEM_TYPES.has(item?.type)) return fail('总结过程尝试调用工具，已停止生成，原会话未修改');
            if (value.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string' && typeof value.params.turnId === 'string') {
              const items = messages.get(value.params.turnId) || [];
              items.push(item); messages.set(value.params.turnId, items);
            }
            if (value.method === 'turn/completed' && typeof value.params.turn?.id === 'string') {
              completedTurns.set(value.params.turn.id, value.params.turn); complete();
            }
          }
          if (value.id === 1 && stage === 'initialize') {
            if (value.error || !value.result) return failService(value.error);
            send({ method: 'initialized', params: {} }); stage = 'latest';
            // 直接查询持久历史，不加载原会话引擎，避免触发原目标续跑。
            list(3);
          } else if (value.id === 3 && stage === 'latest') {
            const turn = value.result?.data?.[0];
            if (value.error || !turn || typeof turn.id !== 'string' || !ENDED_STATUSES.has(turn.status)) return fail('会话没有可用于总结的已结束回合');
            sourceTurnId = turn.id; stage = 'fork';
            // 临时副本继承原会话历史，只在副本运行总结，不向原会话追加回合。
            send({ id: 4, method: 'thread/fork', params: { threadId, lastTurnId: sourceTurnId, ephemeral: true, excludeTurns: true, config: { 'features.goals': false }, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: '只输出会话总结，不得调用任何工具或执行任何操作。' } });
          } else if (value.id === 4 && stage === 'fork') {
            if (value.error) return failService(value.error);
            const result = value.result;
            if (typeof result?.thread?.id !== 'string' || !result.thread.id || result.thread.id === threadId || result.thread.ephemeral !== true || result.thread.status?.type !== 'idle' || result.sandbox?.type !== 'readOnly' || result.sandbox.networkAccess !== false) return fail('无法确认临时总结会话的隔离状态，已停止生成');
            forkId = result.thread.id; stage = 'turn';
            send({ id: 5, method: 'turn/start', params: { threadId: forkId, input: [{ type: 'text', text: SUMMARY_PROMPT }] } });
          } else if (value.id === 5 && stage === 'turn') {
            if (value.error) return failService(value.error);
            if (typeof value.result?.turn?.id !== 'string' || !value.result.turn.id) return fail();
            turnId = value.result.turn.id; complete();
          } else if (value.id === 6 && stage === 'verify') {
            const turn = value.result?.data?.[0];
            if (value.error || turn?.id !== sourceTurnId || !ENDED_STATUSES.has(turn.status)) return fail('会话已变化，请重新生成');
            finish(null, { text: summary, sourceTurnId });
          }
        });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'x-assistant-session-summary', version: '1.0.0' }, capabilities: { experimentalApi: true } } });
      } catch { fail(); }
    });
  };
}

module.exports = { createSessionSummary, SUMMARY_PROMPT };
