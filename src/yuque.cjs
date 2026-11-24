const API_ROOT = 'https://www.yuque.com/api/v2';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function segment(value, name) {
  if (typeof value !== 'string' || !value || value.length > 200 || value === '.' || value === '..' || /[\/\\\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} 必须是有效的单个路径标识`);
  }
  return encodeURIComponent(value);
}

function namespace(value) {
  if (typeof value !== 'string') throw new TypeError('知识库标识无效');
  const parts = value.split('/');
  if (parts.length !== 2) throw new TypeError('知识库标识必须由用户和知识库两部分组成');
  return parts.map((part) => segment(part, '知识库标识')).join('/');
}

class YuqueError extends Error {}

function failure(code, message) {
  const error = new YuqueError(message);
  error.code = code;
  return error;
}

async function readLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) throw failure('YUQUE_INVALID_RESPONSE', '语雀返回的数据无效。');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw failure('YUQUE_RESPONSE_TOO_LARGE', '语雀返回的数据超过大小限制。');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    const result = JSON.parse(bytes.toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.hasOwn(result, 'data')) throw new Error();
    return result.data;
  } catch {
    throw failure('YUQUE_INVALID_RESPONSE', '语雀返回的数据无效。');
  }
}

function createYuqueClient({ tokenProvider, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof tokenProvider !== 'function') throw new TypeError('必须提供安全凭据读取函数');
  if (typeof fetchImpl !== 'function') throw new TypeError('缺少 HTTP 请求实现');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('超时配置无效');

  async function get(path) {
    let token;
    try { token = await tokenProvider(); } catch { throw failure('YUQUE_AUTH_UNAVAILABLE', '无法读取语雀凭据，请重新授权。'); }
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw failure('YUQUE_AUTH_UNAVAILABLE', '语雀凭据不可用，请重新授权。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${API_ROOT}${path}`, {
        method: 'GET', headers: { 'X-Auth-Token': token, Accept: 'application/json' },
        redirect: 'error', signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) throw failure('YUQUE_ACCESS_DENIED', '语雀授权失效或无权访问。');
      if (!response.ok) throw failure('YUQUE_REQUEST_FAILED', '语雀查询失败，请检查网络和目标是否可访问。');
      return await readLimited(response);
    } catch (error) {
      if (error instanceof YuqueError) throw error;
      if (controller.signal.aborted) throw failure('YUQUE_TIMEOUT', '语雀查询超时，请重试。');
      throw failure('YUQUE_REQUEST_FAILED', '语雀查询失败，请检查网络和目标是否可访问。');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getCurrentUser() { return get('/user'); },
    listRepositories(userId) { return get(`/users/${segment(userId, '用户标识')}/repos`); },
    listDocuments(repo) { return get(`/repos/${namespace(repo)}/docs`); },
    getDocument(repo, slug) { return get(`/repos/${namespace(repo)}/docs/${segment(slug, '文档标识')}`); },
  };
}

module.exports = { createYuqueClient };
