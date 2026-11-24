const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);

function createKeychainTokenProvider({ run = execute } = {}) {
  return async () => {
    try {
      const { stdout } = await run('/usr/bin/security', [
        'find-generic-password', '-s', 'codex-choerodon-yuque', '-a', 'yuque', '-w',
      ], { encoding: 'utf8', timeout: 15000, maxBuffer: 8192 });
      return stdout.replace(/\r?\n$/, '');
    } catch {
      throw new Error('无法读取语雀钥匙串凭据');
    }
  };
}

module.exports = { createKeychainTokenProvider };
