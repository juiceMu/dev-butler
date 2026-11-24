const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSensitive } = require('../src/sensitive-check.cjs');

test('检测常见疑似凭据类型，不回传匹配内容', () => {
  assert.deepEqual(detectSensitive('普通笔记'), []);
  assert.deepEqual(detectSensitive('-----BEGIN PRIVATE KEY-----'), ['私钥']);
  assert.deepEqual(detectSensitive('Authorization: Bearer abcdefghijklmnop'), ['Bearer 凭据']);
  assert.deepEqual(detectSensitive('api_key=' + 'x'.repeat(12)), ['密码或访问密钥']);
});
