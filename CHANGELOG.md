# 更新日志

## v0.2.0 — 2026-10-27

**主题：跨 AI 互操作（保留接口，让其他 AI 也能下载并使用）**

### 新增

- **MCP stdio 服务器** `interop/mcp-server.mjs`
  - 工具：`memory_search` / `memory_brief` / `memory_remember` / `memory_link` / `memory_forget`
  - 资源：`memory://graph`、`memory://digest`、`memory://prompt`
  - 提示词：`memory-bubble-usage`
  - `initialize.instructions` 自带跨 AI 使用说明；`--read-only` 可禁用写入
- **零依赖 CLI** `interop/cli.mjs`：`list / search / brief / export / import / bundle / remember / forget`，`--data` 可指向任意 `state.json`
- **HTTP 互操作路由**：`GET /memory-bubble/api/interop`、`/ai/bundle`、`/ai/prompt`
- **记忆包格式** `memory-bubble-bundle v1`（图 + 简报 + 便携提示词 + 工具清单），配套 `schema/memory-bubble-bundle-v1.schema.json`
- **便携提示词** `PORTABLE_PROMPT` 与**工具清单** `TOOL_MANIFEST`（`plugin/lib/core.js`，可被其他宿主复用）
- 文档：`INTEROP.md`（四条通道、客户端配置示例、安全边界）

### 变更

- 导出格式对齐 schema：`memory-bubble/v1` 信封（`{ schema, version, source, graph:{id,nodes,edges} }`）；导入兼容信封 / 扁平 / bundle 三种输入
- 插件版本 `0.1.0 → 0.2.0`；`/interop` 返回数据路径、工具清单、通道入口
- 自检：core 12/12、host 13/13、client 3/3、interop 5/5

### 修复

- 导入路由在收到 v1 信封时判定失败的问题
- CLI `brief` 在记忆刚写入、尚未生成会话简报时返回空的问题

## v0.1.0 — 2026-10-27

- 首发：DSH 插件（host + client）+ 离线可点原型 + 设计/可行性文档 + 记忆图 schema
- 宿主机能：会话折叠、去抖自动总结、稳定简报、`systemPrompt` / `agent/pre-step` 注入、5 个工具、撤销、持久化
- 客户端：左侧栏入口、主面板暖色泡泡图、三档语义缩放、详情卡、滑杆改重要性、冲突连线、搜索、托盘、导出/导入、深浅色
