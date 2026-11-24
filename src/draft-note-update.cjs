const crypto = require('node:crypto');
const { createNoteUpdateGuard } = require('./note-update-guard.cjs');
const { issueKey } = require('./core.cjs');
const { createHistoryCandidate } = require('./history-candidate.cjs');

const MAX_CONTENT = 100000;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const MAX_PREVIEWS = 100;
const hash = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function diff(beforeText, afterText) {
  const before = beforeText.split('\n');
  const after = afterText.split('\n');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return {
    unchanged: beforeText === afterText,
    startLine: prefix + 1,
    removed: before.slice(prefix, before.length - suffix).join('\n'),
    added: after.slice(prefix, after.length - suffix).join('\n'),
  };
}

function createDraftNoteUpdater({ store, directory, knowledgeStore, currentVaultId, processNote, inspectNote }) {
  if (!store || typeof knowledgeStore !== 'function' || typeof currentVaultId !== 'function' || typeof processNote !== 'function') throw new Error('草稿更新服务配置无效');
  const guard = createNoteUpdateGuard({ store, directory, currentVaultId, processNote, inspectNote, readNote: async (target) => knowledgeStore().read(target) });
  const previews = new Map();

  function prunePreviews() {
    const cutoff = Date.now() - PREVIEW_TTL_MS;
    for (const [key, value] of previews) if (value.createdAt < cutoff) previews.delete(key);
    while (previews.size >= MAX_PREVIEWS) previews.delete(previews.keys().next().value);
  }

  function findDraft({ id, revision, target, expectedContent }) {
    const draft = store.list().drafts.find((item) => item.id === id);
    if (!draft || draft.revision !== revision || draft.status !== 'pending' || draft.target !== target || draft.content !== expectedContent) throw new Error('草稿或目标已变化，请重新读取后预览');
    if (draft.updateLock) throw new Error('草稿更新结果待核对，不能发起新更新');
    if (typeof expectedContent !== 'string' || expectedContent.length > MAX_CONTENT || !expectedContent.trim()) throw new Error('草稿正文无效或超出预览限制');
    return draft;
  }

  function preview(input) {
    if (!input || typeof input !== 'object') throw new Error('更新预览请求无效');
    const draft = findDraft(input);
    const requestId = input.requestId || crypto.randomUUID();
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw new Error('更新请求编号无效');
    if (typeof input.target !== 'string' || !input.target.toLowerCase().endsWith('.md')) throw new Error('更新目标必须是 Markdown 笔记');
    const vaultId = currentVaultId();
    if (typeof vaultId !== 'string' || !/^[a-f0-9]{64}$/.test(vaultId)) throw new Error('当前知识库标识无效');
    const mode = input.mode ?? 'replace';
    if (mode === 'append' && input.vaultId !== vaultId) throw new Error('知识库已变化，请重新读取并选择片段');
    const note = knowledgeStore().read(draft.target);
    if (currentVaultId() !== vaultId) throw new Error('知识库已变化，请重新读取并预览');
    if (note.content.length > MAX_CONTENT) throw new Error('目标笔记超过更新预览限制');
    let candidate;
    if (mode === 'append') {
      if (!input.selection || !input.beforeDigest) throw new Error('请先读取目标原文并选择被取代的片段');
      if (hash(note.content) !== input.beforeDigest) throw new Error('目标原文已变化，请重新读取并选择片段');
      candidate = createHistoryCandidate({ before: note.content, beforeDigest: input.beforeDigest, selection: input.selection, conclusion: draft.content, fenceUnsafeConclusion: true });
    } else if (mode !== 'replace' || input.selection !== undefined || input.beforeDigest !== undefined || input.vaultId !== undefined) throw new Error('更新方式或选区无效');
    const request = { requestId, vaultId, draftId: draft.id, revision: draft.revision, target: draft.target, before: note.content, after: candidate?.afterContent ?? draft.content, ...(mode === 'append' ? { mode, draftContent: draft.content } : {}) };
    const confirmation = guard.preview(request).confirmation;
    prunePreviews();
    previews.set(requestId, { request, confirmation, createdAt: Date.now() });
    return {
      requestId,
      confirmation,
      target: draft.target,
      beforeDigest: hash(note.content),
      beforeContent: note.content,
      afterContent: request.after,
      ...(candidate ? { mode, appendedContent: candidate.appendedContent, selection: candidate.selection, ...(candidate.conclusionFormat ? { conclusionFormat: candidate.conclusionFormat } : {}) } : {}),
      ...diff(note.content, request.after),
    };
  }

  async function submit({ id, revision, target, expectedContent, requestId, confirmation, confirmed }) {
    if (confirmed !== true) throw new Error('更新前必须明确确认');
    const saved = previews.get(requestId);
    if (!saved) throw new Error('更新预览已失效或服务已重启，请重新预览');
    const request = saved.request;
    if (request.draftId !== id || request.revision !== revision || request.target !== target || (request.draftContent ?? request.after) !== expectedContent || saved.confirmation !== confirmation) throw new Error('确认与草稿或目标不匹配，请重新预览');
    const notWritten = (reason) => {
      previews.delete(requestId);
      return { status: 'not_written', reason };
    };
    if (saved.createdAt < Date.now() - PREVIEW_TTL_MS) return notWritten('更新预览已过期，请重新预览');
    findDraft({ id, revision, target, expectedContent });
    if (currentVaultId() !== request.vaultId) return notWritten('当前知识库已变化，请重新读取并预览');
    const current = knowledgeStore().read(target);
    if (currentVaultId() !== request.vaultId || hash(current.content) !== hash(request.before)) return notWritten('目标笔记在预览后已变化，请重新读取并预览');
    previews.delete(requestId);
    const result = await guard.submit({ ...request, confirmation, confirmed: true });
    return { ...result, ...(result.status === 'completed' ? { updateReceipt: store.list().drafts.find((item) => item.id === id)?.updateReceipt } : {}) };
  }

  async function inspect({ id, revision, requestId }) {
    const draft = store.list().drafts.find((item) => item.id === id);
    const lock = draft?.updateLock;
    if (!draft || draft.revision !== revision || !lock || lock.requestId !== requestId) throw new Error('没有匹配的待核查更新');
    if (currentVaultId() !== lock.vaultId) return { status: 'unavailable' };
    if (lock.status === 'preparing') {
      let alive = true;
      try { process.kill(lock.ownerPid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      return { status: 'not_sent', bridgeStatus: 'not_sent', remoteStatus: 'not_sent', recoverable: !alive };
    }
    try {
      const note = knowledgeStore().read(lock.target);
      const digest = hash(note.content);
      const remote = typeof inspectNote === 'function' ? await inspectNote(lock.vaultId, lock.target, { requestId, beforeDigest: lock.beforeDigest, afterDigest: lock.afterDigest }) : { status: 'unavailable', drained: false };
      return {
        status: digest === lock.afterDigest ? 'matches_after' : digest === lock.beforeDigest ? 'matches_before' : 'differs',
        currentContent: note.content,
        remoteStatus: remote.status,
        bridgeStatus: remote.status,
        recoverable: digest === lock.afterDigest && remote.drained === true && ['completed', 'target_mismatch', 'resolved_unknown'].includes(remote.status),
      };
    } catch { return { status: 'unavailable' }; }
  }

  async function recover({ id, revision, requestId, confirmed }) {
    if (confirmed !== true) throw new Error('解除草稿冻结前必须明确确认');
    return guard.recover({ draftId: id, revision, requestId, confirmed: true });
  }

  function listCleanups() {
    const vaultId = currentVaultId();
    return store.list().updateCleanups.filter((entry) => entry.vaultId === vaultId).map(({ lockId, target, draftId, revision }) => ({ lockId, target, draftId, revision }));
  }

  function cleanup({ lockId, confirmed }) {
    if (confirmed !== true) throw new Error('清理更新锁前必须明确确认');
    if (typeof lockId !== 'string' || !/^[a-f0-9]{32}$/.test(lockId)) throw new Error('清理记录标识无效');
    const entry = store.list().updateCleanups.find((item) => item.lockId === lockId);
    if (!entry) throw new Error('清理记录不存在');
    if (entry.vaultId !== currentVaultId()) throw new Error('当前知识库与清理目标不一致');
    return { cleaned: guard.cleanupPending(lockId) };
  }

  function link({ id, revision, requestId, confirmed, issue: targetIssue }) {
    if (confirmed !== true) throw new Error('关联前必须明确确认');
    const draft = store.list().drafts.find((item) => item.id === id);
    const receipt = draft?.updateReceipt;
    if (!receipt || draft.updateLock || draft.revision !== revision || receipt.revision !== revision || receipt.requestId !== requestId || draft.target !== receipt.target || hash(draft.content) !== (receipt.draftDigest ?? receipt.afterDigest) || JSON.stringify(draft.issues || (draft.issue ? [draft.issue] : [])) !== JSON.stringify(receipt.issues || (receipt.issue ? [receipt.issue] : [])) || JSON.stringify(draft.sourceSession) !== JSON.stringify(receipt.sourceSession)) throw new Error('草稿或更新记录已变化，请重新核对');
    const issues = receipt.issues || (receipt.issue ? [receipt.issue] : []);
    if (!issues.length) throw new Error('此草稿没有工作项来源');
    if (currentVaultId() !== receipt.vaultId || hash(knowledgeStore().read(receipt.target).content) !== receipt.afterDigest) throw new Error('目标笔记或知识库已变化，请重新核对');
    if (!targetIssue && issues.length > 1) throw new Error('多工作项草稿必须指定要关联的工作项');
    const selected = issues.find((item) => issueKey(item) === issueKey(targetIssue || issues[0]));
    if (!selected) throw new Error('工作项不属于此更新快照');
    const pending = store.list().pendingNoteLinks.find((entry) => entry.kind === 'update' && entry.operationId === requestId && entry.draftId === id && entry.revision === revision && entry.target === receipt.target && entry.vaultId === receipt.vaultId && entry.contentDigest === receipt.afterDigest && issueKey(entry.issue) === issueKey(selected));
    return pending ? store.completePendingNoteLink(pending.id) : store.linkPublishedNote({ issue: selected, provider: 'markdown', path: receipt.target, vaultId: receipt.vaultId, title: draft.title }, receipt.sourceSession);
  }

  return { preview, submit, inspect, recover, listCleanups, cleanup, link };
}

module.exports = { createDraftNoteUpdater, diff };
