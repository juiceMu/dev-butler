const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectSensitive } = require('./sensitive-check.cjs');
const { issueKey } = require('./core.cjs');

function createDraftPublisher({ store, knowledgeStore, vaultId }) {
  function recordLinks(record) { return record?.pendingLinks !== undefined ? (Array.isArray(record.pendingLinks) ? record.pendingLinks : []) : (record?.pendingLink ? [record.pendingLink] : []); }
  function matchesEntry(record, entry) {
    const expected = Object.fromEntries(Object.entries(entry).filter(([name]) => !['id', 'generation'].includes(name)));
    return recordLinks(record).some((item) => JSON.stringify(item) === JSON.stringify(expected));
  }
  const root = path.join(store.directory, 'draft-publications');
  function key(id, revision) {
    return crypto.createHash('sha256').update(JSON.stringify([id, revision])).digest('hex');
  }
  function contentDigest(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
  function previewUpdate({ id, revision, target, expectedContent }) {
    const draft = store.list().drafts.find((item) => item.id === id);
    if (!draft || draft.revision !== revision || draft.target !== target || draft.content !== expectedContent) throw new Error('草稿或目标已变化，请重新预览');
    const note = knowledgeStore().read(target);
    if (note.content.length > 100000 || draft.content.length > 100000) throw new Error('内容超过预览大小限制');
    const before = note.content.split('\n'); const after = draft.content.split('\n');
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    return {
      draftId: id, revision, target, noteRevision: note.revision, beforeContent: note.content,
      unchanged: note.content === draft.content,
      startLine: prefix + 1,
      removed: before.slice(prefix, before.length - suffix).join('\n'),
      added: after.slice(prefix, after.length - suffix).join('\n'),
    };
  }
  function recordPath(id, revision) { return path.join(root, `${key(id, revision)}.json`); }
  function get(id, revision, target, expectedContent) {
    let content;
    try { content = fs.readFileSync(recordPath(id, revision), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const record = JSON.parse(content);
      if (record.draftId !== id || record.revision !== revision || !['submitting', 'completed', 'target_exists', 'unknown'].includes(record.status)) throw new Error('无效记录');
      if (record.target !== target || record.contentDigest !== contentDigest(expectedContent)) return { draftId: id, revision, status: 'conflict' };
      return record;
    } catch { return { draftId: id, revision, status: 'unknown' }; }
  }
  function replace(file, record) {
    const temporary = path.join(root, `.publication-${crypto.randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
      const parent = fs.openSync(root, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function publish({ id, revision, target, expectedContent, confirmed }) {
    if (confirmed !== true) throw new Error('写入前必须明确确认');
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(revision) || revision < 1 || typeof target !== 'string' || !target || typeof expectedContent !== 'string') throw new Error('草稿或目标无效');
    function checkedDraft(state) {
      const draft = state.drafts.find((item) => item.id === id);
      if (!draft || draft.revision !== revision) throw new Error('草稿不存在或已被修改，请重新确认');
      if (draft.updateLock) throw new Error('草稿正在更新或结果不确定，核对完成前不能发布');
      if (draft.status !== 'pending') throw new Error('草稿已暂缓或舍弃，请先恢复为待确认');
      if (draft.target !== target) throw new Error('目标已变化，请重新确认');
      if (draft.content !== expectedContent) throw new Error('草稿内容已变化，请重新确认');
      if (get(id, revision, target, expectedContent)) throw new Error('此版本已有提交记录，请先核查，不能重复写入');
      return draft;
    }
    const generation = crypto.randomBytes(16).toString('hex');
    const { pendingLinks, knowledgeEntry } = store.transaction((state) => {
      const draft = checkedDraft(state);
      const pendingLinks = vaultId ? (draft.issues || (draft.issue ? [draft.issue] : [])).map((linkedIssue) => ({ kind: 'create', operationId: key(id, revision), draftId: id, revision, target, vaultId: vaultId(), contentDigest: contentDigest(draft.content), title: draft.title, issue: linkedIssue, ...(draft.sourceSession ? { sourceSession: draft.sourceSession } : {}) })) : [];
      for (const entry of pendingLinks) store.reservePublishedLink(state, entry, generation);
      const knowledge = vaultId ? { kind: 'draft', vaultId: vaultId(), path: target, title: draft.title, operationId: key(id, revision), contentDigest: contentDigest(draft.content) } : null;
      if (knowledge) store.reserveKnowledgeEntry(state, knowledge, generation);
      return { pendingLinks, knowledgeEntry: knowledge };
    });
    return store.transaction((state) => {
      const draft = checkedDraft(state);
      if (pendingLinks.some((entry) => !vaultId || vaultId() !== entry.vaultId || !store.hasPublishedReservation(state, entry, generation))) throw new Error('发布预留已变化，请重新确认');
      if (knowledgeEntry && (!vaultId || vaultId() !== knowledgeEntry.vaultId || !store.hasKnowledgeReservation(state, knowledgeEntry, generation))) throw new Error('知识目录预留已变化，请重新确认');
      const findings = detectSensitive(draft.content);
      if (findings.length) { for (const entry of pendingLinks) store.releasePublishedLink(state, entry, generation); if (knowledgeEntry) store.releaseKnowledgeReservation(state, knowledgeEntry, generation); return { draftId: id, revision, status: 'sensitive_detected', findings }; }
      let adapter;
      try {
        adapter = knowledgeStore();
        if (typeof adapter.prepare === 'function') adapter.prepare({ path: target, content: draft.content });
      } catch {
        for (const entry of pendingLinks) store.releasePublishedLink(state, entry, generation);
        if (knowledgeEntry) store.releaseKnowledgeReservation(state, knowledgeEntry, generation);
        return { draftId: id, revision, target, status: 'preflight_failed' };
      }
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const file = recordPath(id, revision);
      const pending = { draftId: id, revision, target, contentDigest: contentDigest(draft.content), status: 'submitting', ...(vaultId ? { vaultId: pendingLinks[0]?.vaultId || vaultId() } : {}), ...(pendingLinks.length ? { issueKeys: pendingLinks.map((entry) => issueKey(entry.issue)), pendingLinks } : {}), ...(knowledgeEntry ? { knowledgeEntry, generation } : {}) };
      let fd;
      try { fd = fs.openSync(file, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('此版本已有提交记录，请先核查，不能重复写入'); throw error; }
      try { fs.writeFileSync(fd, JSON.stringify(pending)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const parent = fs.openSync(root, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      let result;
      try { result = adapter.create({ path: target, content: draft.content, confirmed: true }); }
      catch (error) {
        const failed = { ...pending, status: error.code === 'EEXIST' ? 'target_exists' : 'unknown' };
        try { replace(file, failed); } catch { return { ...pending, status: 'unknown' }; }
        if (failed.status === 'target_exists') for (const entry of pendingLinks) store.releasePublishedLink(state, entry, generation);
        if (knowledgeEntry && failed.status === 'target_exists') store.releaseKnowledgeReservation(state, knowledgeEntry, generation);
        return failed;
      }
      const completed = { ...pending, status: 'completed', noteRevision: result.revision };
      try { replace(file, completed); for (const entry of pendingLinks) store.queuePublishedLink(state, entry); if (knowledgeEntry) store.completeKnowledgeReservation(state, knowledgeEntry, generation); return completed; }
      catch { return { ...pending, status: 'unknown' }; }
    });
  }
  function inspectReservationRecord(entry) {
    let record;
    try { record = JSON.parse(fs.readFileSync(recordPath(entry.draftId, entry.revision), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return 'not_started'; return 'unknown'; }
    if (!record || record.generation !== entry.generation || record.draftId !== entry.draftId || record.revision !== entry.revision || record.target !== entry.target || record.vaultId !== entry.vaultId || record.contentDigest !== entry.contentDigest || !matchesEntry(record, entry)) return 'unknown';
    if (record.status === 'target_exists') return 'not_written';
    if (record.status === 'completed') return 'completed';
    return 'unknown';
  }

  function inspectKnowledgeReservation(entry) {
    if (entry.kind !== 'draft' || typeof entry.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.contentDigest)) return { status: 'unknown' };
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(root, `${entry.operationId}.json`), 'utf8')); }
    catch (error) { return { status: error.code === 'ENOENT' ? 'not_started' : 'unknown' }; }
    const saved = record?.knowledgeEntry;
    if (!record || typeof record.draftId !== 'string' || !record.draftId || !Number.isSafeInteger(record.revision) || record.revision < 1 || record.contentDigest !== entry.contentDigest || key(record.draftId, record.revision) !== entry.operationId || record.generation !== entry.generation || record.target !== entry.path || record.vaultId !== entry.vaultId || !saved || saved.kind !== 'draft' || saved.operationId !== entry.operationId || saved.vaultId !== entry.vaultId || saved.path !== entry.path || saved.title !== entry.title || saved.contentDigest !== entry.contentDigest) return { status: 'unknown' };
    if (record.status === 'target_exists') return { status: 'not_written', record };
    if (record.status === 'completed' && record.noteRevision === record.contentDigest) return { status: 'completed', record };
    return { status: 'unknown', record };
  }

  function listKnowledgeReservations() {
    const current = vaultId ? vaultId() : '';
    const state = store.list();
    const linked = new Set(state.publicationReservations.map((entry) => JSON.stringify([entry.operationId, entry.generation])));
    return state.knowledgeReservations.filter((entry) => entry.vaultId === current && entry.kind === 'draft' && !linked.has(JSON.stringify([entry.operationId, entry.generation]))).map((entry) => ({ operationId: entry.operationId, generation: entry.generation, path: entry.path, title: entry.title, status: inspectKnowledgeReservation(entry).status }));
  }

  function releaseKnowledgeReservation({ operationId, generation, confirmed }) {
    if (confirmed !== true || typeof operationId !== 'string' || !/^[a-f0-9]{64}$/.test(operationId) || typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) throw new Error('释放知识目录预留前必须明确确认');
    return store.transaction((state) => {
      const entry = state.knowledgeReservations.find((item) => item.operationId === operationId && item.generation === generation);
      if (!entry || entry.kind !== 'draft' || !vaultId || vaultId() !== entry.vaultId) throw new Error('知识目录预留不存在、已变化或不属于当前知识库');
      const status = inspectKnowledgeReservation(entry).status;
      if (!['not_started', 'not_written'].includes(status)) throw new Error('写入结果无法证明未发生，不能释放预留');
      if (state.publicationReservations.some((item) => item.operationId === operationId && item.generation === generation)) throw new Error('此记录同时包含工作项关联，请使用工作项处置入口');
      store.releaseKnowledgeReservation(state, entry, generation);
      return { released: true, status };
    });
  }

  function reconcileKnowledgeEntries() {
    const warnings = [];
    const current = vaultId ? vaultId() : '';
    for (const entry of store.list().knowledgeReservations.filter((item) => item.vaultId === current && item.kind === 'draft')) {
      const { status } = inspectKnowledgeReservation(entry);
      if (status !== 'completed') {
        warnings.push({ operationId: entry.operationId, reason: '知识目录预留尚未完成，请核查' });
        continue;
      }
      try {
        store.transaction((state) => {
          if (!store.hasKnowledgeReservation(state, entry, entry.generation) || inspectKnowledgeReservation(entry).status !== 'completed') throw new Error('知识目录预留已变化');
          store.completeKnowledgeReservation(state, entry, entry.generation);
        });
      } catch { warnings.push({ operationId: entry.operationId, reason: '完成记录无法恢复到知识目录' }); }
    }
    return warnings;
  }

  function inspectKnowledgeResolution({ operationId, generation }) {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{64}$/.test(operationId) || typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) throw new Error('知识目录处置标识无效');
    const state = store.list();
    const reservation = state.knowledgeReservations.find((item) => item.operationId === operationId && item.generation === generation);
    const resolution = state.knowledgeResolutions.find((item) => item.operationId === operationId && item.generation === generation);
    const context = reservation || resolution;
    if (context && context.kind !== 'draft') throw new Error('知识目录处置记录类型不匹配');
    if (!context || !vaultId || vaultId() !== context.vaultId) throw new Error('知识目录处置记录不存在或不属于当前知识库');
    if (reservation && inspectKnowledgeReservation(reservation).status !== 'unknown') throw new Error('当前记录不是结果未知的处置待办');
    return { status: reservation ? 'pending' : 'resolved', writeStatus: 'unknown', path: context.path, title: context.title, ...(resolution ? { decision: resolution.decision } : {}) };
  }

  function resolveKnowledgeReservation({ operationId, generation, decision, acceptUncertain, confirmed }) {
    if (confirmed !== true || acceptUncertain !== true || !['link', 'discard'].includes(decision)) throw new Error('须明确选择处置方式并确认写入来源未知');
    if (typeof operationId !== 'string' || !/^[a-f0-9]{64}$/.test(operationId) || typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) throw new Error('知识目录处置标识无效');
    return store.transaction((state) => {
      const entry = state.knowledgeReservations.find((item) => item.operationId === operationId && item.generation === generation);
      if (!entry || entry.kind !== 'draft' || !vaultId || vaultId() !== entry.vaultId) throw new Error('知识目录预留不存在、已变化或不属于当前知识库');
      const { status, record } = inspectKnowledgeReservation(entry);
      if (status !== 'unknown' || !record || !['unknown', 'submitting'].includes(record.status) || !record.knowledgeEntry || !/^[a-f0-9]{64}$/.test(record.contentDigest)) throw new Error('提交记录不可核实，不能人工处置');
      if (state.publicationReservations.some((item) => item.operationId === operationId && item.generation === generation)) throw new Error('此记录同时包含工作项关联，请使用工作项处置入口');
      if (decision === 'link') {
        const note = knowledgeStore().read(entry.path);
        if (contentDigest(note.content) !== record.contentDigest || vaultId() !== entry.vaultId) throw new Error('当前笔记内容或知识库已变化，不能关联');
      }
      // 记录意向不代表索引事务已完成；最终结果只查询索引。
      replace(path.join(root, `${operationId}.json`), { ...record, status: 'unknown', manualKnowledgeDisposition: { type: decision, at: new Date().toISOString() } });
      store.resolveKnowledgeReservation(state, entry, generation, decision);
      return { resolved: true, writeStatus: 'unknown', decision };
    });
  }

  function listReservations() {
    const current = vaultId ? vaultId() : '';
    return store.list().publicationReservations.filter((entry) => entry.vaultId === current).map((entry) => ({ id: entry.id, generation: entry.generation, draftId: entry.draftId, revision: entry.revision, target: entry.target, issue: entry.issue, title: entry.title, status: inspectReservationRecord(entry) }));
  }

  function releaseReservation({ id, generation, confirmed }) {
    if (confirmed !== true) throw new Error('释放发布预留前必须明确确认');
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('发布预留标识无效');
    if (typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) throw new Error('发布预留代次无效');
    return store.transaction((state) => {
      const entry = state.publicationReservations.find((item) => item.id === id);
      if (!entry) throw new Error('发布预留不存在');
      if (entry.generation !== generation) throw new Error('发布预留代次已变化');
      if (!vaultId || vaultId() !== entry.vaultId) throw new Error('当前知识库与发布预留不一致');
      const status = inspectReservationRecord(entry);
      if (!['not_started', 'not_written'].includes(status)) throw new Error('发布结果无法证明未写入，不能释放预留');
      store.releasePublishedLink(state, entry, generation);
      const knowledge = state.knowledgeReservations.find((item) => item.kind === 'draft' && item.operationId === entry.operationId && item.generation === generation);
      if (knowledge && !state.publicationReservations.some((item) => item.operationId === entry.operationId && item.generation === generation)) store.releaseKnowledgeReservation(state, knowledge, generation);
      return { released: true, status };
    });
  }
  function resolveUncertainReservation({ id, generation, confirmed, acceptUncertain, decision }) {
    if (confirmed !== true || acceptUncertain !== true) throw new Error('必须明确确认已人工检查并接受写入结果未知');
    if (!['link', 'discard'].includes(decision)) throw new Error('必须明确选择关联或放弃');
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('发布预留标识无效');
    if (typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) throw new Error('发布预留代次无效');
    return store.transaction((state) => {
      const entry = state.publicationReservations.find((item) => item.id === id);
      if (!entry || entry.generation !== generation) throw new Error('发布预留不存在或代次已变化');
      if (!vaultId || vaultId() !== entry.vaultId) throw new Error('当前知识库与发布预留不一致');
      if (inspectReservationRecord(entry) !== 'unknown') throw new Error('此预留不是可人工处置的未知结果');
      const file = recordPath(entry.draftId, entry.revision);
      let record;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('提交记录损坏，不能释放预留'); }
      if (!record || !['submitting', 'unknown'].includes(record.status) || record.generation !== generation || record.draftId !== entry.draftId || record.revision !== entry.revision || record.target !== entry.target || record.vaultId !== entry.vaultId || record.contentDigest !== entry.contentDigest || !matchesEntry(record, entry)) throw new Error('提交记录与预留不一致，不能释放预留');
      if (decision === 'link') {
        const note = knowledgeStore().read(entry.target);
        if (contentDigest(note.content) !== entry.contentDigest) throw new Error('当前笔记内容与待核对内容不一致，不能关联');
        if (!vaultId || vaultId() !== entry.vaultId) throw new Error('当前知识库已变化');
      }
      // 预留仍存在表示索引尚未处置，可由用户重新明确选择。
      replace(file, { ...record, status: 'unknown', manualDisposition: { type: decision, at: new Date().toISOString() } });
      const association = store.resolveUncertainReservation(state, entry, generation, decision);
      if (record.knowledgeEntry && !state.publicationReservations.some((item) => item.operationId === entry.operationId && item.generation === generation)) {
        const noteDecision = state.uncertainResolutions.some((item) => item.generation === generation && item.context?.operationId === entry.operationId && item.decision === 'link') ? 'link' : 'discard';
        store.resolveKnowledgeReservation(state, record.knowledgeEntry, generation, noteDecision);
      }
      return { resolved: true, status: 'unknown', decision, association };
    });
  }
  function inspectUncertainResolution({ id, revision, target, expectedContent }) {
    const record = get(id, revision, target, expectedContent);
    if (!record || record.status !== 'unknown' || !recordLinks(record).length || !record.generation || !['link', 'discard'].includes(record.manualDisposition?.type)) throw new Error('没有可核查的人工处置记录');
    if (!vaultId || vaultId() !== record.vaultId) throw new Error('当前知识库与提交时不同');
    const links = recordLinks(record);
    if (links.length > 1) throw new Error('多工作项处置请使用单项预留标识核查');
    const p = links[0];
    if (record.draftId !== p.draftId || record.revision !== p.revision || record.target !== p.target || record.vaultId !== p.vaultId || record.contentDigest !== p.contentDigest) throw new Error('提交记录绑定不一致');
    const pendingId = crypto.createHash('sha256').update(JSON.stringify([p.kind, p.operationId, p.draftId, p.revision, p.vaultId, p.target, p.contentDigest, issueKey(p.issue)])).digest('hex');
    const state = store.list();
    const reservation = state.publicationReservations.find((item) => item.id === pendingId);
    if (reservation && reservation.generation !== record.generation) throw new Error('发布预留代次已变化');
    if (reservation) return { status: 'pending', writeStatus: 'unknown' };
    const resolution = state.uncertainResolutions.find((item) => item.id === pendingId && item.generation === record.generation);
    if (resolution) return { status: 'resolved', decision: resolution.decision, writeStatus: 'unknown' };
    throw new Error('处置结果无法确认');
  }
  function inspectReservationResolution({ id, generation }) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id) || typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) throw new Error('处置记录标识无效');
    const state = store.list();
    const pending = state.publicationReservations.find((item) => item.id === id && item.generation === generation);
    const result = state.uncertainResolutions.find((item) => item.id === id && item.generation === generation);
    const context = pending || result?.context;
    if (!context) throw new Error('处置记录不存在或旧记录缺少可核实的上下文');
    if (!vaultId || vaultId() !== context.vaultId) throw new Error('当前知识库与提交时不同');
    return { status: pending ? 'pending' : 'resolved', writeStatus: 'unknown', ...(result ? { decision: result.decision } : {}), issue: context.issue, vaultId: context.vaultId, target: context.target, title: context.title };
  }
  function reconcilePendingLinks() {
    let names;
    try { names = fs.readdirSync(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const state = store.list();
    const known = new Set([...state.processedNoteLinks, ...state.pendingNoteLinks.map((entry) => entry.id)]);
    const warnings = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
        if (!record || typeof record !== 'object' || !['submitting', 'completed', 'target_exists', 'unknown'].includes(record.status) || typeof record.draftId !== 'string' || !Number.isSafeInteger(record.revision) || name !== `${key(record.draftId, record.revision)}.json`) throw new Error('记录无效');
        if (record.status !== 'completed') continue;
        const links = recordLinks(record);
        if (!links.length) {
          if (record.issueKey || record.issueKeys?.length) warnings.push({ file: name, reason: '发布记录缺少关联快照' });
          continue;
        }
        if (record.issueKeys && (!Array.isArray(record.issueKeys) || JSON.stringify(record.issueKeys) !== JSON.stringify(links.map((entry) => issueKey(entry.issue))) || new Set(record.issueKeys).size !== record.issueKeys.length)) throw new Error('工作项快照不一致');
        for (const p of links) {
          if (p.kind !== 'create' || record.draftId !== p.draftId || record.revision !== p.revision || record.target !== p.target || record.vaultId !== p.vaultId || record.contentDigest !== p.contentDigest) throw new Error('记录绑定不一致');
        }
        const pendingIds = links.map((p) => crypto.createHash('sha256').update(JSON.stringify([p.kind, p.operationId, p.draftId, p.revision, p.vaultId, p.target, p.contentDigest, issueKey(p.issue)])).digest('hex'));
        if (pendingIds.every((id) => known.has(id))) continue;
        store.transaction((current) => {
          for (const p of links) store.queuePublishedLink(current, p);
        });
        for (const pendingId of pendingIds) known.add(pendingId);
      } catch { warnings.push({ file: name, reason: '发布记录损坏或无法恢复' }); }
    }
    return warnings;
  }
  function inspectUncertain({ id, revision, target, expectedContent }) {
    const draft = store.list().drafts.find((item) => item.id === id);
    if (!draft || draft.revision !== revision || draft.target !== target || draft.content !== expectedContent) throw new Error('草稿或目标已变化，请重新核对');
    const record = get(id, revision, target, expectedContent);
    if (!record || !['unknown', 'submitting'].includes(record.status) || !record.vaultId || !record.contentDigest) throw new Error('无法核实此提交记录，请手动检查目标');
    if (!vaultId || vaultId() !== record.vaultId) throw new Error('当前知识库与提交时不同，请切换回原知识库');
    try {
      const note = knowledgeStore().read(target);
      return { status: contentDigest(note.content) === record.contentDigest ? 'matches' : 'differs' };
    } catch { return { status: 'unavailable' }; }
  }
  function linkPublished({ id, revision, target, expectedContent, confirmed, issue: targetIssue }) {
    if (confirmed !== true) throw new Error('关联前必须明确确认');
    const draft = store.list().drafts.find((item) => item.id === id);
    if (!draft || draft.revision !== revision || draft.target !== target || draft.content !== expectedContent || !draft.issue) throw new Error('草稿或工作项已变化，请重新核对');
    const record = get(id, revision, target, expectedContent);
    const issues = draft.issues || [draft.issue];
    if (!targetIssue && issues.length > 1) throw new Error('多工作项草稿必须指定要关联的工作项');
    const selected = issues.find((item) => issueKey(item) === issueKey(targetIssue || draft.issue));
    if (!selected) throw new Error('工作项不属于此草稿快照');
    if (!record || record.status !== 'completed' || !record.vaultId || !(record.issueKey === issueKey(selected) || record.issueKeys?.includes(issueKey(selected)))) throw new Error('无法确认笔记与工作项的写入记录，请手动核对后关联');
    if (!vaultId || vaultId() !== record.vaultId) throw new Error('当前知识库与写入时不同，请切换回原知识库');
    const note = knowledgeStore().read(target);
    if (contentDigest(note.content) !== record.contentDigest) throw new Error('笔记内容已变化，请核对后手动关联');
    if (reconcilePendingLinks().some((warning) => warning.file === `${key(id, revision)}.json`)) throw new Error('发布记录无法恢复，不能确认关联');
    const pending = store.list().pendingNoteLinks.find((entry) => entry.kind === 'create' && entry.draftId === id && entry.revision === revision && entry.target === target && entry.vaultId === record.vaultId && entry.contentDigest === record.contentDigest && issueKey(entry.issue) === issueKey(selected));
    if (pending) return store.completePendingNoteLink(pending.id);
    return store.linkPublishedNote({ issue: selected, provider: 'markdown', path: target, vaultId: record.vaultId, title: draft.title }, draft.sourceSession);
  }
  return { get, publish, linkPublished, inspectUncertain, previewUpdate, reconcilePendingLinks, listReservations, releaseReservation, listKnowledgeReservations, releaseKnowledgeReservation, reconcileKnowledgeEntries, resolveKnowledgeReservation, inspectKnowledgeResolution, resolveUncertainReservation, inspectUncertainResolution, inspectReservationResolution };
}
module.exports = { createDraftPublisher };
