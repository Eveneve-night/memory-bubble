# 忆泡 · DSH 插件（dsh-memory-bubble）v0.2

把 AI 与你的日常对话，沉淀成一张可管理、可继承的暖色记忆泡泡图。
宿主半负责「抽取 / 存储 / 简报 / 注入」，客户端半负责「可视化 / 编辑 / 托盘」。
v0.2 起新增**跨 AI 互操作层**（MCP / CLI / HTTP / 记忆包），代码在仓库根目录 `interop/`。

## 目录

```
plugin/
├─ package.json            dsh.bundle.patch + dsh.client 声明
├─ cordis.patch.yml        loader 插入行（id: memory-bubble）
├─ lib/
│  ├─ index.js             宿主半：事件折叠、去抖总结、模型调用、简报、注入、路由、工具
│  ├─ core.js              纯逻辑：抽取合并、布局、简报、撤销、导入导出、提示词（零依赖，可单测）
│  ├─ store.js             状态持久化：<profile>/.memory-bubble/state.json（原子写 + .bak）
│  └─ client.js            客户端半：单文件、只依赖 react、无 JSX，经 __ModuleLoader__ 加载
└─ dev/
   ├─ test-core.mjs        纯逻辑测试（node dev/test-core.mjs）
   ├─ test-host.mjs        宿主集成测试：伪造 ctx + webServer，跑完整 HTTP 流程
   └─ test-client.mjs      客户端冒烟测试：伪造 ModuleLoader/react/document/fetch
```

## 用户能用到的东西

| 位置 | 组件 | 作用 |
| --- | --- | --- |
| 左侧栏 | 「忆泡」图标（`sidebar.panellist`） | 打开整幅记忆图 |
| 主面板 | 泡泡图（`main`，key=`memory-bubble`） | 暖色泡泡、三档语义缩放、点泡看详情、改重要性滑杆、编辑/删除、冲突连线、搜索、撤销上一批、导出/导入 |
| 输入框左侧 | 「忆泡」药丸（`conversation.input.left`） | 当前会话记忆数，点开主面板 |
| 设置页 | 「忆泡」分区（`settings.section`） | 自动总结开关、去抖/最小间隔、注入方式、摘要条数、导出/导入 |
| 对话注入 | `systemPrompt.section` + `agent/pre-step` 兜底 | 每轮把稳定简报注入上下文；深度模式可写在 system prompt 里提高缓存命中 |
| 工具 | `memory_search` / `memory_brief` / `memory_remember` / `memory_link` / `memory_forget` | 让 AI 自己查记忆、主动记一条、连线、删除 |

交互要点：滚轮缩放（三档信息层级）、拖动平移、双击自适应、点泡泡看卡片、Shift+点泡泡放进本轮托盘（「注入本对话」）、点连线看关系并「重新校验冲突」、Esc 关闭卡片。

## 数据与隐私

- 全部本地：`<profile>/.memory-bubble/state.json`（自动写 `.bak`，导出在 `exports/`）。
- 不联网、不遥测；只在本机调用用户配置的默认模型做「总结」（`llm.stream`）。
- 抽取时只发送最近窗口的对话（`maxTranscriptChars`，默认 6000 字符），不发送整段历史。

## HTTP 路由（同源，客户端直接 fetch）

```
GET  /memory-bubble/api/health
GET  /memory-bubble/api/graph?sessionId=&scope=all|session
GET  /memory-bubble/api/config
POST /memory-bubble/api/config            { config | patch }
POST /memory-bubble/api/extract           { sessionId, force }     // 手动「总结这一轮」
POST /memory-bubble/api/rollback          { sessionId | batchId }  // 撤销上一批
POST /memory-bubble/api/node              { id, patch, sessionId }
POST /memory-bubble/api/node/create       { title, summary, keywords, importance, sessionId }
POST /memory-bubble/api/node/delete       { id, sessionId }
POST /memory-bubble/api/edge              { id, patch }
POST /memory-bubble/api/edge/delete       { id }
POST /memory-bubble/api/tray              { sessionId, add|remove|nodeId|clear }
POST /memory-bubble/api/session           { sessionId, enabled }
POST /memory-bubble/api/export
POST /memory-bubble/api/import            { graph }
GET  /memory-bubble/api/batch?sessionId=
GET  /memory-bubble/api/interop           // 跨 AI 能力清单（数据路径/工具/提示词/通道）
GET  /memory-bubble/api/ai/bundle?sessionId=  // memory-bubble-bundle（图+简报+提示词+工具）
GET  /memory-bubble/api/ai/prompt         // 便携提示词纯文本
```

## 跨 AI 互操作（v0.2）

同一份 `state.json` 可被四种通道读取，详见根目录 [INTEROP.md](../INTEROP.md)：

| 通道 | 入口 | 适合谁 |
| --- | --- | --- |
| MCP | `interop/mcp-server.mjs`（stdio） | Claude Desktop / Cursor / 其他 MCP 客户端 |
| CLI | `interop/cli.mjs list/search/brief/export/bundle/import/remember/forget` | 脚本、其他 AI 的 shell 工具 |
| HTTP | `/memory-bubble/api/interop`、`/ai/bundle`、`/ai/prompt` | 本机其他进程、局域网工具 |
| 记忆包 | `bundle.json`（`memory-bubble-bundle v1`） | 换 AI / 换机器 / 换对话的继承 |

- 便携提示词 `PORTABLE_PROMPT`：把「忆泡规则」贴进任何 AI 的 system prompt 即可用。
- 工具清单 `TOOL_MANIFEST`：5 个工具的 JSON-Schema，可直接转成 function calling / MCP 工具。
- 记忆包 schema：`schema/memory-bubble-bundle-v1.schema.json`（图沿用 `memory-bubble/v1`）。

## 自动总结的时序

1. `session/event` 折叠本会话的 `user/message`（只认 `source.kind === 'user'`，跳过运行时上下文/技能/忆泡简报自身）与 `assistant/message`。
2. `turn/end` 触发去抖（默认 15s，同一会话至少间隔 90s），`ctx.effect` 管理定时器。
3. 调 `llm.stream`（默认模型 + 最近对话 + 「已有记忆标题」避免重复），解析 JSON 抽取结果。
4. 合并进图谱：近似标题/关键词判重、追加时效、更新频率；整批写入可撤销（`rollback`）。
5. 重算布局与稳定简报；客户端下一次打开/轮询即看到新泡泡。

## 装进 DSH（后续单独对话验证）

三条路，任选其一：

1. **本地 file: 安装（推荐先试）**：在 profile 下执行 `pnpm add "file:<repo>/plugin"`，然后在 `cordis.yml` 的 loader 里加一行 `memory-bubble`（或让 `plugin_manager` 安装），刷新 Web GUI。
2. **复制进 node_modules**：把 `plugin/` 复制为 `<profile>/node_modules/dsh-memory-bubble`，在 `cordis.yml` 的 loader 列表插入 `{ id: memory-bubble, name: dsh-memory-bubble }`，刷新页面。
3. **发布 npm 后**用 `plugin_manager install_bundle` 正式安装（bundle 自带 `cordis.patch.yml`，无需手改 loader）。

> 本会话审批策略为 `never`，安装类操作会被自动拒绝，所以只在本地完成了代码与自测；安装与真机验证放到下一个对话。

## 自测

```
cd plugin
node dev/test-core.mjs     # 12 项：合并/去重/布局/简报/撤销/导入导出/解析健壮性
node dev/test-host.mjs     # 13 项：apply 注册、事件折叠、去抖、总结、编辑、托盘、工具、注入、持久化、互操作
node dev/test-client.mjs   # 客户端模块加载、四个 slot、渲染冒烟
node --check lib/client.js # 客户端单文件语法
```

互操作层单独测（仓库根目录）：`node interop/dev/test-interop.mjs`（5 项：CLI / bundle schema / MCP 全套）。

当前结果：core 12/12、host 13/13、client 3/3、interop 5/5、`node --check` 通过。

## 已知未验证点（真机待确认）

- 真实 DSH 里 `llm.stream` 的调用形状与失败表现（代码已兼容 `finish` 块报错、provider 缺失回退到 `llm.listProviders()`）。
- `agent.ctx.systemPrompt.section` 是否在运行时可见（已做特性探测，失败则只走 `agent/pre-step` 追加注入）。
- 深色模式目前用 `html[data-mb-theme]` + `prefers-color-scheme` 双兜底，接入 DSH 主题服务后可视需要切换为 `--dsw-alias-*`。
- 安装路径三选一需在真机确认，`file:` spec 是否被 `plugin_manager` 接受尚未实测。
- MCP 客户端（Claude Desktop / Cursor）的真实握手只做过协议级自测（`interop/dev/test-interop.mjs`），未在具体客户端里跑过。
