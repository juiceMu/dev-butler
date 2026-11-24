const crypto = require('node:crypto');
const { Plugin, TFile, Notice } = require('obsidian');
const { createBridge, PLUGIN_ID } = require('./bridge.cjs');
const SETTINGS_QUEUES = globalThis[Symbol.for('x-assistant-bridge.settings-queues')] || (globalThis[Symbol.for('x-assistant-bridge.settings-queues')] = new Map());

module.exports = class XAssistantBridgePlugin extends Plugin {
  async onload() {
    const settingsKey = this.app.vault.adapter.getBasePath();
    const mutateSettings = (mutate) => {
      const operation = (SETTINGS_QUEUES.get(settingsKey) || Promise.resolve()).then(async () => {
        const settings = await this.loadData() || {};
        const updated = await mutate(settings);
        await this.saveData(updated);
        return updated;
      });
      this.settingsQueue = operation.catch(() => {});
      SETTINGS_QUEUES.set(settingsKey, this.settingsQueue);
      return operation;
    };
    const token = crypto.randomBytes(32).toString('hex');
    this.bridge = createBridge({
      app: this.app,
      TFile,
      token,
      configDir: this.app.vault.configDir || '.obsidian',
      readAttempts: async () => (await this.loadData())?.bridgeAttempts || [],
      writeAttempt: async (attemptId, record) => {
        await mutateSettings((current) => {
          const records = Array.isArray(current.bridgeAttempts) ? current.bridgeAttempts : [];
          const index = records.findIndex((item) => item.attemptId === attemptId);
          if (index < 0) records.push(record); else records[index] = record;
          return { ...current, bridgeToken: token, bridgeAttempts: records };
        });
      },
      readReplayFilter: async () => {
        const current = await this.loadData() || {};
        return current.bridgeReplayFilter || { bits: '', count: 0 };
      },
      compactAttempts: async ({ attempts, replayFilter }) => {
        await mutateSettings((current) => ({ ...current, bridgeToken: token, bridgeAttempts: attempts, bridgeReplayFilter: replayFilter }));
      },
    });
    try {
      const endpoint = await this.bridge.start();
      const adapter = this.app.vault.adapter;
      try { await adapter.mkdir(endpoint.pluginPath); } catch {}
      await adapter.write(`${endpoint.pluginPath}/bridge.json`, JSON.stringify(endpoint));
      this.endpoint = endpoint;
      this.addStatusBarItem().setText('开发管家桥已连接');
      this.addCommand({
        id: 'resolve-unknown-updates',
        name: '人工确认并解除不确定更新锁',
        callback: async () => {
          const confirmed = window.confirm('仅在你已逐一检查相关笔记内容后继续。此操作会解除 unknown 更新锁，但不会重放写入。确认继续？');
          const result = await this.bridge.resolveUnknownAttempts({ confirmed });
          new Notice(result.status === 'completed' ? `已解除 ${result.count} 条不确定更新锁` : '桥接仍有进行中的更新，未执行恢复');
        },
      });
      this.addCommand({
        id: 'clear-completed-update-history',
        name: '清理已完成更新尝试记录',
        callback: async () => {
          const confirmed = window.confirm('仅当你确认上游不会再重放旧 attemptId 时清理。清理后尝试记录会从头计数，笔记摘要校验仍会阻止覆盖已变化内容。确认清理？');
          const result = await this.bridge.resetCompletedHistory({ confirmed });
          new Notice(result.status === 'completed' ? '已清理终态更新记录' : '存在不确定记录或进行中的更新，未清理');
        },
      });
    } catch {
      if (this.bridge) await this.bridge.close();
      this.addStatusBarItem().setText('开发管家桥不可用');
    }
  }

  onunload() {
    this.closing = (async () => {
      if (this.bridge) await this.bridge.close();
      if (this.endpoint) await this.app.vault.adapter.remove(`${this.endpoint.pluginPath}/bridge.json`).catch(() => {});
    })();
  }
};
