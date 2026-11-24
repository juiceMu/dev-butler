const crypto = require('node:crypto');

function createPendingNoteLinks({ store, knowledgeStore, currentVaultId, reconcilePublications }) {
  function list() {
    const warnings = reconcilePublications ? reconcilePublications() : [];
    const vaultId = currentVaultId();
    return { items: store.list().pendingNoteLinks.filter((entry) => entry.vaultId === vaultId), warnings };
  }

  function link({ id, confirmed }) {
    if (confirmed !== true) throw new Error('关联前必须明确确认');
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('待关联记录标识无效');
    const entry = list().items.find((item) => item.id === id);
    if (!entry) throw new Error('当前知识库没有匹配的待关联记录');
    const note = knowledgeStore().read(entry.target);
    if (currentVaultId() !== entry.vaultId || typeof note.content !== 'string' || crypto.createHash('sha256').update(note.content, 'utf8').digest('hex') !== entry.contentDigest) throw new Error('目标笔记或知识库已变化，请重新核对');
    return store.completePendingNoteLink(id);
  }

  return { list, link };
}

module.exports = { createPendingNoteLinks };
