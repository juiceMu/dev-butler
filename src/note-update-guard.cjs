// 隔离原型：确认摘要不是授权，标记文件与索引不是单一原子事务。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectSensitive } = require('./sensitive-check.cjs');

const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const NOT_WRITTEN_STATUSES = new Set(['busy', 'unavailable', 'invalid', 'target_mismatch', 'conflict', 'limit_reached']);

function createNoteUpdateGuard({ store, directory, processNote, currentVaultId, readNote, inspectNote }) {
  if (!store || typeof store.transaction !== 'function' || !path.isAbsolute(directory) || typeof processNote !== 'function' || typeof currentVaultId !== 'function' || typeof readNote !== 'function' || !fs.lstatSync(directory).isDirectory()) throw new Error('原型配置无效');

  function binding(input) {
    const { requestId, vaultId, draftId, revision, target, before, after, mode, draftContent } = input;
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) ||
        typeof vaultId !== 'string' || !/^[a-f0-9]{64}$/.test(vaultId) ||
        typeof draftId !== 'string' || !draftId || draftId.length > 200 ||
        !Number.isSafeInteger(revision) || revision < 1 || typeof target !== 'string' ||
        !target.toLowerCase().endsWith('.md') || target.startsWith('/') || target.includes('\\') || target.includes('\0') || target.split('/').some((part) => !part || part === '.' || part === '..') ||
        typeof before !== 'string' || typeof after !== 'string' || !after.trim() || before.length > 100000 || after.length > 100000) throw new Error('请求无效');
    if (mode === 'append') {
      if (typeof draftContent !== 'string' || !draftContent.trim() || draftContent.length > 100000 || !after.startsWith(before) || after.length <= before.length) throw new Error('追加内容与原文或草稿不匹配');
    } else if ((mode !== undefined && mode !== 'replace') || draftContent !== undefined) throw new Error('更新方式无效');
    return { requestId, vaultId, draftId, revision, target, beforeDigest: hash(before), afterDigest: hash(after), ...(mode === 'append' ? { mode, draftDigest: hash(draftContent) } : {}) };
  }

  function preview(input) {
    const value = binding(input);
    return { ...value, confirmation: hash(JSON.stringify(value)) };
  }

  function readOwnedLock(file, lock) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw new Error('外部锁文件无法核实'); }
    if (owner.requestId !== lock.requestId || owner.ownerPid !== lock.ownerPid || owner.vaultId !== lock.vaultId || owner.target !== lock.target || (lock.lockId && owner.lockId !== lock.lockId)) throw new Error('外部锁归属不匹配');
    return true;
  }

  function cleanupOwnedLocks({ marker, targetLock, lock }) {
    for (const file of [marker, targetLock]) {
      if (!readOwnedLock(file, lock)) continue;
      fs.unlinkSync(file);
    }
    const parent = fs.openSync(directory, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }

  function cleanupPending(lockId) {
    return store.cleanupDraftUpdate(lockId, (lock) => {
      if (currentVaultId() !== lock.vaultId) throw new Error('当前知识库与清理目标不一致');
      const key = hash(JSON.stringify([lock.draftId, lock.revision, lock.target]));
      const files = [path.join(directory, `${key}.json`), path.join(directory, `target-${hash(JSON.stringify([lock.vaultId, lock.target]))}.lock`)];
      for (const file of files) {
        let owner;
        try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw new Error('外部锁文件无法核实'); }
        // 其他身份表示旧锁已被移除，不能清理新请求的锁。
        if (!owner || typeof owner.lockId !== 'string' || !/^[a-f0-9]{32}$/.test(owner.lockId)) throw new Error('外部锁身份无法核实');
        if (owner.lockId !== lock.lockId) continue;
        if (!readOwnedLock(file, lock)) continue;
        fs.unlinkSync(file);
      }
      const parent = fs.openSync(directory, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    });
  }

  function createOwnedLock(file, owner, createdLocks) {
    const temporary = path.join(directory, `.lock-${crypto.randomBytes(16).toString('hex')}.tmp`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      fs.linkSync(temporary, file);
      createdLocks.push({ file, stat });
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } finally {
          try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    }
  }

  async function submit(input) {
    const snapshot = { ...input };
    if (snapshot.confirmed !== true) throw new Error('必须明确确认');
    const value = binding(snapshot);
    if (snapshot.confirmation !== hash(JSON.stringify(value))) throw new Error('确认与内容不一致');
    if (currentVaultId() !== value.vaultId) throw new Error('当前知识库与请求不一致');
    const key = hash(JSON.stringify([value.draftId, value.revision, value.target]));
    const marker = path.join(directory, `${key}.json`);
    const targetLock = path.join(directory, `target-${hash(JSON.stringify([value.vaultId, value.target]))}.lock`);
    for (const pending of store.list().updateCleanups.filter((item) => item.vaultId === value.vaultId && item.target === value.target)) {
      try { cleanupPending(pending.lockId); } catch { return { status: 'unknown', message: '上次更新的外部锁清理失败，请稍后重试' }; }
    }
    if (fs.existsSync(marker) || fs.existsSync(targetLock)) return { status: 'unknown', message: '草稿或目标已有提交记录，请核查后再操作' };
    if (detectSensitive(snapshot.after).length) throw new Error('草稿包含疑似敏感信息');
    const lockId = crypto.randomBytes(16).toString('hex');
    try {
      store.beginDraftUpdate({
        id: value.draftId,
        revision: value.revision,
        target: value.target,
        content: snapshot.draftContent ?? snapshot.after,
        updateLock: { requestId: value.requestId, ownerPid: process.pid, vaultId: value.vaultId, target: value.target, beforeDigest: value.beforeDigest, afterDigest: value.afterDigest, status: 'preparing', lockId, ...(value.draftDigest ? { draftDigest: value.draftDigest } : {}) },
      });
    } catch (error) {
      if (/已有未完成更新/.test(error.message)) return { status: 'unknown', message: '草稿或目标已有未完成更新，请核查' };
      throw error;
    }
    const createdLocks = [];
    try {
      const owner = { requestId: value.requestId, ownerPid: process.pid, vaultId: value.vaultId, target: value.target, lockId };
      createOwnedLock(targetLock, owner, createdLocks);
      createOwnedLock(marker, { ...owner, status: 'submitting' }, createdLocks);
      const parent = fs.openSync(directory, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } catch (error) {
      try {
        for (const { file, stat } of createdLocks.reverse()) {
          const current = fs.lstatSync(file);
          if (!stat || !current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('准备阶段锁文件已变化');
          fs.unlinkSync(file);
        }
        const parent = fs.openSync(directory, 'r');
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
        store.finishDraftUpdate({ id: value.draftId, revision: value.revision, requestId: value.requestId, outcome: 'not_written' });
        return { status: 'not_written', message: '提交准备失败，未调用桥接' };
      } catch { /* 仅记录本地未发送，待清理记录独立于草稿保留。 */ }
      try {
        store.finishDraftUpdate({ id: value.draftId, revision: value.revision, requestId: value.requestId, outcome: 'not_written', trackCleanup: true });
        return { status: 'not_written', cleanupPending: true, message: '未调用桥接，准备阶段的外部锁待清理' };
      } catch {
        return { status: 'unknown', message: '提交准备失败且索引状态无法确认，请核查' };
      }
    }
    let matched = false;
    let failed = false;
    let bridgeResult;
    try { store.dispatchDraftUpdate({ id: value.draftId, revision: value.revision, requestId: value.requestId }); }
    catch {
      try {
        store.finishDraftUpdate({ id: value.draftId, revision: value.revision, requestId: value.requestId, outcome: 'not_written', trackCleanup: true });
        try { cleanupPending(lockId); return { status: 'not_written', message: '提交阶段失败，未调用桥接' }; }
        catch { return { status: 'not_written', cleanupPending: true, message: '未调用桥接，外部锁待清理' }; }
      } catch { return { status: 'unknown', message: '提交阶段失败，桥接未调用但索引状态无法确认' }; }
    }
    try {
      bridgeResult = await processNote(value.vaultId, value.target, (current) => {
        if (matched || typeof current !== 'string' || hash(current) !== value.beforeDigest) {
          failed = true;
          throw new Error('原文变化或回调重复');
        }
        matched = true;
        return snapshot.after;
      }, { requestId: value.requestId, beforeDigest: value.beforeDigest, afterDigest: value.afterDigest, content: snapshot.after });
    } catch { /* 不能根据异常判断是否已写入。 */ }
    const bridgeStatus = bridgeResult && typeof bridgeResult === 'object' ? bridgeResult.status : undefined;
    let outcome = bridgeStatus === 'completed' ? 'completed' : NOT_WRITTEN_STATUSES.has(bridgeStatus) ? 'not_written' : 'unknown';
    const completionUnverified = bridgeStatus === 'completed' && (!matched || failed);
    if (completionUnverified) outcome = 'unknown';
    if (outcome === 'completed' || outcome === 'not_written') {
      try {
        store.finishDraftUpdate({ id: value.draftId, revision: value.revision, requestId: value.requestId, outcome, trackCleanup: true });
      } catch { return { status: 'unknown', message: '结果无法持久确认，草稿及外部锁保持占用' }; }
      try { cleanupPending(lockId); }
      catch { return { status: outcome, bridgeStatus, cleanupPending: true, message: '索引状态已持久化，外部锁清理失败；目标仍被锁定' }; }
      return outcome === 'not_written' ? { status: 'not_written', bridgeStatus } : { status: 'completed' };
    }
    try { store.finishDraftUpdate({ id: value.draftId, revision: value.revision, requestId: value.requestId, outcome: 'unknown' }); }
    catch { return { status: 'unknown', message: '写入结果无法持久确认，草稿仍保持锁定' }; }
    return { status: 'unknown', message: completionUnverified ? '桥接报告完成，但未能核实唯一目标写入' : '桥接结果不确定，草稿及外部锁保持占用' };
  }

  async function recover({ draftId, revision, requestId, confirmed }) {
    if (confirmed !== true) throw new Error('恢复更新前必须明确确认');
    const item = store.list().drafts.find((entry) => entry.id === draftId);
    const lock = item?.updateLock;
    if (!lock || item.revision !== revision || lock.requestId !== requestId) throw new Error('没有匹配的待核对更新');
    if (currentVaultId() !== lock.vaultId) throw new Error('当前知识库与提交目标不一致');
    if (lock.status === 'preparing') {
      const recovered = store.recoverPreparedDraftUpdate({ id: draftId, revision, requestId });
      try { cleanupPending(lock.lockId); } catch { return { ...recovered, cleanupPending: true }; }
      return recovered;
    }
    if (typeof inspectNote !== 'function') throw new Error('无法核实远端更新是否结束，草稿仍保持锁定');
    const remote = await inspectNote(lock.vaultId, lock.target, { requestId: lock.requestId, beforeDigest: lock.beforeDigest, afterDigest: lock.afterDigest });
    if (remote?.drained !== true || !['completed', 'target_mismatch', 'resolved_unknown'].includes(remote.status)) throw new Error('远端更新尚未可靠结束，草稿仍保持锁定');
    let note;
    try { note = await readNote(lock.target); } catch { throw new Error('无法读取目标笔记，草稿仍保持锁定'); }
    if (currentVaultId() !== lock.vaultId) throw new Error('核对期间知识库已变化');
    if (!note || typeof note.content !== 'string') throw new Error('无法读取目标笔记，草稿仍保持锁定');
    const key = hash(JSON.stringify([draftId, revision, lock.target]));
    const marker = path.join(directory, `${key}.json`);
    const targetLock = path.join(directory, `target-${hash(JSON.stringify([lock.vaultId, lock.target]))}.lock`);
    const ownedLock = { requestId: lock.requestId, ownerPid: lock.ownerPid, vaultId: lock.vaultId, target: lock.target, lockId: lock.lockId };
    try {
      readOwnedLock(targetLock, ownedLock);
      readOwnedLock(marker, ownedLock);
    } catch (error) { throw new Error(`${error.message}，草稿仍保持锁定`); }
    const cleanupId = lock.lockId || crypto.randomBytes(16).toString('hex');
    const recovered = store.recoverDraftUpdate({
      id: draftId,
      revision,
      requestId,
      verifiedAfterDigest: hash(note.content),
      confirmed,
      trackCleanup: true,
      legacyCleanupId: cleanupId,
    });
    try {
      if (!lock.lockId) cleanupOwnedLocks({ marker, targetLock, lock: ownedLock });
      cleanupPending(cleanupId);
    }
    catch { return { ...recovered, cleanupPending: true }; }
    return recovered;
  }

  return { preview, submit, recover, cleanupPending };
}

module.exports = { createNoteUpdateGuard };
