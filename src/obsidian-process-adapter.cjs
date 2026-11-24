// 隔离原型：依赖可信调用方验证知识库身份，不提供跨进程条件写保证。
function createObsidianProcessAdapter({ vault, vaultId, currentVaultId, TFile }) {
  if (!vault || typeof vault.getAbstractFileByPath !== 'function' || typeof vault.process !== 'function' ||
      typeof vaultId !== 'string' || !/^[a-f0-9]{64}$/.test(vaultId) ||
      typeof currentVaultId !== 'function' || typeof TFile !== 'function') throw new Error('适配器配置无效');

  function checkVault(requestedVaultId) {
    if (requestedVaultId !== vaultId || currentVaultId() !== vaultId) throw new Error('知识库不匹配');
  }

  return async function processNote(requestedVaultId, notePath, transform) {
    checkVault(requestedVaultId);
    if (typeof notePath !== 'string' || !notePath.toLowerCase().endsWith('.md') || notePath.startsWith('/') ||
        notePath.includes('\\') || notePath.includes('\0') ||
        notePath.split('/').some((part) => !part || part === '.' || part === '..') || typeof transform !== 'function') {
      throw new Error('笔记路径或处理函数无效');
    }
    const file = vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile) || file.path !== notePath) throw new Error('笔记不存在或不是文件');
    let calls = 0;
    let output;
    let callbackFailed = false;
    const result = await vault.process(file, (current) => {
      try {
        if (++calls !== 1) throw new Error('处理回调重复调用');
        checkVault(requestedVaultId);
        if (typeof current !== 'string') throw new Error('笔记内容无效');
        output = transform(current);
        if (typeof output !== 'string') throw new Error('处理结果必须是字符串');
        return output;
      } catch (error) {
        callbackFailed = true;
        throw error;
      }
    });
    checkVault(requestedVaultId);
    if (callbackFailed || calls !== 1 || result !== output) throw new Error('笔记处理结果无法确认');
  };
}

module.exports = { createObsidianProcessAdapter };
