# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

首期供项目发起人本人在当前电脑上使用，围绕有权限访问的 Choerodon 工作项开展 Codex 开发并维护语雀知识。

## Product Purpose

建立工作项、Codex 会话与语雀记录之间可追溯的联系，支持从工作项反查相关开发与知识，并结合代码和来源解释历史原因。

## Operating Context

通过 Codex 官方插件和本地 MCP Apps 进入管理页面；实际开发仍在 Codex 会话中进行。首期验收以 ACCEPTANCE.md 为基线，用户已确认。

## Capabilities and Constraints

Choerodon 首期只读；语雀写入须经用户逐次确认。关联由用户明确指定，不批量扫描历史会话。不修改 Codex 应用本体；凭据不写入普通索引或备份。未验证的远程能力不得显示为可用。

## Brand Commitments

管理界面沿用 Codex 简洁、以操作为中心的风格。

## Evidence on Hand

原始方案见上级目录的 Codex-Choerodon-语雀联动方案.md；项目实现现状和限制见 README.md 与 ARCHITECTURE.md。

## Product Principles

- 来源和能力状态清晰，不将失败伪装为空结果。
- 保留用户对关联、写入和导入冲突的控制。
- 草稿与关联在失败时可恢复，避免静默覆盖。
