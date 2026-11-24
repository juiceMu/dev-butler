const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const PLUGIN_ID = 'x-assistant-bridge';
const MAX_CONTENT = 100000;
const MAX_REQUEST_BYTES = MAX_CONTENT * 6 + 8192;
const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function createObsidianBridgeClient({ vaultRoot, vaultId, configDir = '.obsidian', pluginId = PLUGIN_ID, timeoutMs = 10000 }) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot) ||
      typeof vaultId !== 'string' || !/^[a-f0-9]{64}$/.test(vaultId) ||
      typeof configDir !== 'string' || !configDir || path.posix.isAbsolute(configDir) || configDir.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof pluginId !== 'string' || !/^[a-z0-9-]{1,100}$/.test(pluginId) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Obsidian 桥接客户端配置无效');
  const root = path.resolve(vaultRoot);
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('invalid');
  } catch { throw new Error('知识库目录无效'); }
  const expectedVaultId = hash(root);
  if (vaultId !== expectedVaultId) throw new Error('知识库标识与配置目录不匹配');
  const metadataPath = path.join(root, ...configDir.split('/'), 'plugins', pluginId, 'bridge.json');

  function readEndpoint() {
    try {
      let current = root;
      for (const part of path.relative(root, metadataPath).split(path.sep)) {
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) return null;
      }
      const fd = fs.openSync(metadataPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 4096) return null;
        const endpoint = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (endpoint.protocol !== 1 || endpoint.host !== '127.0.0.1' || endpoint.vaultId !== expectedVaultId ||
            endpoint.pluginId !== pluginId || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
            typeof endpoint.token !== 'string' || !/^[a-f0-9]{64}$/.test(endpoint.token)) return null;
        return endpoint;
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  }

  async function update({ attemptId, notePath, expectedDigest, content, confirmed }) {
    if (confirmed !== true) throw new Error('更新前必须明确确认');
    if (typeof attemptId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(attemptId) ||
        typeof notePath !== 'string' || notePath.length > 4096 || !notePath.toLowerCase().endsWith('.md') ||
        notePath.startsWith('/') || notePath.includes('\\') || notePath.includes('\0') || notePath.split('/').some((part) => !part || part === '.' || part === '..') ||
        typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest) ||
        typeof content !== 'string' || !content.trim() || content.length > MAX_CONTENT || Buffer.byteLength(content, 'utf8') > MAX_CONTENT * 4) {
      throw new Error('Obsidian 更新请求无效');
    }
    const endpoint = readEndpoint();
    if (!endpoint) return { status: 'unavailable' };
    const body = JSON.stringify({ attemptId, vaultId: expectedVaultId, notePath, expectedDigest, content, confirmed: true });
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) return { status: 'invalid' };
    return exchange(endpoint, body, attemptId, false);
  }

  async function inspect({ attemptId, notePath, expectedDigest, contentDigest }) {
    if (typeof attemptId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(attemptId) ||
        typeof notePath !== 'string' || notePath.length > 4096 || !notePath.toLowerCase().endsWith('.md') ||
        notePath.startsWith('/') || notePath.includes('\\') || notePath.includes('\0') || notePath.split('/').some((part) => !part || part === '.' || part === '..') ||
        typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest) ||
        typeof contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contentDigest)) throw new Error('Obsidian 核验请求无效');
    const endpoint = readEndpoint();
    if (!endpoint) return { status: 'unavailable', drained: false };
    const body = JSON.stringify({ attemptId, vaultId: expectedVaultId, notePath, expectedDigest, contentDigest });
    return exchange(endpoint, body, attemptId, true);
  }

  function exchange(endpoint, body, attemptId, inspecting) {
    return new Promise((resolve) => {
      let connected = false;
      let resolved = false;
      let responseText = '';
      const settle = (status, drained = false) => {
        if (resolved) return;
        resolved = true;
        resolve(inspecting ? { status, drained: drained === true } : { status });
      };
      const request = http.request({
        host: '127.0.0.1', port: endpoint.port, method: 'POST', path: inspecting ? '/v1/inspect-attempt' : '/v1/update-note',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (response) => {
        response.on('data', (chunk) => {
          responseText += chunk.toString('utf8');
          if (responseText.length > 4096) request.destroy();
        });
        response.on('end', () => {
          if ([408, 413, 429, 503].includes(response.statusCode)) {
            try {
              const payload = JSON.parse(responseText);
              if (payload.status === 'busy') return settle('busy');
            } catch {}
            return settle(response.statusCode === 429 ? 'busy' : 'unavailable');
          }
          if ([400, 403, 404, 409, 507].includes(response.statusCode)) {
            try {
              const payload = JSON.parse(responseText);
              if (payload.attemptId && payload.attemptId !== attemptId) return settle('unknown');
              if (['invalid', 'conflict', 'limit_reached', 'busy', 'unavailable'].includes(payload.status)) return settle(payload.status);
            } catch {}
            return settle(response.statusCode === 507 ? 'limit_reached' : 'invalid');
          }
          try {
            const result = JSON.parse(responseText);
            if (result.attemptId !== attemptId || !['completed', 'target_mismatch', 'unknown', 'not_found', 'conflict', 'limit_reached', 'unavailable', 'invalid', 'busy', 'resolved_unknown'].includes(result.status)) throw new Error('响应无效');
            const terminal = ['completed', 'target_mismatch', 'resolved_unknown'].includes(result.status);
            settle(result.status, terminal && result.drained === true);
          } catch { settle('unknown'); }
        });
      });
      request.on('socket', (socket) => {
        if (socket.connecting) socket.once('connect', () => { connected = true; });
        else connected = true;
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
      request.on('error', () => settle(connected ? 'unknown' : 'unavailable'));
      request.end(body);
    });
  }

  return { update, inspect };
}

module.exports = { PLUGIN_ID, createObsidianBridgeClient };
