const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createDirectKnowledgeCreator({ store, knowledgeStore, vaultId }) {
  const root = path.join(store.directory, 'direct-knowledge-creations');
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const validId = (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
  const fileFor = (id) => path.join(root, `${id}.json`);
  function syncRoot() {
    const fd = fs.openSync(root, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  function replace(file, record) {
    const temp = path.join(root, `.direct-${crypto.randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file); syncRoot();
    } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function read(id) {
    if (!validId(id)) throw new Error('操作标识无效');
    let record;
    try { record = JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('新建记录损坏，不能重试'); }
    if (!record || record.operationId !== id || !['preparing', 'submitting', 'completed', 'not_written', 'target_exists', 'unknown'].includes(record.status) || !/^[a-f0-9]{32}$/.test(record.generation || '') || !/^[a-f0-9]{64}$/.test(record.contentDigest || '') || !/^[a-f0-9]{64}$/.test(record.attachmentsDigest || '') || (record.status === 'completed' && record.revision !== record.contentDigest) || !record.knowledgeEntry || record.knowledgeEntry.operationId !== id || record.knowledgeEntry.kind !== 'direct' || record.knowledgeEntry.contentDigest !== record.contentDigest || !/^[a-f0-9]{64}$/.test(record.knowledgeEntry.vaultId || '') || typeof record.knowledgeEntry.path !== 'string' || !record.knowledgeEntry.path || typeof record.knowledgeEntry.title !== 'string') throw new Error('新建记录损坏，不能重试');
    return record;
  }
  function create({ operationId, path: target, content, attachments = [], confirmed }) {
    if (confirmed !== true) throw new Error('创建笔记前必须明确确认');
    if (!validId(operationId) || typeof target !== 'string' || !target || typeof content !== 'string' || !Array.isArray(attachments) || attachments.some((item) => typeof item !== 'string')) throw new Error('新建参数无效');
    const adapter = knowledgeStore();
    adapter.prepare({ path: target, content, attachments });
    const currentVault = vaultId();
    const generation = crypto.randomBytes(16).toString('hex');
    const knowledgeEntry = { vaultId: currentVault, path: target, title: path.posix.basename(target).slice(0, 500), operationId, kind: 'direct', contentDigest: hash(content) };
    const preparing = { operationId, generation, knowledgeEntry, contentDigest: hash(content), attachmentsDigest: hash(JSON.stringify(attachments)), status: 'preparing' };
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = fileFor(operationId);
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('此操作已有记录，请先核查，不能重复写入'); throw error; }
    try { fs.writeFileSync(fd, JSON.stringify(preparing)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncRoot();
    store.transaction((state) => { if (vaultId() !== currentVault) throw new Error('当前知识库已变化'); store.reserveKnowledgeEntry(state, knowledgeEntry, generation); });
    return store.transaction((state) => {
      const current = read(operationId);
      if (!current || current.status !== 'preparing' || current.generation !== generation || vaultId() !== currentVault || !store.hasKnowledgeReservation(state, knowledgeEntry, generation)) throw new Error('新建预留已变化，请重新核查');
      try { adapter.prepare({ path: target, content, attachments }); }
      catch { store.releaseKnowledgeReservation(state, knowledgeEntry, generation); replace(file, { ...preparing, status: 'not_written' }); return { operationId, status: 'not_written' }; }
      const submitting = { ...preparing, status: 'submitting' };
      replace(file, submitting);
      let result;
      try { result = adapter.create({ path: target, content, attachments, confirmed: true }); }
      catch (error) {
        const status = error.code === 'EEXIST' ? 'target_exists' : 'unknown';
        try { replace(file, { ...submitting, status }); } catch { return { operationId, status: 'unknown' }; }
        if (status === 'target_exists') store.releaseKnowledgeReservation(state, knowledgeEntry, generation);
        return { operationId, status };
      }
      try {
        if (!result || result.path !== target || result.revision !== submitting.contentDigest) throw new Error('新建结果与确认内容不一致');
        replace(file, { ...submitting, status: 'completed', revision: result.revision });
        store.completeKnowledgeReservation(state, knowledgeEntry, generation);
        return { operationId, status: 'completed', path: result.path, revision: result.revision };
      } catch { return { operationId, status: 'unknown' }; }
    });
  }
  function inspect(operationId) {
    const record = read(operationId);
    if (!record) return null;
    if (vaultId() !== record.knowledgeEntry.vaultId) throw new Error('当前知识库与操作记录不一致');
    const reservation = store.hasKnowledgeReservation(store.list(), record.knowledgeEntry, record.generation);
    return { operationId, generation: record.generation, path: record.knowledgeEntry.path, status: record.status, reserved: reservation, ...(record.status === 'completed' ? { revision: record.revision } : {}) };
  }
  function recover({ operationId, confirmed }) {
    if (confirmed !== true) throw new Error('恢复前必须明确确认');
    return store.transaction((state) => {
      const record = read(operationId);
      if (!record || vaultId() !== record.knowledgeEntry.vaultId) throw new Error('记录不存在或知识库已变化');
      if (!store.hasKnowledgeReservation(state, record.knowledgeEntry, record.generation)) return { operationId, status: record.status, recovered: false };
      if (record.status === 'completed') { store.completeKnowledgeReservation(state, record.knowledgeEntry, record.generation); return { operationId, status: 'completed', recovered: true }; }
      if (['preparing', 'not_written', 'target_exists'].includes(record.status)) { store.releaseKnowledgeReservation(state, record.knowledgeEntry, record.generation); return { operationId, status: 'not_written', recovered: true }; }
      throw new Error('写入结果未知，不能自动恢复或重复写入');
    });
  }
  function resolve({ operationId, generation, decision, acceptUncertain, confirmed }) {
    if (!validId(operationId) || typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation) || !['link', 'discard'].includes(decision) || acceptUncertain !== true || confirmed !== true) throw new Error('须明确选择处置方式并确认写入来源未知');
    return store.transaction((state) => {
      const record = read(operationId);
      if (!record || record.generation !== generation || !['submitting', 'unknown'].includes(record.status) || vaultId() !== record.knowledgeEntry.vaultId || !store.hasKnowledgeReservation(state, record.knowledgeEntry, generation)) throw new Error('结果未知的预留不存在或已变化');
      if (decision === 'link') {
        const note = knowledgeStore().read(record.knowledgeEntry.path);
        if (hash(note.content) !== record.contentDigest || vaultId() !== record.knowledgeEntry.vaultId) throw new Error('当前笔记内容或知识库已变化，不能关联');
      }
      replace(fileFor(operationId), { ...record, status: 'unknown', manualDisposition: { type: decision, at: new Date().toISOString() } });
      store.resolveKnowledgeReservation(state, record.knowledgeEntry, generation, decision);
      return { operationId, resolved: true, writeStatus: 'unknown', decision };
    });
  }
  function inspectResolution({ operationId, generation }) {
    if (!validId(operationId) || typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)) throw new Error('处置标识无效');
    const state = store.list();
    const reservation = state.knowledgeReservations.find((item) => item.operationId === operationId && item.generation === generation && item.kind === 'direct');
    const resolution = state.knowledgeResolutions.find((item) => item.operationId === operationId && item.generation === generation && item.kind === 'direct');
    const context = reservation || resolution;
    if (!context || vaultId() !== context.vaultId) throw new Error('处置记录不存在或不属于当前知识库');
    if (reservation) {
      const record = read(operationId);
      if (!record || !['submitting', 'unknown'].includes(record.status) || record.generation !== generation || !store.hasKnowledgeReservation(state, record.knowledgeEntry, generation)) throw new Error('当前记录不是结果未知的处置待办');
    }
    return { operationId, status: reservation ? 'pending' : 'resolved', writeStatus: 'unknown', path: context.path, ...(resolution ? { decision: resolution.decision } : {}) };
  }
  function list() {
    let names;
    try { names = fs.readdirSync(root); } catch (error) { if (error.code === 'ENOENT') return { items: [], warnings: [] }; throw error; }
    const items = []; const warnings = []; const current = vaultId();
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try { const record = read(name.slice(0, -5)); if (record && record.knowledgeEntry.vaultId === current) items.push(inspect(record.operationId)); }
      catch { warnings.push({ reason: '存在无法确定知识库的损坏记录' }); }
    }
    return { items, warnings };
  }
  return { create, inspect, recover, resolve, inspectResolution, list };
}

module.exports = { createDirectKnowledgeCreator };
