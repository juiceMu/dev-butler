const test = require('node:test');
const assert = require('node:assert/strict');
const { createYuqueClient } = require('../src/yuque.cjs');
const { createKeychainTokenProvider } = require('../src/yuque-auth.cjs');

test('仅以 GET 请求官方地址并转义用户指定的标识', async () => {
  const calls = [];
  const client = createYuqueClient({ tokenProvider: async () => 'private-token', fetchImpl: async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ data: [{ title: '文档' }] }));
  } });
  assert.deepEqual(await client.listRepositories('user'), [{ title: '文档' }]);
  await client.listDocuments('user/book');
  await client.getDocument('user/book', '文档 1');
  await client.getCurrentUser();
  assert.deepEqual(calls.map(([url]) => url), [
    'https://www.yuque.com/api/v2/users/user/repos',
    'https://www.yuque.com/api/v2/repos/user/book/docs',
    'https://www.yuque.com/api/v2/repos/user/book/docs/%E6%96%87%E6%A1%A3%201',
    'https://www.yuque.com/api/v2/user',
  ]);
  for (const [, options] of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Auth-Token'], 'private-token');
  }
  assert.equal(client.search, undefined);
  assert.equal(client.updateDocument, undefined);
});

test('钥匙串读取使用固定参数且不泄露异常', async () => {
  const provider = createKeychainTokenProvider({ run: async (command, args) => {
    assert.equal(command, '/usr/bin/security');
    assert.deepEqual(args, ['find-generic-password', '-s', 'codex-choerodon-yuque', '-a', 'yuque', '-w']);
    return { stdout: 'private-token\n' };
  } });
  assert.equal(await provider(), 'private-token');
  const failed = createKeychainTokenProvider({ run: async () => { throw new Error('private-token'); } });
  await assert.rejects(failed(), (error) => !error.message.includes('private-token'));
});

test('拒绝无效路径及缺失凭据，不发送请求', async () => {
  let calls = 0;
  const client = createYuqueClient({ tokenProvider: async () => '', fetchImpl: async () => { calls++; } });
  assert.throws(() => client.getDocument('../book', 'doc'), /路径标识/);
  assert.throws(() => client.getDocument('a/b/c', 'doc'), /两部分/);
  assert.throws(() => client.getDocument('a/b', '../doc'), /路径标识/);
  await assert.rejects(client.listRepositories('user'), (error) => error.code === 'YUQUE_AUTH_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('错误不泄露凭据、远端内容或内部异常', async () => {
  for (const [fetchImpl, code] of [
    [async () => new Response('private-token', { status: 403 }), 'YUQUE_ACCESS_DENIED'],
    [async () => new Response('private-token'), 'YUQUE_INVALID_RESPONSE'],
    [async () => { throw new Error('private-token'); }, 'YUQUE_REQUEST_FAILED'],
    [async () => { throw Object.assign(new Error('private-token'), { code: 'YUQUE_FAKE' }); }, 'YUQUE_REQUEST_FAILED'],
  ]) {
    const client = createYuqueClient({ tokenProvider: async () => 'private-token', fetchImpl });
    await assert.rejects(client.listDocuments('a/b'), (error) => error.code === code && !error.message.includes('private-token'));
  }
});

test('响应超过限制及超时均失败', async () => {
  const oversized = createYuqueClient({ tokenProvider: async () => 'token', fetchImpl: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)) });
  await assert.rejects(oversized.listDocuments('a/b'), (error) => error.code === 'YUQUE_RESPONSE_TOO_LARGE');
  const timeout = createYuqueClient({ tokenProvider: async () => 'token', timeoutMs: 1, fetchImpl: async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) });
  await assert.rejects(timeout.listDocuments('a/b'), (error) => error.code === 'YUQUE_TIMEOUT');
});
