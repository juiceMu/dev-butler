const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILES = 10000;
const MAX_BYTES = 128 * 1024 * 1024;
const MANIFEST = '.x-assistant-backup.json';

function createVaultBackup(vault, { restore = false, protectedRoot } = {}) {
  if (typeof vault !== 'string' || !path.isAbsolute(vault)) throw new Error('知识库路径无效');
  const root = fs.realpathSync(vault);
  if (fs.lstatSync(vault).isSymbolicLink() || !fs.statSync(root).isDirectory()) throw new Error('知识库必须是普通目录');
  if (protectedRoot !== undefined && (typeof protectedRoot !== 'string' || !path.isAbsolute(protectedRoot))) throw new Error('当前知识库路径无效');
  const protectedPath = protectedRoot === undefined ? null : fs.realpathSync(protectedRoot);
  if (protectedPath && !fs.statSync(protectedPath).isDirectory()) throw new Error('当前知识库必须是目录');

  function destination(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.basename(value) === '.' || path.basename(value) === '..') throw new Error('备份目标必须是新的绝对路径');
    const parent = fs.realpathSync(path.dirname(value));
    const target = path.join(parent, path.basename(value));
    const relation = path.relative(root, target);
    if (!relation || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation))) throw new Error('备份目标不能位于知识库内');
    if (protectedPath) {
      const protectedRelation = path.relative(protectedPath, target);
      if (!protectedRelation || (!protectedRelation.startsWith(`..${path.sep}`) && protectedRelation !== '..' && !path.isAbsolute(protectedRelation))) throw new Error('恢复目标不能位于当前知识库内');
    }
    if (fs.existsSync(target)) throw new Error('备份目标已存在，不能覆盖');
    return target;
  }

  function digestFile(file, expectedStat) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino) throw new Error('源文件已变化');
      const hash = crypto.createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let size = 0; let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { size += count; if (size > MAX_BYTES) throw new Error('文件超过备份上限'); hash.update(buffer.subarray(0, count)); }
      if (size !== stat.size) throw new Error('源文件读取期间发生变化');
      return { size, hash: hash.digest('hex') };
    } finally { fs.closeSync(fd); }
  }

  function inventory() {
    const files = []; const directories = []; let totalBytes = 0;
    function visit(directory, relative = '', depth = 0) {
      if (depth > 100) throw new Error('知识库目录层级超过备份上限');
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (!relative && name === MANIFEST) {
          if (restore) continue;
          throw new Error('知识库包含备份保留文件名，无法备份');
        }
        const full = path.join(directory, entry.name); const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) throw new Error(`知识库包含符号链接，无法完整备份：${name}`);
        if (stat.isDirectory()) { if (directories.length >= MAX_FILES) throw new Error('知识库目录数量超过备份上限'); directories.push(name); visit(full, name, depth + 1); }
        else if (stat.isFile()) {
          if (files.length >= MAX_FILES) throw new Error('知识库文件数量超过备份上限');
          totalBytes += stat.size; if (totalBytes > MAX_BYTES) throw new Error('知识库大小超过备份上限');
          files.push({ path: name, ...digestFile(full, stat) });
        } else throw new Error(`知识库包含不支持的文件类型：${name}`);
      }
    }
    visit(root);
    return { directories, files, totalBytes };
  }

  function verifyManifest(manifest) {
    let saved;
    try {
      const file = path.join(root, MANIFEST); const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('invalid');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { saved = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
    } catch { throw new Error('备份清单不存在或无效，不能自动恢复'); }
    if (saved.version !== 1 || JSON.stringify(saved.manifest) !== JSON.stringify(manifest)) throw new Error('备份内容与清单不一致，不能自动恢复');
  }

  function preview(target) {
    const output = destination(target); const manifest = inventory();
    if (restore) verifyManifest(manifest);
    const token = crypto.createHash('sha256').update(JSON.stringify({ root, output, ...manifest })).digest('hex');
    return { target: output, ...manifest, token };
  }

  function backup({ target, token, confirmed }) {
    if (confirmed !== true) throw new Error('备份前必须明确确认');
    const current = preview(target);
    if (typeof token !== 'string' || token !== current.token) throw new Error('知识库或备份目标已变化，请重新预览');
    fs.mkdirSync(current.target, { mode: 0o700 });
    try {
      for (const directory of current.directories) fs.mkdirSync(path.join(current.target, directory), { mode: 0o700 });
      for (const item of current.files) {
        let source = root;
        for (const part of item.path.split('/')) {
          source = path.join(source, part);
          if (fs.lstatSync(source).isSymbolicLink()) throw new Error('源路径已变化');
        }
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink()) throw new Error('源文件已变化');
        const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const actual = fs.fstatSync(input);
          if (!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino) throw new Error('源文件已变化');
          const output = fs.openSync(path.join(current.target, item.path), 'wx', 0o600);
          try {
            const hash = crypto.createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let size = 0; let count;
            while ((count = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
              size += count; if (size > item.size) throw new Error('源文件已变化');
              hash.update(buffer.subarray(0, count));
              let written = 0; while (written < count) written += fs.writeSync(output, buffer, written, count - written);
            }
            if (size !== item.size || hash.digest('hex') !== item.hash) throw new Error('源文件已变化');
            fs.fsyncSync(output);
          } finally { fs.closeSync(output); }
        } finally { fs.closeSync(input); }
      }
      const after = inventory();
      if (JSON.stringify(after) !== JSON.stringify({ directories: current.directories, files: current.files, totalBytes: current.totalBytes })) throw new Error('备份期间知识库发生变化');
      if (!restore) {
        const manifest = { version: 1, manifest: after };
        const fd = fs.openSync(path.join(current.target, MANIFEST), 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(manifest)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } else {
        // 恢复前再次核对清单，避免复制期间备份被更改。
        verifyManifest(after);
      }
      return { target: current.target, files: current.files.length, totalBytes: current.totalBytes };
    } catch (error) {
      throw new Error(`备份未完成，部分文件保留在 ${current.target}，请检查后手动处理：${error.message}`);
    }
  }
  return { preview, backup };
}
module.exports = { createVaultBackup };
