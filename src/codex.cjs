const path = require('node:path');

function boundedString(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`${name} 必须是非空字符串，且长度不超过 ${max}`);
  }
  return value.trim();
}

function metadata(thread) {
  if (!thread || typeof thread.id !== 'string' || !thread.id) throw new Error('Codex 返回的会话元数据无效');
  return {
    id: thread.id,
    title: typeof thread.name === 'string' ? thread.name : null,
    cwd: typeof thread.cwd === 'string' ? thread.cwd : null,
    createdAt: Number.isFinite(thread.createdAt) ? thread.createdAt : null,
    updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : null,
    status: typeof thread.status?.type === 'string' ? thread.status.type : null,
  };
}

function createCodexClient({ request } = {}) {
  async function send(method, params, options) {
    if (typeof request !== 'function') {
      const error = new Error('Codex 会话连接尚未配置或验证');
      error.code = 'CODEX_UNAVAILABLE';
      throw error;
    }
    return request(method, params, options);
  }

  return {
    capabilities() {
      return { metadataRead: typeof request === 'function', list: typeof request === 'function', create: false, open: false, history: false };
    },
    async list({ searchTerm, cwd, cursor, limit = 20 } = {}) {
      const params = { useStateDbOnly: true, limit };
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit 必须是 1 到 50 之间的整数');
      if (searchTerm !== undefined) params.searchTerm = boundedString(searchTerm, '关键词', 200);
      if (cwd !== undefined) {
        params.cwd = boundedString(cwd, '工程路径', 4096);
        if (!path.isAbsolute(params.cwd)) throw new TypeError('工程路径必须为绝对路径');
      }
      if (!params.searchTerm && !params.cwd) throw new TypeError('请指定关键词或工程路径');
      if (cursor !== undefined) params.cursor = boundedString(cursor, '分页游标', 4096);
      const result = await send('thread/list', params);
      if (!result || !Array.isArray(result.data)) throw new Error('Codex 返回的会话列表无效');
      return { data: result.data.map(metadata), nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : null };
    },
    async read(threadId) {
      const id = boundedString(threadId, '会话 ID', 200);
      const result = await send('thread/read', { threadId: id, includeTurns: false });
      const thread = metadata(result?.thread);
      if (thread.id !== id) throw new Error('Codex 返回的会话标识不匹配');
      return thread;
    },
    async history({ threadId, cursor, limit = 5 }) {
      const id = boundedString(threadId, '会话 ID', 200);
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new TypeError('limit 必须是 1 到 5 之间的整数');
      const params = { threadId: id, limit, itemsView: 'full', sortDirection: 'desc' };
      if (cursor !== undefined) params.cursor = boundedString(cursor, '分页游标', 4096);
      const result = await send('thread/turns/list', params);
      if (!result || !Array.isArray(result.data) || result.data.length > limit || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new Error('Codex 返回的会话历史无效');
      let remaining = 100000;
      const turns = result.data.map((turn) => {
        if (!turn || typeof turn.id !== 'string' || !Array.isArray(turn.items) || turn.itemsView !== 'full') throw new Error('Codex 返回的会话历史不完整');
        const messages = []; let omittedItems = 0; let omittedContentParts = 0;
        for (const item of turn.items) {
          let value;
          if (item?.type === 'agentMessage') {
            if (typeof item.text !== 'string') throw new Error('Codex 返回的会话消息无效');
            value = item.text;
          } else if (item?.type === 'userMessage') {
            if (!Array.isArray(item.content)) throw new Error('Codex 返回的会话消息无效');
            const parts = [];
            for (const part of item.content) {
              if (part?.type === 'text') {
                if (typeof part.text !== 'string') throw new Error('Codex 返回的会话消息无效');
                parts.push(part.text);
              } else omittedContentParts++;
            }
            value = parts.join('\n');
          } else { omittedItems++; continue; }
          if (!value) continue;
          const length = Math.min(value.length, 20000, remaining);
          messages.push({ role: item.type === 'userMessage' ? 'user' : 'assistant', text: value.slice(0, length), truncated: length < value.length });
          remaining -= length;
        }
        return {
          id: turn.id, status: turn.status,
          startedAt: Number.isFinite(turn.startedAt) ? turn.startedAt : null,
          completedAt: Number.isFinite(turn.completedAt) ? turn.completedAt : null,
          messages, omittedItems, omittedContentParts,
        };
      });
      return { turns, nextCursor: result.nextCursor, truncated: remaining === 0 || turns.some((turn) => turn.messages.some((message) => message.truncated)) };
    },
    async projects({ cursor, limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit 必须是 1 到 50 之间的整数');
      const params = { limit };
      if (cursor !== undefined) params.cursor = boundedString(cursor, '分页游标', 4096);
      const result = await send('project/list', params);
      if (!result || !Array.isArray(result.data)) throw new Error('Codex 返回的项目列表无效');
      const data = result.data.map((project) => {
        if (!project || typeof project.id !== 'string' || !project.id || typeof project.name !== 'string' || !Array.isArray(project.roots)) throw new Error('Codex 返回的项目元数据无效');
        const roots = project.roots.map((root) => {
          if (!root || typeof root.path !== 'string' || !path.isAbsolute(root.path)) throw new Error('Codex 返回的项目路径无效');
          return root.path;
        });
        return { id: project.id, name: project.name, roots };
      });
      return { data, nextCursor: typeof result.nextCursor === 'string' ? result.nextCursor : null };
    },
    async create({ projectId, cwd, title }) {
      const project = boundedString(projectId, '项目 ID', 200);
      const directory = boundedString(cwd, '工程路径', 4096);
      if (!path.isAbsolute(directory)) throw new TypeError('工程路径必须为绝对路径');
      const name = typeof title === 'string' ? Array.from(title.replace(/\s+/g, ' ').trim()).slice(0, 120).join('') : '';
      const result = await send('thread/start', { projectId: project, cwd: directory, ephemeral: false }, { title: name });
      try {
        const thread = metadata(result?.thread);
        if (result.thread.projectId !== project || thread.cwd !== directory) throw new Error('创建返回的项目或路径不匹配');
        return thread;
      } catch {
        const error = new Error('创建结果不确定，请先检查会话列表，勿重复创建');
        error.code = 'CODEX_CREATE_UNCERTAIN';
        if (typeof result?.thread?.id === 'string' && result.thread.id.length > 0 && result.thread.id.length <= 200) error.recoverySessionId = result.thread.id;
        throw error;
      }
    },
  };
}

module.exports = { createCodexClient };
