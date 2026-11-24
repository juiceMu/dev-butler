const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVaultBackup } = require('../src/vault-backup.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-backup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault'); fs.mkdirSync(vault);
  fs.mkdirSync(path.join(vault, 'assets')); fs.mkdirSync(path.join(vault, 'empty'));
  fs.writeFileSync(path.join(vault, 'note.md'), '![图](assets/a.png)');
  fs.writeFileSync(path.join(vault, 'assets', 'a.png'), Buffer.from([0, 1, 2, 255]));
  return { root, vault, backup: createVaultBackup(vault), target: path.join(root, 'backup') };
}

test('预览后备份笔记、二进制附件和空目录，不覆盖源文件或目标', (t) => {
  const { vault, backup, target } = fixture(t);
  const preview = backup.preview(target);
  assert.equal(preview.files.length, 2);
  assert.equal(fs.existsSync(target), false);
  assert.throws(() => backup.backup({ target, token: preview.token }), /确认/);
  const result = backup.backup({ target, token: preview.token, confirmed: true });
  assert.equal(result.files, 2);
  assert.deepEqual(fs.readFileSync(path.join(target, 'assets', 'a.png')), fs.readFileSync(path.join(vault, 'assets', 'a.png')));
  assert.equal(fs.readFileSync(path.join(target, 'note.md'), 'utf8'), fs.readFileSync(path.join(vault, 'note.md'), 'utf8'));
  assert.equal(fs.statSync(path.join(target, 'empty')).isDirectory(), true);
  assert.throws(() => backup.preview(target), /已存在/);
});

test('内容发生变化、目标位于知识库内或包含符号链接时拒绝备份', (t) => {
  const { vault, backup, target } = fixture(t);
  const preview = backup.preview(target);
  fs.writeFileSync(path.join(vault, 'note.md'), '已修改');
  assert.throws(() => backup.backup({ target, token: preview.token, confirmed: true }), /重新预览/);
  assert.equal(fs.existsSync(target), false);
  assert.throws(() => backup.preview(path.join(vault, 'backup')), /知识库内/);
  fs.symlinkSync(path.join(vault, 'note.md'), path.join(vault, 'link'));
  assert.throws(() => backup.preview(target), /符号链接/);
});

test('仅恢复清单完整且未修改的备份到新目录', (t) => {
  const { root, vault, backup, target } = fixture(t);
  const original = backup.preview(target);
  backup.backup({ target, token: original.token, confirmed: true });
  const restore = createVaultBackup(target, { restore: true });
  const restoreTarget = path.join(root, 'restored');
  const preview = restore.preview(restoreTarget);
  assert.throws(() => restore.backup({ target: restoreTarget, token: preview.token }), /确认/);
  restore.backup({ target: restoreTarget, token: preview.token, confirmed: true });
  assert.deepEqual(fs.readFileSync(path.join(restoreTarget, 'assets', 'a.png')), fs.readFileSync(path.join(vault, 'assets', 'a.png')));
  assert.equal(fs.existsSync(path.join(restoreTarget, '.x-assistant-backup.json')), false);
  assert.throws(() => restore.preview(vault), /已存在/);
  fs.writeFileSync(path.join(target, 'note.md'), '更改');
  assert.throws(() => restore.preview(path.join(root, 'other')), /不一致/);
});

test('无清单、清单损坏及保留名称都不会被当作有效备份', (t) => {
  const { root, vault, backup, target } = fixture(t);
  const restore = createVaultBackup(vault, { restore: true });
  assert.throws(() => restore.preview(target), /清单不存在或无效/);
  fs.writeFileSync(path.join(vault, '.x-assistant-backup.json'), '{');
  assert.throws(() => restore.preview(target), /清单不存在或无效/);
  assert.throws(() => backup.preview(path.join(root, 'backup2')), /保留文件名/);
});

test('恢复拒绝当前知识库内的目标，包括经符号链接访问的路径', (t) => {
  const { root, vault, backup, target } = fixture(t);
  const preview = backup.preview(target);
  backup.backup({ target, token: preview.token, confirmed: true });
  const restore = createVaultBackup(target, { restore: true, protectedRoot: vault });
  const alias = path.join(root, 'vault-alias'); fs.symlinkSync(vault, alias);
  assert.throws(() => restore.preview(path.join(vault, 'restored')), /当前知识库内/);
  assert.throws(() => restore.preview(path.join(alias, 'restored')), /当前知识库内/);
  assert.equal(fs.existsSync(path.join(vault, 'restored')), false);
  assert.doesNotThrow(() => restore.preview(path.join(root, 'restored')));
});
