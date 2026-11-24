const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 14;
const LEGACY_VERSION = 1;
const DRAFT_UPDATE_CAPABILITY = Symbol('draft-update');
const EMPTY = () => ({ version: VERSION, links: [], drafts: [], noteLinks: [], updateCleanups: [], pendingNoteLinks: [], processedNoteLinks: [], publicationReservations: [], uncertainResolutions: [], projectLinks: [], knowledgeEntries: [], knowledgeReservations: [], knowledgeResolutions: [] });
const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function string(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} 必须是非空字符串，且不能超过 ${max} 字符`);
  }
  return value.trim();
}

function optional(value, name, max = 2000) {
  return value == null || value === '' ? '' : string(value, name, max);
}

function issue(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工作项无效');
  return {
    environment: string(input.environment, '环境', 512),
    tenantId: string(input.tenantId, '租户 ID', 200),
    projectId: string(input.projectId, '项目 ID', 200),
    issueId: string(input.issueId, '工作项 ID', 200),
    title: optional(input.title, '工作项标题', 500),
    url: optional(input.url, '工作项链接', 2048),
  };
}

function issueKey(input) {
  const item = issue(input);
  return JSON.stringify([item.environment, item.tenantId, item.projectId, item.issueId]);
}

function issueList(input) {
  if (Object.hasOwn(input, 'issues') && input.issues !== undefined && !Array.isArray(input.issues)) throw new Error('草稿工作项列表必须是数组');
  const values = Array.isArray(input.issues) ? input.issues : (input.issue ? [input.issue] : []);
  if (values.length > 100 || new Set(values.map(issueKey)).size !== values.length) throw new Error('草稿工作项列表无效或重复');
  return values.map(issue);
}

function link(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('关联无效');
  if (typeof input.primary !== 'boolean') throw new Error('主工作项标记无效');
  return {
    issue: issue(input.issue),
    sessionId: string(input.sessionId, '会话 ID', 200),
    sessionTitle: optional(input.sessionTitle, '会话标题', 500),
    summary: optional(input.summary, '摘要', 2000),
    primary: input.primary,
    linkedAt: string(input.linkedAt, '关联时间', 100),
  };
}

function linkKey(item) {
  return JSON.stringify([issueKey(item.issue), item.sessionId]);
}

function projectLink(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工程关联无效');
  const cwd = string(input.cwd, '工程目录', 4096);
  if (!path.isAbsolute(cwd) || cwd.includes('\0') || path.normalize(cwd) !== cwd) throw new Error('工程目录必须是规范化绝对路径');
  return {
    issue: issue(input.issue), projectId: string(input.projectId, 'Codex 工程 ID', 200), cwd,
    projectName: optional(input.projectName, '工程名称', 500), linkedAt: string(input.linkedAt, '关联时间', 100),
  };
}

function projectLinkKey(item) {
  const value = projectLink({ ...item, linkedAt: item.linkedAt ?? 'key' });
  return JSON.stringify([issueKey(value.issue), value.projectId, value.cwd]);
}

function noteLocation(provider, location, vaultId = '') {
  provider = string(provider, '知识适配器', 100);
  if (!/^[a-z][a-z0-9-]*$/.test(provider)) throw new Error('知识适配器标识无效');
  location = string(location, '知识位置', 2048);
  if (location.includes('\0')) throw new Error('知识位置无效');
  if (provider === 'markdown' && (location.includes('\\') || path.posix.isAbsolute(location) || !location.toLowerCase().endsWith('.md') || location.split('/').some((part) => !part || part === '.' || part === '..'))) throw new Error('Markdown 位置必须是知识库内的相对路径');
  if (typeof vaultId !== 'string' || (vaultId !== '' && !/^[a-f0-9]{64}$/.test(vaultId)) || (provider !== 'markdown' && vaultId !== '')) throw new Error('知识库标识无效');
  return { provider, path: location, vaultId };
}

function noteLink(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('知识关联无效');
  const sources = input.sourceSessions ?? [];
  if (!Array.isArray(sources) || sources.length > 1000) throw new Error('来源会话列表无效');
  const sourceSessions = sources.map((source) => ({ id: string(source?.id, '来源会话 ID', 200), title: optional(source?.title, '来源会话标题', 500) }));
  if (new Set(sourceSessions.map((source) => source.id)).size !== sourceSessions.length) throw new Error('来源会话重复');
  return {
    issue: issue(input.issue), ...noteLocation(input.provider, input.path, input.vaultId ?? ''),
    title: optional(input.title, '知识标题', 500), linkedAt: string(input.linkedAt, '关联时间', 100),
    sourceSessions,
  };
}

function noteLinkKey(item) {
  const location = noteLocation(item.provider, item.path, item.vaultId ?? '');
  return JSON.stringify([issueKey(item.issue), location.provider, location.vaultId, location.path]);
}

function knowledgeEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('知识目录记录无效');
  const location = noteLocation('markdown', input.path, input.vaultId);
  if (!location.vaultId) throw new Error('知识目录记录缺少知识库标识');
  if (!Array.isArray(input.origins) || !input.origins.length || input.origins.some((origin) => !['created', 'linked'].includes(origin)) || new Set(input.origins).size !== input.origins.length) throw new Error('知识目录来源无效');
  return { vaultId: location.vaultId, path: location.path, title: optional(input.title, '知识标题', 500), origins: [...input.origins].sort(), registeredAt: string(input.registeredAt, '登记时间', 100) };
}

function knowledgeEntryKey(item) {
  const location = noteLocation('markdown', item.path, item.vaultId);
  if (!location.vaultId) throw new Error('知识目录记录缺少知识库标识');
  return JSON.stringify([location.vaultId, location.path]);
}

function knowledgeOccupied(state) {
  const keys = new Set([...state.knowledgeEntries, ...state.knowledgeReservations].map(knowledgeEntryKey));
  for (const draft of state.drafts) {
    if (draft.updateLock) keys.add(knowledgeEntryKey({ vaultId: draft.updateLock.vaultId, path: draft.updateLock.target }));
  }
  return keys;
}

function registerKnowledgeEntry(state, input) {
  const entry = knowledgeEntry({ ...input, origins: [input.origin], registeredAt: input.registeredAt || new Date().toISOString() });
  const existing = state.knowledgeEntries.find((item) => knowledgeEntryKey(item) === knowledgeEntryKey(entry));
  if (!existing) {
    const occupied = knowledgeOccupied(state);
    if (!occupied.has(knowledgeEntryKey(entry)) && occupied.size >= 100000) throw new Error('知识目录容量不足');
    state.knowledgeEntries.push(entry);
    return entry;
  }
  if (!existing.origins.includes(input.origin)) existing.origins.push(input.origin);
  existing.origins.sort();
  if (!existing.title && entry.title) existing.title = entry.title;
  return existing;
}

function knowledgeReservation(input) {
  if (!input || typeof input !== 'object' || !/^[a-f0-9]{64}$/.test(input.operationId) || !/^[a-f0-9]{32}$/.test(input.generation)) throw new Error('知识目录预留无效');
  const legacy = input.kind === undefined && input.contentDigest === undefined;
  if (!legacy && (!['draft', 'direct'].includes(input.kind) || typeof input.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentDigest))) throw new Error('知识目录预留绑定无效');
  const entry = knowledgeEntry({ ...input, origins: ['created'], registeredAt: input.registeredAt });
  return { ...entry, operationId: input.operationId, generation: input.generation, ...(legacy ? {} : { kind: input.kind, contentDigest: input.contentDigest }) };
}

function knowledgeResolution(input) {
  if (!input || !['link', 'discard'].includes(input.decision)) throw new Error('知识目录处置无效');
  const entry = knowledgeReservation({ ...input, registeredAt: 'validated' });
  return { operationId: entry.operationId, generation: entry.generation, decision: input.decision, vaultId: entry.vaultId, path: entry.path, title: entry.title, ...(entry.kind ? { kind: entry.kind, contentDigest: entry.contentDigest } : {}) };
}

function draft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('草稿无效');
  const statuses = ['pending', 'deferred', 'discarded'];
  if (!statuses.includes(input.status)) throw new Error('草稿状态无效');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('草稿版本无效');
  if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 100000) {
    throw new Error('草稿内容必须是非空字符串，且不能超过 100000 字符');
  }
  const updateLock = input.updateLock == null ? undefined : validateDraftUpdateLock(input.updateLock);
  const issues = issueList(input);
  return {
    id: string(input.id, '草稿 ID', 200),
    title: string(input.title, '草稿标题', 500),
    content: input.content,
    target: optional(input.target, '目标位置', 2048),
    status: input.status,
    revision: input.revision,
    updatedAt: string(input.updatedAt, '更新时间', 100),
    ...(issues.length ? { issues, issue: issues[0] } : {}),
    ...(input.sourceSession == null ? {} : { sourceSession: {
      id: string(input.sourceSession.id, '来源会话 ID', 200),
      title: optional(input.sourceSession.title, '来源会话标题', 500),
    } }),
    ...(updateLock ? { updateLock } : {}),
    ...(input.updateReceipt ? { updateReceipt: validateUpdateReceipt(input.updateReceipt) } : {}),
  };
}

function validateUpdateReceipt(input) {
  const lock = validateDraftUpdateLock({ ...input, status: 'unknown' });
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('更新记录版本无效');
  const issues = issueList(input);
  return { ...lock, status: 'completed', revision: input.revision, completedAt: string(input.completedAt, '完成时间', 100), ...(issues.length ? { issues, issue: issues[0] } : {}), ...(input.sourceSession ? { sourceSession: { id: string(input.sourceSession.id, '来源会话 ID', 200), title: optional(input.sourceSession.title, '来源会话标题', 500) } } : {}) };
}

function validateDraftUpdateLock(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId) ||
      !Number.isSafeInteger(input.ownerPid) || input.ownerPid < 1 ||
      typeof input.vaultId !== 'string' || !/^[a-f0-9]{64}$/.test(input.vaultId) ||
      typeof input.target !== 'string' || !input.target.toLowerCase().endsWith('.md') || input.target.startsWith('/') || input.target.includes('\\') || input.target.includes('\0') || input.target.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof input.beforeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.beforeDigest) ||
      typeof input.afterDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.afterDigest) ||
      !['preparing', 'submitting', 'unknown'].includes(input.status)) throw new Error('草稿更新锁无效');
  if (input.lockId !== undefined && (typeof input.lockId !== 'string' || !/^[a-f0-9]{32}$/.test(input.lockId))) throw new Error('更新锁身份无效');
  if (input.draftDigest !== undefined && (typeof input.draftDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.draftDigest))) throw new Error('更新锁的草稿摘要无效');
  return { requestId: input.requestId, ownerPid: input.ownerPid, vaultId: input.vaultId, target: input.target, beforeDigest: input.beforeDigest, afterDigest: input.afterDigest, status: input.status, ...(input.lockId ? { lockId: input.lockId } : {}), ...(input.draftDigest ? { draftDigest: input.draftDigest } : {}) };
}

function validateUpdateCleanup(input) {
  const lock = validateDraftUpdateLock(input);
  if (!lock.lockId || typeof input.draftId !== 'string' || !input.draftId || input.draftId.length > 200 || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error('更新清理记录无效');
  return { ...lock, draftId: input.draftId, revision: input.revision };
}

function validatePendingNoteLink(input) {
  if (!input || typeof input !== 'object' || !['create', 'update'].includes(input.kind) || typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id) || typeof input.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentDigest)) throw new Error('待关联记录无效');
  const location = noteLocation('markdown', input.target, input.vaultId);
  if (!location.vaultId) throw new Error('待关联知识库无效');
  const operationId = string(input.operationId, '发布编号', 200);
  if (input.id !== digest([input.kind, operationId, input.draftId, input.revision, input.vaultId, input.target, input.contentDigest, issueKey(input.issue)])) throw new Error('待关联记录标识不匹配');
  return { id: input.id, kind: input.kind, operationId, draftId: string(input.draftId, '草稿 ID', 200), revision: Number.isSafeInteger(input.revision) && input.revision > 0 ? input.revision : (() => { throw new Error('草稿版本无效'); })(), target: location.path, vaultId: location.vaultId, contentDigest: input.contentDigest, title: string(input.title, '知识标题', 500), issue: issue(input.issue), ...(input.sourceSession ? { sourceSession: { id: string(input.sourceSession.id, '来源会话 ID', 200), title: optional(input.sourceSession.title, '来源会话标题', 500) } } : {}) };
}

function publishedLinkEntry(input) {
  const id = digest([input.kind, input.operationId, input.draftId, input.revision, input.vaultId, input.target, input.contentDigest, issueKey(input.issue)]);
  return validatePendingNoteLink({ ...input, id });
}

function queuePublishedLink(state, input) {
  if (!input.issue || !input.vaultId) return;
  const entry = publishedLinkEntry(input); const id = entry.id;
  state.publicationReservations = state.publicationReservations.filter((item) => item.id !== id);
  if (!state.processedNoteLinks.includes(id) && !state.pendingNoteLinks.some((item) => item.id === id)) state.pendingNoteLinks.push(entry);
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function validate(input) {
  if (!input || ![LEGACY_VERSION, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, VERSION].includes(input.version) || !Array.isArray(input.links) || !Array.isArray(input.drafts) || (input.version >= 3 && !Array.isArray(input.noteLinks))) {
    throw new Error('备份格式或版本无效');
  }
  if (input.version < 3 && Object.hasOwn(input, 'noteLinks')) throw new Error('旧版本备份不能包含知识关联');
  if (input.version < 6 && input.noteLinks?.some((item) => item && Object.hasOwn(item, 'sourceSessions'))) throw new Error('旧版本备份不能包含知识会话来源');
  if (input.version < 7 && input.drafts.some((item) => item && Object.hasOwn(item, 'updateLock'))) throw new Error('旧版本数据不能包含草稿更新锁');
  if (input.version < 8 && Object.hasOwn(input, 'updateCleanups')) throw new Error('旧版本数据不能包含更新清理记录');
  if (input.version < 9 && (Object.hasOwn(input, 'pendingNoteLinks') || Object.hasOwn(input, 'processedNoteLinks') || Object.hasOwn(input, 'publicationReservations'))) throw new Error('旧版本数据不能包含待关联记录');
  if (input.version < 10 && Object.hasOwn(input, 'uncertainResolutions')) throw new Error('旧版本数据不能包含未知结果处置记录');
  if (input.version < 12 && Object.hasOwn(input, 'projectLinks')) throw new Error('旧版本数据不能包含工程关联');
  if (input.version >= 12 && (!Array.isArray(input.projectLinks) || input.projectLinks.length > 100000)) throw new Error('工程关联列表无效');
  if (input.version < 13 && (Object.hasOwn(input, 'knowledgeEntries') || Object.hasOwn(input, 'knowledgeReservations') || Object.hasOwn(input, 'knowledgeResolutions'))) throw new Error('旧版本数据不能包含知识目录');
  if (input.version >= 13 && (!Array.isArray(input.knowledgeEntries) || input.knowledgeEntries.length > 110000)) throw new Error('知识目录无效');
  if (input.version >= 13 && (!Array.isArray(input.knowledgeReservations) || input.knowledgeReservations.length > 10000)) throw new Error('知识目录预留无效');
  if (input.version >= 13 && (!Array.isArray(input.knowledgeResolutions) || input.knowledgeResolutions.length > 100000)) throw new Error('知识目录处置无效');
  if (input.links.length > 100000 || input.drafts.length > 10000 || (input.noteLinks?.length || 0) > 100000) throw new Error('数据量超出限制');
  const drafts = input.drafts.map((item) => {
    if (input.version < 14 && item && (Object.hasOwn(item, 'issues') || (item.updateReceipt && Object.hasOwn(item.updateReceipt, 'issues')))) throw new Error('旧版本数据不能包含草稿工作项列表');
    if (input.version < 5 && item && Object.hasOwn(item, 'sourceSession')) throw new Error('旧版本备份不能包含会话来源');
    if (input.version === LEGACY_VERSION && item && typeof item === 'object' && !Array.isArray(item) && !Object.hasOwn(item, 'revision')) {
      return draft({ ...item, revision: 1 });
    }
    return draft(item);
  });
  if (input.updateCleanups !== undefined && (!Array.isArray(input.updateCleanups) || input.updateCleanups.length > 10000)) throw new Error('更新清理记录无效');
  const updateCleanups = (input.updateCleanups || []).map(validateUpdateCleanup);
  if (new Set(updateCleanups.map((entry) => entry.lockId)).size !== updateCleanups.length) throw new Error('更新清理记录重复');
  if (!Array.isArray(input.pendingNoteLinks ?? []) || !Array.isArray(input.processedNoteLinks ?? []) || !Array.isArray(input.publicationReservations ?? []) || (input.pendingNoteLinks?.length || 0) > 10000 || (input.processedNoteLinks?.length || 0) > 100000 || (input.publicationReservations?.length || 0) > 10000) throw new Error('待关联记录无效');
  const pendingNoteLinks = (input.pendingNoteLinks || []).map(validatePendingNoteLink);
  const processedNoteLinks = input.processedNoteLinks || [];
  const publicationReservations = (input.publicationReservations || []).map((item) => {
    if (typeof item.generation !== 'string' || !/^[a-f0-9]{32}$/.test(item.generation)) throw new Error('发布预留代次无效');
    return { ...validatePendingNoteLink(item), generation: item.generation };
  });
  const processedIds = new Set(processedNoteLinks); const pendingIds = new Set(pendingNoteLinks.map((item) => item.id)); const reservationIds = new Set(publicationReservations.map((item) => item.id));
  if (!Array.isArray(input.uncertainResolutions ?? []) || (input.uncertainResolutions?.length || 0) > 100000) throw new Error('未知结果处置记录无效');
  const uncertainResolutions = (input.uncertainResolutions || []).map((item) => {
    if (!item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id) || typeof item.generation !== 'string' || !/^[a-f0-9]{32}$/.test(item.generation) || !['link', 'discard'].includes(item.decision) || !processedIds.has(item.id)) throw new Error('未知结果处置记录无效');
    if (input.version < 11 && Object.hasOwn(item, 'context')) throw new Error('旧版本处置记录不能包含上下文');
    const context = item.context == null ? undefined : validatePendingNoteLink(item.context);
    if (context && context.id !== item.id) throw new Error('处置记录上下文不匹配');
    return { id: item.id, generation: item.generation, decision: item.decision, ...(context ? { context } : {}) };
  });
  if (new Set(uncertainResolutions.map((item) => item.id)).size !== uncertainResolutions.length) throw new Error('未知结果处置记录重复');
  if (processedNoteLinks.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || processedIds.size !== processedNoteLinks.length || pendingIds.size !== pendingNoteLinks.length || reservationIds.size !== publicationReservations.length || [...pendingIds].some((id) => processedIds.has(id) || reservationIds.has(id)) || [...reservationIds].some((id) => processedIds.has(id))) throw new Error('待关联记录重复或无效');
  const reservedUpdates = drafts.reduce((n, item) => n + (item.updateLock ? (item.issues?.length || (item.issue ? 1 : 0)) : 0), 0);
  const occupied = pendingNoteLinks.length + publicationReservations.length + reservedUpdates;
  if (occupied > 10000 || processedNoteLinks.length + occupied > 100000) throw new Error('待关联记录容量不足');
  const projectLinks = input.version >= 12 ? input.projectLinks.map(projectLink) : [];
  if (new Set(projectLinks.map(projectLinkKey)).size !== projectLinks.length) throw new Error('存在重复工程关联');
  const result = { version: VERSION, links: input.links.map(link), drafts, noteLinks: input.version >= 3 ? input.noteLinks.map(noteLink) : [], updateCleanups, pendingNoteLinks, processedNoteLinks, publicationReservations, uncertainResolutions, projectLinks, knowledgeEntries: input.version >= 13 ? input.knowledgeEntries.map(knowledgeEntry) : [], knowledgeReservations: input.version >= 13 ? input.knowledgeReservations.map(knowledgeReservation) : [], knowledgeResolutions: input.version >= 13 ? input.knowledgeResolutions.map(knowledgeResolution) : [] };
  const knowledgeByKey = new Map(result.knowledgeEntries.map((entry) => [knowledgeEntryKey(entry), entry]));
  if (knowledgeByKey.size !== result.knowledgeEntries.length) throw new Error('知识目录记录重复');
  for (const note of result.noteLinks) {
    if (note.provider !== 'markdown' || !note.vaultId) continue;
    const entry = knowledgeEntry({ vaultId: note.vaultId, path: note.path, title: note.title, origins: ['linked'], registeredAt: note.linkedAt });
    const key = knowledgeEntryKey(entry); const existing = knowledgeByKey.get(key);
    if (!existing) { result.knowledgeEntries.push(entry); knowledgeByKey.set(key, entry); }
    else { if (!existing.origins.includes('linked')) existing.origins.push('linked'); existing.origins.sort(); if (!existing.title && entry.title) existing.title = entry.title; }
  }
  if (new Set(result.knowledgeReservations.map((entry) => entry.operationId)).size !== result.knowledgeReservations.length || new Set(result.knowledgeReservations.map(knowledgeEntryKey)).size !== result.knowledgeReservations.length || new Set([...result.knowledgeEntries, ...result.knowledgeReservations].map(knowledgeEntryKey)).size > 110000) throw new Error('知识目录预留重复或超出容量');
  const knowledgeResolutionIds = new Set(result.knowledgeResolutions.map((entry) => entry.operationId));
  if (result.knowledgeResolutions.length + result.knowledgeReservations.length > 100000 || knowledgeResolutionIds.size !== result.knowledgeResolutions.length || result.knowledgeReservations.some((item) => knowledgeResolutionIds.has(item.operationId))) throw new Error('知识目录处置记录重复或容量不足');
  const keys = new Set();
  const primaries = new Set();
  for (const item of result.links) {
    const key = linkKey(item);
    if (keys.has(key)) throw new Error('存在重复关联');
    keys.add(key);
    if (item.primary && primaries.has(item.sessionId)) throw new Error('同一会话存在多个主工作项');
    if (item.primary) primaries.add(item.sessionId);
  }
  const draftIds = new Set();
  const updateTargets = new Set();
  for (const item of result.drafts) {
    if (draftIds.has(item.id)) throw new Error('存在重复草稿');
    draftIds.add(item.id);
    if (item.updateLock) {
      if (item.status !== 'pending' || item.target !== item.updateLock.target || crypto.createHash('sha256').update(item.content, 'utf8').digest('hex') !== (item.updateLock.draftDigest ?? item.updateLock.afterDigest)) throw new Error('锁定草稿与更新目标或内容不匹配');
      const key = JSON.stringify([item.updateLock.vaultId, item.updateLock.target]);
      if (updateTargets.has(key)) throw new Error('同一目标存在多个草稿更新锁');
      updateTargets.add(key);
    }
  }
  const noteKeys = new Set();
  for (const item of result.noteLinks) {
    const key = noteLinkKey(item);
    if (noteKeys.has(key)) throw new Error('存在重复知识关联');
    noteKeys.add(key);
  }
  return result;
}

class LocalStore {
  constructor(directory) {
    this.directory = path.resolve(string(directory, '存储目录', 4096));
    this.file = path.join(this.directory, 'index.json');
    this.lock = path.join(this.directory, '.index.lock');
  }

  read() {
    try {
      return validate(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return EMPTY();
      throw error;
    }
  }

  transaction(fn, capability) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = fs.openSync(this.lock, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('数据正被其他进程使用；若进程已异常退出，请检查锁文件');
      throw error;
    }
    let temp;
    try {
      const state = this.read();
      const before = clone(state);
      const result = fn(state);
      if (capability !== DRAFT_UPDATE_CAPABILITY) {
        if (JSON.stringify(before.updateCleanups) !== JSON.stringify(state.updateCleanups)) throw new Error('更新清理记录只能由更新流程管理');
        const beforeLocked = new Map(before.drafts.filter((item) => item.updateLock).map((item) => [item.id, item]));
        const afterById = new Map(state.drafts.map((item) => [item.id, item]));
        for (const item of state.drafts) if (item.updateLock && !beforeLocked.has(item.id)) throw new Error('草稿更新锁只能由更新流程管理');
        for (const [id, original] of beforeLocked) {
          const current = afterById.get(id);
          if (!current || JSON.stringify(current) !== JSON.stringify(original)) throw new Error('草稿正在更新或结果不确定，不能通过通用事务修改');
        }
      }
      const checked = validate(state);
      const previousKnowledge = knowledgeOccupied(before).size;
      const nextKnowledge = knowledgeOccupied(checked).size;
      if (nextKnowledge > 100000 && nextKnowledge > previousKnowledge) throw new Error('知识目录容量不足');
      temp = path.join(this.directory, `.index-${crypto.randomUUID()}.tmp`);
      const fd = fs.openSync(temp, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(checked, null, 2), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.file);
      temp = null;
      const parent = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      return clone(result ?? checked);
    } finally {
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
      fs.closeSync(lock);
      fs.unlinkSync(this.lock);
    }
  }

  list() { return clone(this.read()); }

  assertKnowledgeEntryCapacity(state, input) {
    const key = knowledgeEntryKey(input);
    const occupied = knowledgeOccupied(state);
    if (!occupied.has(key) && occupied.size >= 100000) throw new Error('知识目录容量不足');
  }

  registerKnowledgeEntry(state, input) { return registerKnowledgeEntry(state, input); }

  reserveKnowledgeEntry(state, input, generation) {
    const entry = knowledgeReservation({ ...input, generation, registeredAt: new Date().toISOString() });
    if (!entry.kind) throw new Error('新知识目录预留必须绑定流程和摘要');
    if (state.knowledgeReservations.length >= 10000) throw new Error('知识目录预留容量不足');
    if (state.knowledgeReservations.length + state.knowledgeResolutions.length >= 100000) throw new Error('知识目录处置记录容量不足');
    if (state.drafts.some((item) => item.updateLock && knowledgeEntryKey({ vaultId: item.updateLock.vaultId, path: item.updateLock.target }) === knowledgeEntryKey(entry))) throw new Error('知识目录目标正在更新');
    if (state.knowledgeResolutions.some((item) => item.operationId === entry.operationId) || state.knowledgeReservations.some((item) => item.operationId === entry.operationId || knowledgeEntryKey(item) === knowledgeEntryKey(entry))) throw new Error('知识目录目标已有预留或处置记录');
    this.assertKnowledgeEntryCapacity(state, entry);
    state.knowledgeReservations.push(entry);
    return entry;
  }

  hasKnowledgeReservation(state, input, generation) {
    const entry = knowledgeReservation({ ...input, generation, registeredAt: 'check' });
    if (!entry.kind) return false;
    return state.knowledgeReservations.some((item) => item.operationId === entry.operationId && item.generation === generation && knowledgeEntryKey(item) === knowledgeEntryKey(entry) && item.title === entry.title && item.kind === entry.kind && item.contentDigest === entry.contentDigest);
  }

  releaseKnowledgeReservation(state, input, generation) {
    if (!this.hasKnowledgeReservation(state, input, generation)) throw new Error('知识目录预留已变化');
    state.knowledgeReservations = state.knowledgeReservations.filter((item) => item.operationId !== input.operationId);
  }

  completeKnowledgeReservation(state, input, generation) {
    if (!this.hasKnowledgeReservation(state, input, generation)) throw new Error('知识目录预留已变化');
    const reservation = state.knowledgeReservations.find((item) => item.operationId === input.operationId);
    const result = registerKnowledgeEntry(state, { ...input, origin: 'created', registeredAt: reservation.registeredAt });
    this.releaseKnowledgeReservation(state, input, generation);
    return result;
  }

  resolveKnowledgeReservation(state, input, generation, decision) {
    const resolution = knowledgeResolution({ ...input, generation, decision });
    if (!this.hasKnowledgeReservation(state, input, generation)) throw new Error('知识目录预留已变化');
    if (state.knowledgeResolutions.length >= 100000) throw new Error('知识目录处置记录容量不足');
    if (decision === 'link') registerKnowledgeEntry(state, { ...input, origin: 'linked' });
    this.releaseKnowledgeReservation(state, input, generation);
    state.knowledgeResolutions.push(resolution);
    return resolution;
  }

  queuePublishedLink(state, input) { queuePublishedLink(state, input); }

  reservePublishedLink(state, input, generation) {
    if (!input.issue || !input.vaultId) return;
    if (typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) throw new Error('发布预留代次无效');
    const entry = publishedLinkEntry(input);
    if (state.pendingNoteLinks.some((item) => item.id === entry.id) || state.processedNoteLinks.includes(entry.id)) throw new Error('此版本的关联已记录');
    const existing = state.publicationReservations.find((item) => item.id === entry.id);
    if (existing) throw new Error('此版本已有发布预留，请先核查');
    state.publicationReservations.push({ ...entry, generation });
  }

  releasePublishedLink(state, input, generation) {
    if (!input.issue || !input.vaultId) return;
    const id = publishedLinkEntry(input).id;
    if (!state.publicationReservations.some((item) => item.id === id && item.generation === generation)) throw new Error('发布预留代次已变化');
    state.publicationReservations = state.publicationReservations.filter((item) => item.id !== id);
  }

  hasPublishedReservation(state, input, generation) {
    if (!input.issue || !input.vaultId) return false;
    const entry = publishedLinkEntry(input);
    return state.publicationReservations.some((item) => item.generation === generation && JSON.stringify(item) === JSON.stringify({ ...entry, generation }));
  }

  resolveUncertainReservation(state, input, generation, decision) {
    if (!['link', 'discard'].includes(decision)) throw new Error('未知结果处置方式无效');
    const entry = publishedLinkEntry(input);
    if (!this.hasPublishedReservation(state, entry, generation)) throw new Error('发布预留代次已变化');
    let result = null;
    if (decision === 'link') {
      const candidate = noteLink({ issue: entry.issue, provider: 'markdown', path: entry.target, vaultId: entry.vaultId, title: entry.title, linkedAt: new Date().toISOString(), sourceSessions: entry.sourceSession ? [entry.sourceSession] : [] });
      registerKnowledgeEntry(state, { vaultId: candidate.vaultId, path: candidate.path, title: candidate.title, origin: 'linked' });
      result = state.noteLinks.find((item) => noteLinkKey(item) === noteLinkKey(candidate));
      if (!result) { state.noteLinks.push(candidate); result = candidate; }
      else if (entry.sourceSession && !result.sourceSessions.some((source) => source.id === entry.sourceSession.id)) {
        if (result.sourceSessions.length >= 1000) throw new Error('来源会话数量超出限制');
        result.sourceSessions.push(entry.sourceSession);
      }
    }
    state.publicationReservations = state.publicationReservations.filter((item) => item.id !== entry.id);
    state.processedNoteLinks.push(entry.id);
    state.uncertainResolutions.push({ id: entry.id, generation, decision, context: entry });
    return result;
  }

  rememberPublishedLink(input) {
    return this.transaction((state) => { queuePublishedLink(state, input); });
  }

  completePendingNoteLink(id) {
    return this.transaction((state) => {
      const index = state.pendingNoteLinks.findIndex((entry) => entry.id === id);
      if (index < 0) throw new Error('待关联记录不存在');
      const pending = state.pendingNoteLinks[index];
      const candidate = noteLink({ issue: pending.issue, provider: 'markdown', path: pending.target, vaultId: pending.vaultId, title: pending.title, linkedAt: new Date().toISOString(), sourceSessions: pending.sourceSession ? [pending.sourceSession] : [] });
      registerKnowledgeEntry(state, { vaultId: candidate.vaultId, path: candidate.path, title: candidate.title, origin: 'linked' });
      let existing = state.noteLinks.find((entry) => noteLinkKey(entry) === noteLinkKey(candidate));
      if (!existing) { state.noteLinks.push(candidate); existing = candidate; }
      else if (pending.sourceSession && !existing.sourceSessions.some((source) => source.id === pending.sourceSession.id)) {
        if (existing.sourceSessions.length >= 1000) throw new Error('来源会话数量超出限制');
        existing.sourceSessions.push(pending.sourceSession);
      }
      state.pendingNoteLinks.splice(index, 1);
      state.processedNoteLinks.push(id);
      return existing;
    });
  }

  addNoteLink(input) {
    const item = noteLink({ ...input, linkedAt: new Date().toISOString() });
    if (item.provider === 'markdown' && !item.vaultId) throw new Error('新增 Markdown 关联必须指定知识库标识');
    return this.transaction((state) => {
      if (state.noteLinks.some((entry) => noteLinkKey(entry) === noteLinkKey(item))) throw new Error('知识关联已存在');
      if (item.provider === 'markdown' && item.vaultId) registerKnowledgeEntry(state, { vaultId: item.vaultId, path: item.path, title: item.title, origin: 'linked' });
      state.noteLinks.push(item);
      return item;
    });
  }

  linkPublishedNote(input, sourceSession) {
    const candidate = noteLink({ ...input, linkedAt: new Date().toISOString(), sourceSessions: sourceSession ? [sourceSession] : [] });
    if (candidate.provider === 'markdown' && !candidate.vaultId) throw new Error('新增 Markdown 关联必须指定知识库标识');
    return this.transaction((state) => {
      if (candidate.provider === 'markdown' && candidate.vaultId) registerKnowledgeEntry(state, { vaultId: candidate.vaultId, path: candidate.path, title: candidate.title, origin: 'linked' });
      const existing = state.noteLinks.find((entry) => noteLinkKey(entry) === noteLinkKey(candidate));
      if (!existing) { state.noteLinks.push(candidate); return candidate; }
      const source = candidate.sourceSessions[0];
      if (source && !existing.sourceSessions.some((entry) => entry.id === source.id)) {
        if (existing.sourceSessions.length >= 1000) throw new Error('来源会话数量超出限制');
        existing.sourceSessions.push(source);
      }
      return existing;
    });
  }

  removeNoteLink(targetIssue, provider, location, vaultId = '') {
    const key = noteLinkKey({ issue: targetIssue, provider, path: location, vaultId });
    return this.transaction((state) => {
      const index = state.noteLinks.findIndex((entry) => noteLinkKey(entry) === key);
      if (index < 0) throw new Error('知识关联不存在');
      state.noteLinks.splice(index, 1);
    });
  }

  addLink(input) {
    const item = link({ ...input, primary: input.primary ?? false, linkedAt: input.linkedAt ?? new Date().toISOString() });
    return this.transaction((state) => {
      if (state.links.some((existing) => linkKey(existing) === linkKey(item))) throw new Error('关联已存在');
      if (item.primary && state.links.some((existing) => existing.sessionId === item.sessionId && existing.primary)) {
        throw new Error('会话已有主工作项，请先更换');
      }
      state.links.push(item);
      return item;
    });
  }

  addProjectLink(input) {
    const item = projectLink({ ...input, linkedAt: new Date().toISOString() });
    return this.transaction((state) => {
      if (state.projectLinks.some((entry) => projectLinkKey(entry) === projectLinkKey(item))) throw new Error('工程关联已存在');
      state.projectLinks.push(item);
      return item;
    });
  }

  removeProjectLink(targetIssue, projectId, cwd) {
    const key = projectLinkKey({ issue: targetIssue, projectId, cwd });
    return this.transaction((state) => {
      const index = state.projectLinks.findIndex((entry) => projectLinkKey(entry) === key);
      if (index < 0) throw new Error('工程关联不存在');
      state.projectLinks.splice(index, 1);
    });
  }

  setPrimary(sessionId, targetIssue) {
    sessionId = string(sessionId, '会话 ID', 200);
    const key = issueKey(targetIssue);
    return this.transaction((state) => {
      if (!state.links.some((item) => item.sessionId === sessionId && issueKey(item.issue) === key)) throw new Error('关联不存在');
      for (const item of state.links) if (item.sessionId === sessionId) item.primary = issueKey(item.issue) === key;
    });
  }

  removeLink(sessionId, targetIssue, options = {}) {
    sessionId = string(sessionId, '会话 ID', 200);
    const key = issueKey(targetIssue);
    return this.transaction((state) => {
      const index = state.links.findIndex((item) => item.sessionId === sessionId && issueKey(item.issue) === key);
      if (index < 0) throw new Error('关联不存在');
      if (state.links[index].primary && options.confirmPrimaryRemoval !== true) throw new Error('解除主工作项需要明确确认');
      state.links.splice(index, 1);
    });
  }

  saveDraft(input, options = {}) {
    const id = input.id ?? crypto.randomUUID();
    const expectedRevision = options.expectedRevision;
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new Error('预期草稿版本无效');
    }
    return this.transaction((state) => {
      const index = state.drafts.findIndex((existing) => existing.id === id);
      if (index >= 0 && expectedRevision === undefined) throw new Error('更新草稿必须提供预期版本');
      if (index < 0 && expectedRevision !== undefined) throw new Error('草稿不存在，无法更新');
      if (index >= 0 && state.drafts[index].revision !== expectedRevision) throw new Error('草稿已被修改，请重新读取后再保存');
      if (index >= 0 && state.drafts[index].updateLock) throw new Error('草稿正在更新或结果不确定，核对完成前不能修改');
      if (Object.hasOwn(input, 'updateLock')) throw new Error('草稿更新锁只能由更新流程管理');
      if (index >= 0 && state.drafts[index].issues?.length > 1 && !Object.hasOwn(input, 'issues') && Object.hasOwn(input, 'issue')) throw new Error('多工作项草稿必须显式提供完整工作项列表');
      const sourceSession = Object.hasOwn(input, 'sourceSession') ? input.sourceSession : index < 0 ? undefined : state.drafts[index].sourceSession;
      const item = draft({ ...input, ...(index >= 0 && !Object.hasOwn(input, 'issues') && !Object.hasOwn(input, 'issue') && state.drafts[index].issues ? { issues: state.drafts[index].issues } : {}), updateReceipt: index < 0 ? undefined : state.drafts[index].updateReceipt, sourceSession, id, status: input.status ?? 'pending', revision: index < 0 ? 1 : expectedRevision + 1, updatedAt: new Date().toISOString() });
      if (index < 0) state.drafts.push(item); else state.drafts[index] = item;
      return item;
    });
  }

  deleteDraft(id, expectedRevision) {
    id = string(id, '草稿 ID', 200);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('删除草稿必须提供有效的预期版本');
    return this.transaction((state) => {
      const index = state.drafts.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('草稿不存在');
      if (state.drafts[index].revision !== expectedRevision) throw new Error('草稿已被修改，请重新读取后再删除');
      if (state.drafts[index].updateLock) throw new Error('草稿正在更新或结果不确定，核对完成前不能删除');
      state.drafts.splice(index, 1);
    });
  }

  beginDraftUpdate({ id, revision, target, content, updateLock }) {
    const lock = validateDraftUpdateLock(updateLock);
    if (typeof content !== 'string' || crypto.createHash('sha256').update(content, 'utf8').digest('hex') !== (lock.draftDigest ?? lock.afterDigest) || target !== lock.target) throw new Error('更新锁与目标草稿不匹配');
    return this.transaction((state) => {
      const item = state.drafts.find((entry) => entry.id === id);
      if (!item || item.revision !== revision || item.status !== 'pending' || item.target !== target || item.content !== content) throw new Error('草稿状态、版本或内容已变化');
      if (item.updateLock) throw new Error('草稿已有未完成更新，请先核对');
      if (state.drafts.some((entry) => entry.updateLock && entry.updateLock.vaultId === lock.vaultId && entry.updateLock.target === lock.target)) throw new Error('目标已有未完成更新，请先核对');
      if (state.knowledgeReservations.some((entry) => entry.vaultId === lock.vaultId && entry.path === lock.target)) throw new Error('目标已有未完成的知识目录操作');
      this.assertKnowledgeEntryCapacity(state, { vaultId: lock.vaultId, path: lock.target });
      item.updateLock = lock;
      return item;
    }, DRAFT_UPDATE_CAPABILITY);
  }

  finishDraftUpdate({ id, revision, requestId, outcome, trackCleanup = false }) {
    if (!['completed', 'not_written', 'unknown'].includes(outcome)) throw new Error('更新结果无效');
    return this.transaction((state) => {
      const item = state.drafts.find((entry) => entry.id === id);
      if (!item || item.revision !== revision || item.updateLock?.requestId !== requestId) throw new Error('草稿更新锁已变化');
      if (trackCleanup && outcome !== 'unknown') state.updateCleanups.push(validateUpdateCleanup({ ...item.updateLock, draftId: id, revision }));
      if (outcome === 'completed') {
        registerKnowledgeEntry(state, { vaultId: item.updateLock.vaultId, path: item.updateLock.target, title: item.title, origin: 'linked' });
        item.updateReceipt = validateUpdateReceipt({ ...item.updateLock, revision, completedAt: new Date().toISOString(), issues: item.issues, issue: item.issue, sourceSession: item.sourceSession });
        for (const linkedIssue of (item.issues || (item.issue ? [item.issue] : []))) queuePublishedLink(state, { kind: 'update', operationId: item.updateLock.requestId, draftId: id, revision, target: item.updateLock.target, vaultId: item.updateLock.vaultId, contentDigest: item.updateLock.afterDigest, title: item.title, issue: linkedIssue, sourceSession: item.sourceSession });
      }
      if (outcome === 'completed' || outcome === 'not_written') delete item.updateLock;
      else item.updateLock.status = 'unknown';
      return item;
    }, DRAFT_UPDATE_CAPABILITY);
  }

  dispatchDraftUpdate({ id, revision, requestId }) {
    return this.transaction((state) => {
      const item = state.drafts.find((entry) => entry.id === id);
      if (!item || item.revision !== revision || item.updateLock?.requestId !== requestId || item.updateLock.status !== 'preparing') throw new Error('草稿准备状态已变化');
      item.updateLock.status = 'submitting';
      return item;
    }, DRAFT_UPDATE_CAPABILITY);
  }

  recoverPreparedDraftUpdate({ id, revision, requestId }) {
    return this.transaction((state) => {
      const item = state.drafts.find((entry) => entry.id === id);
      const lock = item?.updateLock;
      if (!item || item.revision !== revision || !lock || lock.requestId !== requestId || lock.status !== 'preparing' || !lock.lockId) throw new Error('没有可恢复的准备阶段更新');
      if (processIsAlive(lock.ownerPid)) throw new Error('更新进程仍在运行，不能解除锁定');
      state.updateCleanups.push(validateUpdateCleanup({ ...lock, draftId: id, revision }));
      delete item.updateLock;
      return item;
    }, DRAFT_UPDATE_CAPABILITY);
  }

  recoverDraftUpdate({ id, revision, requestId, verifiedAfterDigest, confirmed, beforeUnlock, trackCleanup = false, legacyCleanupId }) {
    if (confirmed !== true) throw new Error('恢复更新前必须明确确认');
    return this.transaction((state) => {
      const item = state.drafts.find((entry) => entry.id === id);
      const lock = item?.updateLock;
      if (!item || item.revision !== revision || !lock || lock.requestId !== requestId || !['unknown', 'submitting'].includes(lock.status)) throw new Error('没有可恢复的草稿更新锁');
      if (lock.status === 'submitting') {
        // PID 仍存在时按进程存活处理；PID 复用可能导致锁无法自动恢复，但不会误解锁。
        if (processIsAlive(lock.ownerPid)) throw new Error('更新进程仍在运行，不能解除锁定');
      }
      if (verifiedAfterDigest !== lock.afterDigest) throw new Error('目标笔记与已确认内容不一致，不能解除锁定');
      if (trackCleanup) state.updateCleanups.push(validateUpdateCleanup({ ...lock, lockId: lock.lockId || legacyCleanupId, draftId: id, revision }));
      if (beforeUnlock !== undefined) {
        if (typeof beforeUnlock !== 'function') throw new Error('更新锁清理回调无效');
        beforeUnlock(clone(lock));
      }
      item.updateReceipt = validateUpdateReceipt({ ...lock, revision, completedAt: new Date().toISOString(), issues: item.issues, issue: item.issue, sourceSession: item.sourceSession });
      registerKnowledgeEntry(state, { vaultId: lock.vaultId, path: lock.target, title: item.title, origin: 'linked' });
      for (const linkedIssue of (item.issues || (item.issue ? [item.issue] : []))) queuePublishedLink(state, { kind: 'update', operationId: lock.requestId, draftId: id, revision, target: lock.target, vaultId: lock.vaultId, contentDigest: lock.afterDigest, title: item.title, issue: linkedIssue, sourceSession: item.sourceSession });
      delete item.updateLock;
      return item;
    }, DRAFT_UPDATE_CAPABILITY);
  }

  cleanupDraftUpdate(lockId, cleanup) {
    if (typeof cleanup !== 'function') throw new Error('更新清理回调无效');
    return this.transaction((state) => {
      const index = state.updateCleanups.findIndex((entry) => entry.lockId === lockId);
      if (index < 0) return false;
      cleanup(clone(state.updateCleanups[index]));
      state.updateCleanups.splice(index, 1);
      return true;
    }, DRAFT_UPDATE_CAPABILITY);
  }

  exportData() {
    const data = this.list();
    if (data.drafts.some((item) => item.updateLock)) throw new Error('存在正在更新或结果不确定的草稿，核对完成前不能导出');
    if (data.updateCleanups.length) throw new Error('存在待清理的更新锁，清理完成前不能导出');
    if (data.publicationReservations.length) throw new Error('存在尚未确定结果的新建笔记，核对完成前不能导出');
    if (data.knowledgeReservations.length) throw new Error('存在尚未确定结果的知识目录预留，核对完成前不能导出');
    const { detectSensitive } = require('./sensitive-check.cjs');
    const inspect = (value) => {
      if (typeof value === 'string') return detectSensitive(value).length > 0;
      if (Array.isArray(value)) return value.some(inspect);
      if (value && typeof value === 'object') return Object.values(value).some(inspect);
      return false;
    };
    if (inspect(data)) throw new Error('导出内容可能包含敏感信息，请检查草稿和关联信息后重试');
    return data;
  }

  previewImport(data) {
    const incoming = validate(data);
    if (incoming.drafts.some((item) => item.updateLock)) throw new Error('备份不能携带草稿更新锁');
    if (incoming.updateCleanups.length) throw new Error('备份不能携带更新清理记录');
    if (incoming.publicationReservations.length) throw new Error('备份不能携带发布预留记录');
    if (incoming.knowledgeReservations.length) throw new Error('备份不能携带知识目录预留');
    const current = this.read();
    const currentKnowledgeResolutions = new Map(current.knowledgeResolutions.map((entry) => [entry.operationId, entry]));
    const currentKnowledgeReservations = new Set(current.knowledgeReservations.map((entry) => entry.operationId));
    for (const item of incoming.knowledgeResolutions) {
      const existing = currentKnowledgeResolutions.get(item.operationId);
      if ((existing && JSON.stringify(existing) !== JSON.stringify(item)) || currentKnowledgeReservations.has(item.operationId)) throw new Error('知识目录处置记录冲突，不能自动合并');
    }
    for (const item of incoming.uncertainResolutions) {
      const existing = current.uncertainResolutions.find((entry) => entry.id === item.id);
      if ((existing && JSON.stringify(existing) !== JSON.stringify(item)) || current.publicationReservations.some((entry) => entry.id === item.id) || current.pendingNoteLinks.some((entry) => entry.id === item.id) || (current.processedNoteLinks.includes(item.id) && !existing)) throw new Error('未知结果处置记录冲突，不能自动合并');
    }
    for (const item of incoming.pendingNoteLinks) if (current.uncertainResolutions.some((entry) => entry.id === item.id)) throw new Error('未知结果处置记录冲突，不能自动合并');
    const conflicts = [];
    for (const [collection, keyFn] of [['links', linkKey], ['drafts', (item) => item.id], ['noteLinks', noteLinkKey], ['projectLinks', projectLinkKey], ['knowledgeEntries', knowledgeEntryKey]]) {
      const existing = new Map(current[collection].map((item) => [keyFn(item), item]));
      for (const item of incoming[collection]) {
        const key = keyFn(item);
        if (existing.has(key)) conflicts.push({ collection, key, current: existing.get(key), incoming: item });
        else if (collection === 'links' && item.primary) {
          const primary = current.links.find((entry) => entry.sessionId === item.sessionId && entry.primary);
          if (primary) conflicts.push({ collection, key, current: primary, incoming: item, reason: 'primary' });
        }
      }
    }
    return { token: digest([current, incoming]), conflicts, counts: { links: incoming.links.length, drafts: incoming.drafts.length, noteLinks: incoming.noteLinks.length, pendingNoteLinks: incoming.pendingNoteLinks.length, projectLinks: incoming.projectLinks.length, knowledgeEntries: incoming.knowledgeEntries.length } };
  }

  importData(data, token, decisions) {
    const incoming = validate(data);
    if (incoming.drafts.some((item) => item.updateLock)) throw new Error('备份不能携带草稿更新锁');
    if (incoming.updateCleanups.length) throw new Error('备份不能携带更新清理记录');
    if (incoming.publicationReservations.length) throw new Error('备份不能携带发布预留记录');
    if (incoming.knowledgeReservations.length) throw new Error('备份不能携带知识目录预留');
    if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) throw new Error('必须明确选择冲突处理方式');
    return this.transaction((state) => {
      if (digest([state, incoming]) !== token) throw new Error('预览已失效，请重新预览');
      const currentKnowledgeResolutions = new Map(state.knowledgeResolutions.map((entry) => [entry.operationId, entry]));
      const currentKnowledgeReservations = new Set(state.knowledgeReservations.map((entry) => entry.operationId));
      for (const item of incoming.knowledgeResolutions) {
        const existing = currentKnowledgeResolutions.get(item.operationId);
        if ((existing && JSON.stringify(existing) !== JSON.stringify(item)) || currentKnowledgeReservations.has(item.operationId)) throw new Error('知识目录处置记录冲突，不能自动合并');
        if (!existing) state.knowledgeResolutions.push(item);
      }
      for (const item of incoming.uncertainResolutions) {
        const existing = state.uncertainResolutions.find((entry) => entry.id === item.id);
        if ((existing && JSON.stringify(existing) !== JSON.stringify(item)) || state.publicationReservations.some((entry) => entry.id === item.id) || state.pendingNoteLinks.some((entry) => entry.id === item.id) || (state.processedNoteLinks.includes(item.id) && !existing)) throw new Error('未知结果处置记录冲突，不能自动合并');
      }
      for (const item of incoming.pendingNoteLinks) if (state.uncertainResolutions.some((entry) => entry.id === item.id)) throw new Error('未知结果处置记录冲突，不能自动合并');
      for (const [collection, keyFn] of [['links', linkKey], ['drafts', (item) => item.id], ['noteLinks', noteLinkKey], ['projectLinks', projectLinkKey], ['knowledgeEntries', knowledgeEntryKey]]) {
        const indexes = new Map(state[collection].map((item, index) => [keyFn(item), index]));
        for (const item of incoming[collection]) {
          const key = keyFn(item);
          const index = indexes.get(key) ?? -1;
          const existingPrimary = collection === 'links' && item.primary
            ? state.links.find((existing) => existing.sessionId === item.sessionId && existing.primary && linkKey(existing) !== key)
            : null;
          if (index < 0 && !existingPrimary) { indexes.set(key, state[collection].length); state[collection].push(item); continue; }
          const decision = decisions[JSON.stringify([collection, key])];
          if (!['skip', 'replace', 'merge'].includes(decision)) throw new Error('每个冲突都必须明确选择跳过、合并或替换');
          if (collection === 'drafts' && state.drafts[index]?.updateLock && decision !== 'skip') throw new Error('草稿正在更新或结果不确定，不能替换或合并');
          if (existingPrimary && decision === 'replace') existingPrimary.primary = false;
          if (existingPrimary && decision === 'merge') item.primary = false;
          if (index < 0) {
            if (decision !== 'skip') { indexes.set(key, state[collection].length); state[collection].push(item); }
            continue;
          }
          if (decision === 'replace') {
            if (collection === 'drafts') item.revision = state[collection][index].revision + 1;
            state[collection][index] = item;
          }
          if (decision === 'merge') {
            const current = state[collection][index];
            // 合并只补全本地空字段，不覆盖已有内容或主工作项选择。
            for (const field of Object.keys(current)) {
              if (current[field] === '' && item[field] !== '') current[field] = item[field];
            }
            if (collection === 'links' || collection === 'noteLinks' || collection === 'projectLinks') {
              for (const field of ['title', 'url']) if (!current.issue[field]) current.issue[field] = item.issue[field];
            }
            if (collection === 'noteLinks') {
              const sources = new Map(current.sourceSessions.map((source) => [source.id, source]));
              for (const source of item.sourceSessions) {
                const existing = sources.get(source.id);
                if (existing) {
                  if (!existing.title) existing.title = source.title;
                } else {
                  sources.set(source.id, source);
                }
              }
              current.sourceSessions = [...sources.values()];
            }
            if (collection === 'knowledgeEntries') current.origins = [...new Set([...current.origins, ...item.origins])].sort();
            if (collection === 'drafts') {
              const issues = new Map(issueList(current).map((value) => [issueKey(value), value]));
              for (const value of issueList(item)) if (!issues.has(issueKey(value))) issues.set(issueKey(value), value);
              current.issues = [...issues.values()];
              if (current.issues.length) current.issue = current.issues[0];
              current.revision += 1;
            }
          }
        }
      }
      for (const item of incoming.pendingNoteLinks) {
        const existing = state.pendingNoteLinks.find((entry) => entry.id === item.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new Error('待关联记录冲突，不能自动合并');
        if (!existing && !state.processedNoteLinks.includes(item.id)) state.pendingNoteLinks.push(item);
      }
      for (const id of incoming.processedNoteLinks) {
        if (!state.pendingNoteLinks.some((entry) => entry.id === id) && !state.processedNoteLinks.includes(id)) state.processedNoteLinks.push(id);
      }
      for (const item of incoming.uncertainResolutions) if (!state.uncertainResolutions.some((entry) => entry.id === item.id)) state.uncertainResolutions.push(item);
      validate(state);
    });
  }
}

module.exports = { LocalStore, issueKey, linkKey, noteLinkKey, projectLinkKey };
