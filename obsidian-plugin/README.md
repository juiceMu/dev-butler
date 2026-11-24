# 开发管家 Obsidian 安全更新桥原型

这是 `Vault.process` 安全更新桥。项目服务的已有笔记更新流程会调用它；真实 Obsidian 桌面写入仍需单独验收。

插件仅面向 Obsidian 桌面版。原型测试通过后，手动安装方式为：将本目录中的 `manifest.json`、`main.js` 和 `bridge.cjs` 一起放入知识库的 `.obsidian/plugins/x-assistant-bridge/`，在 Obsidian 的“设置 → 第三方插件”中重新加载并启用。启用后，状态栏应显示桥接状态；桥接元数据位于同一插件目录的 `bridge.json`。

端点仅绑定 `127.0.0.1`，要求随机 bearer token、精确 Host、无 Origin，并只接受带 vault 标识、正文摘要和唯一尝试 ID 的更新请求。客户端与服务端共用 608192 字节的序列化请求上限；服务端限制请求头 5 秒、请求体空闲 5 秒、总请求 15 秒，并最多接收 8 个待处理请求。过载明确返回 `busy`，超限请求会按 413 拒绝，未开始执行的 unavailable/busy 不会被客户端标成 unknown。

插件只通过 `vault.process` 在写入回调内比较原文摘要；错误目标、过期摘要和同 ID 不同请求不会覆盖。请求正文不会存入插件的尝试记录。每个目标在 vault 的插件配置目录有一个排他锁文件，实例卸载会先停止接收并等待已接收操作结束；崩溃/结果不确定的锁默认保留，避免另一实例或新 attempt 覆盖。

所有请求从读取 attempts/filter 到结果保存都持有同一 vault 的 `vault-transaction.lock` 排他文件锁；启动恢复、历史压缩、unknown 人工恢复和只读 inspect 也使用该锁。其他实例或进程持锁时立即返回 busy，不等待或重试；每个 vault 同时只执行一个事务，接收中的请求体最多 8 个。插件 settings 的 load-modify-save 另有进程内队列保护。每次加载生成新内存 token，启动不额外保存 settings，避免越过事务覆盖记录。

只读核验通过 `client.inspect({attemptId,notePath,expectedDigest,contentDigest})`，不重放 update、不发送正文、不触发写入。完整绑定匹配并核实终态才返回 `drained:true`；执行中或不可核实均为 false。恢复合同详见 [桥接核验合同](../docs/verification/obsidian-attempt-inspect-contract.md)。

启动会回收终态对应的锁及已退出进程且没有 attempt 记录的孤儿锁；unknown 锁保留人工恢复。事务锁内容损坏、恢复锁异常或无法证明持有进程已退出时保守拒绝服务，需要人工核查后恢复，不能自动删锁继续。

尝试明细上限为 10000 条。Obsidian 命令“清理已完成更新尝试记录”会把终态 attemptId 压入固定 512 KiB Bloom replay filter 后再清空明细；旧 ID 因此不会重新执行，极少数 Bloom 假阳性会保守拒绝为冲突。该 filter 可封存最多 100000 个旧 ID，达到此明确总容量后停止新写入，不会静默丢弃幂等信息。若有 unknown，先人工检查笔记，再用命令“人工确认并解除不确定更新锁”；命令本身不重放写入。容量耗尽后的安全迁移流程尚未实现，不得直接清空 replay filter。

插件未运行或明确未执行的忙碌/不可用状态可安全重新发起；请求已连接但无确定响应时是 unknown，禁止自动重试或回退到文件系统覆盖。当前测试使用模拟 Obsidian API，不证明实际桌面插件加载、HTTP 端点或真实知识库写入行为；真实桌面写入仍需验收，未验证前不要将其用于业务数据。
