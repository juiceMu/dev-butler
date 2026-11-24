# Obsidian attempt 只读核验合同

客户端：`createObsidianBridgeClient(...).inspect({ attemptId, notePath, expectedDigest, contentDigest })`。

- `expectedDigest` 是冻结原文摘要，`contentDigest` 是冻结待写正文摘要，均为 UTF-8 SHA-256 hex。
- 无需 confirmed，不发送正文，不调用 update 重放，不触发 vault.process。
- 只读端点为 POST `/v1/inspect-attempt`，body 附当前 vaultId；与 update 使用相同本机认证及 vault 事务锁。
- 返回 `{ status, drained }`。仅完整 vault/path/attempt/before/after 绑定匹配，且远端终态为 `completed`、`target_mismatch`、`resolved_unknown`，才返回 `drained:true`。
- `busy` 代表另一 vault 事务正在执行；`unknown`、`not_found`、`conflict`、`invalid`、`unavailable` 均返回 `drained:false`，不得据此解冻。
- 本地恢复必须同时核对远端 `drained:true` 和目标正文与冻结 after 摘要一致。正文一致本身不证明远端已结束。
- 终态压入 Bloom 后不再有完整绑定，inspect 返回 not_found，仍保守不允许自动恢复。

此合同仍需真实 Obsidian 桌面验收；模拟测试不替代真实 vault.process 行为验证。

2026-11-11 定向验证：`node --test test/obsidian-bridge-client.test.cjs` 22/22 通过；包括真实子进程持有事务锁时 update/维护/inspect 均 busy，远端在途写入时 inspect drained=false，终态完整绑定匹配时才 drained=true。
