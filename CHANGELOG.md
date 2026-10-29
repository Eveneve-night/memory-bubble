# 更新日志

## v0.3.5 — 2026-10-29

**主题：外部软件在线桥接（bridge）**——MCP / CLI 不再直接改数据文件，而是调用运行中插件的同一套操作。

- 增加带令牌的本机桥接与发现文件，MCP/CLI 在线复用插件操作；离线读改写使用独占锁。
- 保留原接口和五个 MCP 工具，在线增加统一操作入口，支持外部对话总结、编辑、托盘、撤销与会话继承。
- 增加纯对话 `chat` 记忆包及显式导回，修正会话参数转发、旧简报缓存和共享记忆清理。
- MCP 版本跟随插件元数据，忽略通知；更新安装和桥接说明。
- 本轮不改标题栏、布局和冲突评分。需一起升级插件与适配器，旧发布包不含新桥接。

## v0.3.4 — 2026-10-28

**主题：修复互操作层 remember 被防幻觉守卫丢弃**

### 修复

- `interop/lib.mjs` 的 `remember()` 现在会带上 `manual: true`：外部 AI / CLI / MCP 的 `remember` 属于“用户明确要求记下”的手工写入，不再被自动抽取的「必须有用户原话依据」规则静默丢弃（v0.2.2 引入防幻觉守卫后 CLI/MCP 静默不落库的回归）
- `remember` 支持可选 `evidence` 字段，MCP `memory_remember` 也可传“依据原话”

### 测试

- interop 5/5（CLI remember / list / search / brief / export / bundle / import、bundle schema、MCP 全套）
- core 13/13、plugin 14/14

## v0.3.3 — 2026-10-28

**主题：侧栏图标可靠地打开/收起浮窗**

### 修复

- 关闭浮窗后点左侧栏「忆泡」图标没反应（或要点好几次）的问题：入口从只监听 `click` 改为**指针按下即切换**（`pointerdown`，主键，不受上层拖拽/焦点抢占影响），键盘 Enter/空格仍可操作
- 入口加上 `draggable:false`、`touch-action:manipulation`、`pointer-events:auto`、`z-index`，避免被相邻元素遮挡或参与拖拽
- 窗口内容挂载时监听自身尺寸变化（`ResizeObserver` + `transitionend`），拖拽改大小后图像一定会按比例重排

### 测试

- core 13/13、plugin 14/14、interop 5/5；新增「键盘 Enter 也能打开浮窗」断言

## v0.3.2 — 2026-10-28

**主题：八方向缩放 + 底栏精简 + 窄窗自适应排版**

### 变更

- 浮窗支持**八方向缩放**：鼠标移到窗口上/下/左/右四条边或四个角，光标变成对应方向的缩放箭头，拖动按比例调整窗口大小（最小 380×360）；窗口改大小后泡泡图按新视口自动重新适配，用户手动缩放/平移过则不再抢镜头
- 底部托盘缩小为画面局部的浮层：去掉整行提示条，只留「托盘 n」徽标 + 记忆 chips + `⋯` 菜单（清空/暂停本会话自动读取），不再横贯整个窗口
- 顶栏改为两行自适应排版：第一行品牌 + 会话选择 + 范围切换，第二行搜索 + 操作按钮；窄窗（≤620px）下自动隐藏副标题/图例/缩放提示、搜索独占一行，避免文字挤压重叠
- 增强对「记忆同步」事件的兜底：窗口尺寸变化时即使 `ResizeObserver` 不可用，也会按新比例重新适配

### 测试

- core 13/13、client 14/14、plugin 14/14；新增真实 React 渲染的可视验收页（`tools/preview/`）与拖拽缩放自动化断言（560×620 → 680×710，缩放比例 65% → 79% 自适应）

## v0.3.1 — 2026-10-28

**主题：修复工具注册 schema（模型侧参数校验报错）**

### 修复

- 5 个工具（`memory_search` / `memory_brief` / `memory_remember` / `memory_link` / `memory_forget`）的 `parameters` 改为标准 JSON Schema：顶层 `type: 'object'` + `properties` + `required` + `additionalProperties: false`，不再依赖字段表写法
- 注册时按工具逐个 `try/catch` 并打印工具名，单个工具 schema 失败不会拖垮其余工具

### 测试

- core 13/13、plugin 14/14（新增"工具注册使用完整 JSON Schema"断言：顶层 type、required 数组、数组元素类型）

## v0.3.0 — 2026-10-28

**主题：浮窗化 + 默认关闭（不再接管主界面）**

### 变更

- 移除 `main` 中央面板注册与输入框左侧药丸，改为**侧栏图标 + 可拖动/可缩放的浮窗**（`shell.overlay`）
- 浮窗内自带关闭按钮；位置与尺寸记忆在 localStorage；默认关闭，点侧栏图标才打开
- 侧栏图标 `order: 900`，排在其它插件入口之后，避免打乱已装插件顺序
- 首次安装为空图：不读对话、不调模型、不注入；开启「读取对话并自动生成」后才按会话积攒

### 测试

- core 13/13；plugin 14/14（注册契约只剩侧栏入口/浮层/设置三项、浮窗默认关闭、点图标打开、窗口内关闭）

## v0.2.2 — 2026-10-27

**主题：按会话归属 + 从零开始 + 防开局幻觉**

### 新增

- 记忆按会话归属：新装没有全局记忆，只有本会话、且开启后才积攒；跨会话只继承"关系/策略/长期偏好"
- `/health` 返回 `firstRun`、`auto`、`totalNodes`，客户端首次打开显示零起点引导
- 一键清空本会话记忆（`/session/forget`）
- 防幻觉：运行时上下文/技能目录/`User said (m…)`/`system-reminder` 等注入消息不折叠进对话；摘要只来自真实用户发言与助手回答

### 测试

- core 13/13、host 16/16、client 3/3

## v0.2.1 — 2026-10-27

**主题：自动生成可控（读取对话开关 + 生成数量上限 + 手动入口分离）**

### 新增

- 设置页「读取对话并自动生成记忆」总开关（`auto`），关闭后不再自动读取/抽取
- 每轮最多生成条数 `maxPerExtraction`（默认 3，范围 1–5，服务端钳制）
- 记忆总量上限 `maxTotalNodes`（默认 300，范围 20–2000），达到后只更新不新建
- 提示词里写入「本轮最多输出 N 条」；`batch.skipped` 记录被上限拦下的条数
- 手动入口明确分离：主面板「＋ 手动记一条」只负责手动新增/编辑，不触发自动抽取；「立即总结」才是显式触发一次抽取

### 变更

- 客户端：设置页新增数值项「每轮最多生成」「记忆总量上限」；空状态文案改为先在设置里打开开关或手动记一条
- 测试：core 15/15（新增数量/总量上限用例）、host 13/13（配置钳制断言）

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
