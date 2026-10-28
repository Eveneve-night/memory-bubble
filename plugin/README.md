# 忆泡 · DSH 插件（dsh-memory-bubble）v0.3.2

把 AI 与你的日常对话，沉淀成一张可管理、可继承的暖色记忆泡泡图。
宿主半负责「抽取 / 存储 / 简报 / 注入」，客户端半负责「可视化 / 编辑 / 托盘」。
v0.2 起新增**跨 AI 互操作层**（MCP / CLI / HTTP / 记忆包），代码在仓库根目录 `interop/`。
v0.2.2 起记忆**按会话归属**：新装是空的、只积攒本会话、默认不读对话。
v0.3.0 起改为**浮窗**：默认关闭、点左侧栏「忆泡」才打开，窗口可拖动/缩放、窗口内可关闭；不再占用中央主面板。
v0.3.1 修复工具 schema：5 个工具统一为标准 JSON Schema（顶层 `type: 'object'`），修掉模型侧 `parameters` 校验报错。
v0.3.2 起窗口支持**八方向缩放**（四边+四角），图形随窗口比例自适应；底部托盘缩成局部浮层，窄窗自动两行排版。

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
   └─ test-plugin.mjs      宿主 + 客户端集成测试：伪造 ctx/webServer/ModuleLoader，跑完整 HTTP 与浮窗流程
```

## 用户能用到的东西

| 位置 | 组件 | 作用 |
| --- | --- | --- |
| 左侧栏 | 「忆泡」图标（`sidebar.panellist`） | 打开/关闭记忆浮窗；排在已装插件之后（order 900），不改动别人的入口 |
| 浮窗 | 泡泡图（`shell.overlay`） | 暖色泡泡、三档语义缩放、点泡看详情、改重要性滑杆、编辑/删除、冲突连线、搜索、撤销上一批、导出/导入；默认**关闭**，拖动标题栏移动、拖**四边/四角**缩放、右上角关闭 |
| 设置页 | 「忆泡」分区（`settings.section`） | **读取对话并自动生成** 总开关、每轮最多生成条数、记忆总量上限、去抖/最小间隔、注入方式、导出/导入 |
| 对话注入 | `systemPrompt.section` + `agent/pre-step` 兜底 | 每轮把稳定简报注入上下文；深度模式可写在 system prompt 里提高缓存命中 |
| 工具 | `memory_search` / `memory_brief` / `memory_remember` / `memory_link` / `memory_forget` | 让 AI 自己查记忆、主动记一条、连线、删除 |

「＋ 手动记一条」会先在浮窗里长出一个新泡泡，并弹出小编辑窗填写**内容、时间、关键词、类型、重要性**；保存后即成为一条手动记忆（不经过 AI，也不受自动生成开关影响）。

交互要点：滚轮缩放（三档信息层级）、拖动平移、双击自适应、点泡泡看卡片、Shift+点泡泡放进本轮托盘（「注入本对话」）、点连线看关系并「重新校验冲突」、Esc 关闭卡片；鼠标移到窗口四条边/四个角可拖动改变窗口大小，泡泡图会按新比例自动适配；浮窗的位置/大小/开关状态记在 `localStorage('memory-bubble.window.v1')`，每个会话独立记住是否关闭。

## 数据与隐私

- 全部本地：`<profile>/.memory-bubble/state.json`（自动写 `.bak`，导出在 `exports/`）。
- 每条记忆记录来源会话（`sessions`）与证据（`evidence`，截取的用户原话）；注入只取**当前会话**的记忆。
- 不联网、不遥测；只在本机调用用户配置的默认模型做「总结」（`llm.stream`）。
- 抽取时只发送最近窗口的对话（`maxTranscriptChars`，默认 6000 字符），不发送整段历史。

## 全新安装：从零开始 + 不开局幻觉

| 需求 | 落法 |
| --- | --- |
| 一装就是空的 | 首次安装没有 `state.json`；浮窗显示三步引导；不预置任何示例记忆 |
| 一装就是关的 | 浮窗默认关闭（`localStorage` 无记录即 `open:false`），只有用户点侧栏图标才打开；每个会话独立记住开/关 |
| 只记本会话 | 每条记忆带 `sessions`；`scope=session` 只看本会话；摘要/注入只用当前会话的记忆 |
| 默认不偷看对话 | `auto` 默认 **关**；只有用户点「开启读取对话」后才在 `turn/end` 去抖抽取 |
| 没有依据不瞎编 | 抽取前必须有本会话的真实用户原话；`isMetaText` 过滤运行时上下文/技能清单/系统提醒/忆泡简报；模型返回空或无效则记 `no-evidence`，不写图谱 |
| 能看见依据 | 每条记忆带 `evidence`，卡片显示「依据：…」；可清空本会话（`/session/forget`） |

> 首次安装后，如果设置页开关还没打开，浮窗顶部会常驻「自动读取已关闭」提示和一键开启按钮，不会静默生成。

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
POST /memory-bubble/api/session/forget    { sessionId }             // 只清本会话的记忆
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

## 自动生成怎么控制（设置页「忆泡」分区）

| 设置项 | 字段 | 默认 | 说明 |
|---|---|---|---|
| 读取对话并自动生成记忆 | `auto` | 开 | 总开关；关闭后不再自动读取/抽取（手动「立即总结」仍可用） |
| 每轮最多生成 | `maxPerExtraction` | 3 | 1–5，本轮新建记忆点上限（更新已有记忆不受限） |
| 记忆总量上限 | `maxTotalNodes` | 300 | 20–2000，达到后只更新不再新建 |
| 总结去抖 | `debounceMs` | 15000 | 回合结束后等多久再总结 |
| 同会话最小间隔 | `minIntervalMs` | 90000 | 避免连续回合重复抽取 |
| 抽取窗口 | `maxTranscriptChars` | 6000 | 发给模型的最近对话字符数 |
| 注入方式 | `injection` | `digest` | `digest` 简报 / `tray` 托盘 / `off` 不注入 |
| 摘要条数 | `digestLimit` | 12 | 简报最多列几条 |

- 手动入口只有「＋ 手动记一条」和「立即总结」：前者只写一条（可编辑/删除），后者是显式触发一次自动抽取。
- 每个会话可在托盘里单独勾选「自动读取对话」，优先级高于全局开关。

## 自动总结的时序

1. `session/event` 折叠本会话的 `user/message`（只认 `source.kind === 'user'`，跳过运行时上下文/技能/忆泡简报自身）与 `assistant/message`。
2. `turn/end` 触发去抖（默认 15s，同一会话至少间隔 90s），`ctx.effect` 管理定时器。
3. 调 `llm.stream`（默认模型 + 最近对话 + 「已有记忆标题」避免重复），解析 JSON 抽取结果；提示词里明确「本轮最多 N 条」。
4. 合并进图谱：近似标题/关键词判重、追加时效、更新频率；**每轮新建数量受 `maxPerExtraction` 限制（默认 3，可调 1–5），总量受 `maxTotalNodes` 限制（默认 300）**，超出部分记入 `batch.skipped`；整批写入可撤销（`rollback`）。
5. 重算布局与稳定简报；客户端下一次打开/轮询即看到新泡泡。

## 装进 DSH

**方式 A（推荐）：让 DSH 自己装本地包。** 在 Web GUI 里对 agent 说：

```text
用 plugin_manager 的 install_bundle 安装 "D:\Deepseek Harness\memory-bubble\plugin"
```

插件管理器接受绝对路径 / `file:` / `link:` / git 地址 / `.tgz`，会把它写进 profile 依赖并激活 bundle；发布页也提供 `dsh-memory-bubble-v0.3.2.tgz`，可直接 `install_bundle` 该文件的绝对路径或下载 URL。安装完成后刷新页面，左侧栏出现「忆泡」；点它打开浮窗。

**方式 B：手工。** 把 `plugin/` 复制或软链到 `<profile>/node_modules/dsh-memory-bubble`，在 profile 的 `dsh.profile.bundles` 里加 `dsh-memory-bubble`，刷新页面。

> 安装类操作需要 DSH 的审批权限。安装后请先看三件事：左侧栏出现「忆泡」、点开浮窗是「从零开始」引导且默认不读对话、设置页有「忆泡」分区。

## 自测

```
cd plugin
node dev/test-core.mjs       # 13 项：合并/去重/布局/简报/撤销/导入导出/解析健壮性/上限/按会话/手动时间
node dev/test-plugin.mjs     # 14 项：apply 注册与路由、零起点、防幻觉、抽取、会话隔离、手动新增时间、清空、工具 schema、注入、导入导出、客户端三 slot、浮窗默认关闭/关闭按钮
node dev/test-client.mjs     # 14 项：真实 React 渲染的浮窗、八方向缩放手柄存在、顶栏/托盘结构、拖拽缩放后按比例自适应
node --check lib/client.js   # 客户端单文件语法
node --check lib/index.js    # 宿主半语法
```

互操作层单独测（仓库根目录）：`node interop/dev/test-interop.mjs`（5 项：CLI / bundle schema / MCP 全套）。

当前结果：core 13/13、plugin（宿主+客户端）14/14、client 14/14、interop 5/5、`node --check` 四文件通过。

## 上次「失控」的排查结论（v0.3.0）

现象：v0.2.2 装上并启用后，用户觉得忆泡"接管了界面、关不掉、把其他插件挤乱了"。

可查到的证据（`<profile>/.memory-bubble/state.json`、pnpm 日志、loader 注册表）：

- 图谱是空的（0 节点 0 边、`auto:false`、抽取 0 次），**不是记忆内容或 LLM 循环导致的卡死**。
- 客户端只注册了 `main`（keyed 面板）、`sidebar.panellist`、`conversation.input.left` 药丸、`settings.section` 四处；`main` 面板没有内建关闭按钮，打开后只能靠侧栏切回会话——这是"被接管"的直接来源。
- `dsh.client.immediately: true` 让它随首屏立即加载；面板内 6s、药丸 12s 各有一个轻量 fetch 轮询。
- 侧栏条目 `order: 22`，排在其他插件入口中间，可能改变已有入口的视觉顺序。
- 同一时段的 pnpm 日志里唯一报错是 `@anionex/dsh-turn-rewind@0.3.10` 与 DSH 0.2.1-rc.3 不兼容，与忆泡无关。

v0.3.0 的修法：不再注册 `main` 和输入框药丸 → 改为**默认关闭、可拖动可缩放、窗口内可关闭**的浮层（`shell.overlay`），侧栏入口 `order: 900` 排到最后，每个会话独立记住窗口开关。

## 已知未验证点（真机待确认）

- 真实 DSH 里 `llm.stream` 的调用形状与失败表现（代码已兼容 `finish` 块报错、provider 缺失回退到 `llm.listProviders()`）。
- `agent.ctx.systemPrompt.section` 是否在运行时可见（已做特性探测，失败则只走 `agent/pre-step` 追加注入）。
- 深色模式目前用 `html[data-mb-theme]` + `prefers-color-scheme` 双兜底，接入 DSH 主题服务后可视需要切换为 `--dsw-alias-*`。
- 安装路径已按 DSH 插件管理器的真实 spec 形式写好（路径 / `file:` / `link:` / git / `.tgz`），但真实安装动作需在审批可用的会话里执行。
- MCP 客户端（Claude Desktop / Cursor）的真实握手只做过协议级自测（`interop/dev/test-interop.mjs`），未在具体客户端里跑过。
