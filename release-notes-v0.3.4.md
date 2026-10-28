# 忆泡 v0.3.4 — 互操作层 remember 修复

## 修复

- **CLI / MCP 写入记忆不落库**：v0.2.2 加入「自动抽取必须有用户原话依据」的防幻觉守卫后，`interop/lib.mjs` 的 `remember()` 没有标记 `manual`，导致 `node interop/cli.mjs remember ...` 返回 `{ok:true, id:null}` 而实际没写入。现在外部 AI / CLI / MCP 的写入一律按「用户明确要求记下」处理，正常落库。
- `remember` 新增可选 `evidence`（依据原话），MCP 的 `memory_remember` 也可传，便于其他 AI 留下出处。

## 自测（在全新 clone 的仓库里跑）

- core 13/13、plugin（宿主+客户端）14/14、interop 5/5（CLI remember/list/search/brief/export/bundle/import、bundle schema、MCP initialize/tools/list/tools/call/resources/read）
- 用 `plugin_manager` 从下载后的 `plugin/` 目录安装成功（`link:` 到该目录），loader 条目 `memory-bubble` 已启用
- 安装后接口自检：`GET /memory-bubble/api/health` → 200，`firstRun:true`、`auto:false`、`totalNodes:0`（从零开始、默认不读对话）；`GET /memory-bubble/api/graph` → 200、0 节点 0 连线

## 安装

- 插件包：`dsh-memory-bubble-v0.3.4.zip` 或 [`dsh-memory-bubble-0.3.4.tgz`](https://github.com/Eveneve-night/memory-bubble/releases/download/v0.3.4/dsh-memory-bubble-0.3.4.tgz)
- 用 DSH 的 `plugin_manager` → `install_bundle` 指向解压后的 `plugin/` 目录或 `.tgz` 绝对路径；装完刷新页面，左侧栏出现「忆泡」
