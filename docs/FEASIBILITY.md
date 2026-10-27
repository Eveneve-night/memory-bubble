> 说明（开源版）：本文件是设计轮的可行性报告，写作时实现尚未落地；文件名、路由与存储位置以 `plugin/` 中的实际代码和 `plugin/README.md` 为准（v0.1 实现状态见 `docs/DESIGN.md` §12）。

# 忆泡 Memory Bubble · 可行性检验与证据

> 配套 `DESIGN.md`。本文只回答一件事：**在 DSH 里，这些需求靠什么接缝实现，证据在哪，哪里还不确定。**
> 所有 API 签名来自本机 DSH 的 `cordis_inspect` 实时查询（2026-10-27），不是网搜推测。

---

## 1. 环境事实（已核实）

| 事实 | 值 / 位置 |
|---|---|
| DSH 形态 | Electron 桌面安装版：`<DSH 安装目录>/DeepSeek Harness.exe` + `resources/app.asar`（只读，Host 文件读工具可读单个文件） |
| 工作 profile | `$DSH_PROFILE`（`package.json` 里 18 个 bundle） |
| 已装包 | profile `node_modules/`：`dsh-hindsight`、`billion-context`、`misakanet`、`dsh-plugin-steward`（本地 link 的 plugin-console）、`dsh-conversation-navigator`、`dshmarket` 等 |
| 会话日志 | `$DSH_HOME\sessions\<workspace-slug>\<sessionId>\session.v4.jsonl.zstd`（**zstd 压缩的 JSONL**） |
| 投影缓存 | `$DSH_HOME\storages\session_projcache\sessions\<id>.json`（派生数据，不是完整消息） |
| 本机模型 | `agent-default-model`：`provider: deepseek-official`，`model: deepseek-flash`，`reasoningEffort: high` |
| 审批策略 | 本会话 `approval=never`：任何需要审批的动作会自动拒绝（含 `plugin_manager install`） |
| 文件沙箱 | `danger-full-access`（写文件不受限） |

---

## 2. 支点与证据（实现映射）

### 2.1 宿主侧能力（Host Service，全部来自 `cordis_inspect` host `Service` 目录）

| 能力 | 精确签名（摘录） | 用途 | 证据 |
|---|---|---|---|
| 调模型（后台总结） | `llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>`；`llm.listProviders()`；`prepareCall(config, signal?, configure?)` | 抽取/合并/冲突判断 | `Service` 目录 `key: "llm"`；已装插件 `dsh-plugin-steward` 的 AI 标签走的是 `ctx.get('llm') + agentDefaultModel.currentSelection()` |
| 默认模型 | `agentDefaultModel.currentSelection(): ModelSelection` | 选 provider/model | 同上；profile patch 显示默认 flash |
| 会话读取 | `sessions.get(id): Session \| undefined`、`sessions.list(): Session[]`、`sessions.registerMessageProjection(projection)`、`sessions.fork(source, boundary?, childSessionId?)` | 取当前会话、fork/handoff | `Service` 目录 `key: "sessions"` |
| 消息事件 | `session/event(session, event)`（提交后 append feed）；`agent/turn-stopping`（回合关闭前，serial，可 async）；`agent/inbox/inserted` | 增量取料 + 触发时机 | host `Event` 目录 |
| 工具注册 | `tools.register(definition: ToolDefinition): () => void` | 5 个记忆工具 | `Service` 目录 `key: "tools"` |
| 提示词注入 | `systemPrompt.section(section: PromptSection): () => void` | 注入「记忆简报」 | `Service` 目录 `key: "systemPrompt"`；用法先例：`dsh-hindsight/lib/index.js` 中 `ctx.systemPrompt.section({ name:"hindsight-memory", order:130, text:[...] })` |
| HTTP 路由（给 client 与外部 AI） | `webServer.register(route: WebRoute): () => void`；`registerUpgrade`；`tapIndex`；`renderIndex` | `/memory-bubble/api/*` | `Service` 目录 `key: "webServer"`；先例：`plugin-console/lib/index.js` 挂 `/plugin-console/api/*` |
| 配置/设置 | `settings` 相关（hindsight 用 `@deepseek-ai/dsh-settings` 的 `settingsNamespace`） | 设置页字段 | `dsh-hindsight/package.json` 依赖 + README 配置表 |
| 存储 | `storage` / `storageDomain.open(spec)` | 备选：用 DSH 存储而非裸文件 | `Service` 目录 `key: "storage"` |

### 2.2 客户端侧能力（Client slots，来自 `cordis_inspect` client `Slots`）

| 界面 | slot | 注册参数 | 证据 |
|---|---|---|---|
| 左栏图标 | `sidebar.panellist`（root scope，list） | `{name, id, order, label}` | `misakanet/lib/client.js:1928-1930` |
| 整页主面板 | `main`（keyed，中央列） | `{name, key}`；**key 必须等于侧栏条目 id** | `misakanet/lib/client.js:1924-1933` 的注释与实现："`sidebar.panellist` draws the icon ... `main` is the page the sidebar dispatches that id to" |
| 会话内页签 | `conversation.view`（per-session，list） | `{name, id, order, label}` | `misakanet/lib/client.js:1920-1922` |
| 浮层 | `shell.overlay`（root，frame 级，所有列之上） | `{name, id, order}` | `misakanet/lib/client.js:1978-1980` |
| 输入框附件/按钮 | `conversation.input.left` / `conversation.input.overlay` | `{name, id, order}` | 本机前作 `plugin-console/lib/client.js` 已用 `conversation.input.left` + `shell.overlay` |
| 设置页 | `settings.section` / `settings.general.item` | `{name, id, order}` | `misakanet/lib/client.js:1987-2004` |
| 主题 | `theme.getTheme/setTheme/register/overrideTokens` + 14 个 `--dsw-alias-*` token | — | client `Theme` 目录 |
| 语言 | `locale.register/bind/subscribe` | `{en, zh}` 字典 | `misakanet/lib/client.js:1950-1974` |

**关键约束（踩过的坑，直接引用先例注释）**：
- 子 slot 必须先 `ctx.slots.inject(name, cb)` 等声明，直接 `register` 会抛 `slot "…" is not declared (a parent entry's children table must declare it)`；一次 throw 会让整个插件 fiber `failed`，整页显示 "Failed to load plugins" → **每个 surface 单独 `ctx.effect` + try/catch**（`misakanet/lib/client.js:1867-1907`）。
- client 单文件模块形态：`window.__ModuleLoader__.load({ id, factory: (require) => ... })`，只能 `require('react')`，无构建、无第三方依赖（`plugin-console/lib/client.js` 先例）。
- 不能读别的插件 DOM/样式来做定位；位置一律走 slot（`cordis-plugin-development` references `ui-plugin.md`）。

### 2.3 记忆类先例（避免重复造轮子 / 找到接口位置）

| 先例 | 它做了什么 | 与本工具的关系 |
|---|---|---|
| `dsh-hindsight`（已装 v0.4.0） | Hindsight 记忆后端的轻量 client：6 个模型工具 + `/hindsight` 命令 + 系统提示词引导段；**明确不做 WebUI 工作台、不做 client bundle**（README §范围） | 后端型方案；忆泡可把 Hindsight 当 adapter（v2），v1 自存本地 JSON |
| `billion-context`（已装） | 上下文压缩/缓存经济学；patch profile 的 compaction 与 preset 行 | 忆泡的简报注入必须与它共存：**别每轮改 system prompt 前缀**（见风险 R2） |
| `misakanet`（已装） | 完整 UI 插件范例：主面板、会话页签、浮层、设置、语言、`registerSource` | 直接当 UI 接缝的样板 |
| `dsh-plugin-steward`（本机 `<DSH 安装目录>/plugin-console`，link 安装） | host 路由 + 单文件 client + 自建 JSON 状态 | 存储/路由/更新最小闭环的样板 |

---

## 3. 逐需求可行性（细表）

> 图例：✅ 能按需求原样做；⚠️ 能做但必须改变需求的实现方式或需要实测；❌ 不建议做。

| # | 需求原文（m00002） | 结论 | 实现方式 | 验收方法 |
|---|---|---|---|---|
| 1 | "由 AI 对上下文进行总结，总结一件事情或透露的信息" | ✅ | `agent/turn-stopping` 去抖取本轮增量 → `llm.stream` 严格 JSON | 跑 2 轮后点"总结这一段"，`graph.json` 出现新节点 |
| 2 | "绘制网络图，每个圆代表一个记忆点" | ✅ | client `main` 面板内 SVG | 侧栏图标 → 主面板出图 |
| 3 | "越重要的圆越大" | ✅ | `r = f(importance)`，滑杆实时过渡 | 拖滑杆半径变化，重启后保持 |
| 4 | "出现频率越高的越在中心" | ✅ | 径向布局：目标半径 = `f(freq)`；力导向迭代 | 造两个频次不同的节点，位置差异明显 |
| 5 | "主动总结各圆之间的关系并连线" | ⚠️ | 抽取时同一次 LLM 调用产出 `links[]`；confidence ≥0.5 才画 | 新节点自动挂 1–3 条边；边上可读关系文案 |
| 6 | "点开每一个圆或连线修改信息/删除/调整大小" | ✅ | 详情卡片（内联 textarea / 滑杆 / 二次确认删除） | 逐项手测 |
| 7 | "位置只能被动改变，大小可通过主动改变修改权重" | ✅ | 位置 = 布局函数输出，节点不可拖；重要性写 `importance` 并参与注入权重 | 拖动节点无位移；滑杆改变后 `w(node)` 变化 |
| 8 | "连线内容与线两端圆中信息冲突会警告，并在后续思考中降低权重" | ⚠️ | LLM 判官（异步、建议式）：`conflict=true` → 警示样式 + `weightScale=0.4` + 简报里标注 | 改一条关系触发警告；下轮简报文本出现"冲突/不可靠"标注 |
| 9 | "整个图可缩放，随缩放显示的信息不同" | ✅ | 三档语义缩放（<0.5 / 0.5–1.2 / >1.2） | 缩放到三档截图对比 |
| 10 | "每个圆的信息包括信息本身、记录时间和关键字" | ✅ | 卡片 + 近档图上显示；数据模型见 DESIGN §3 | 卡片字段完整 |
| 11 | "用户可以通过选择圆到对话中从而提醒 AI" | ✅ 主路径 / ⚠️ 输入框插入 | 托盘 → `systemPrompt.section` 简报（主）+ 工具按需（辅）；"插入草稿"能力待实测 | 选中后下一轮 AI 主动引用该记忆 |
| 12 | "对人类：上下文记忆点可视化并管理" | ✅ | 主面板 + 会话页签 + 搜索/过滤 | 手动整理 10 条记忆不崩 |
| 13 | "对 AI：控制上下文长度，降低满上下文可能性" | ✅ | `/context` 预算化简报（默认 800–1000 tokens），替代"塞全史" | 对比注入前后 token 消耗（tokenMeter/日志） |
| 14 | "预留接口，可用其他 AI 接入读取，从而继承/移动到下一对话" | ✅（v1 为 HTTP+JSON） | `/memory-bubble/api/context`、`/export`、`/import`；schema `memory-bubble/v1` | 用 curl 取简报；导入到另一 profile 后能读 |
| 15 | "除插件外可做成 app 或面向更多平台" | ✅（架构） | core 与宿主 adapter 分层（DESIGN §6.1） | core 不 import DSH 任何东西即可跑单测 |
| 16 | "UI 偏暖调、操作丝滑、像在泡泡中" | ✅ | 主题 token + artwork + 动效规范；见 `prototype.html` | 真机手感（需安装后看） |
| 17 | "先做 DSH 插件验证" | ⚠️ 能写，本会话装不了 | 计划 link 安装到 desktop profile | 需你授权/手动执行，见 §5 |

---

## 4. 尚未验证、实施前必须实测的点

| # | 问题 | 为什么重要 | 怎么验（10 分钟内） |
|---|---|---|---|
| U1 | `main` 面板能否拿到**自身列的宽高并铺满**、是否被外层滚动容器限制 | 图需要满屏画布 | 装一个最小 hello 面板，`height:100%` + resize 观察 |
| U2 | 客户端能否向输入框**写草稿**（"插入引用"路径） | 需求 11 的最顺滑形态 | 查 client `conversation`/`chatDraft` 服务；否则降级为"复制到剪贴板 + 提示" |
| U3 | `tools.register` 的 `ToolDefinition` 完整形态（`defineTool` 来自 `@deepseek-ai/dsh-tools`，插件依赖如何解析） | 没有工具就没有 AI 侧闭环 | 抄 `dsh-hindsight/lib/index.js` 的 import + 注册方式，最小工具跑通 |
| U4 | `session/event` 的 event 形状（消息内容在哪个字段、如何只取 user/assistant 文本） | 抽取取料 | 打一条日志 dump 一个 event |
| U5 | `PromptSection.text` 的类型（string / string[]）与刷新时机 | 简报注入 | 抄 hindsight 的 `text: [...]` 用法，观察 system prompt |
| U6 | 冷会话 zstd 解码（历史回填） | v1.1 功能 | 读一个 `session.v4.jsonl.zstd` 试 `zlib.zstdDecompress`（Node 版本相关） |
| U7 | 插件安装/启用链路在 `approval=never` 下的行为 | 能否当场验证 | 需要你手动 `dsh plugin --profile desktop add "link:<repo>"` 或临时改审批策略 |
| U8 | 注入简报与 `billion-context` 压缩/缓存策略的相互影响 | 成本 | 观察开启简报前后的缓存命中（billion-context 有统计） |

---

## 5. 验证计划（安装后按序执行）

1. **安装**（需授权）：profile `package.json` 加 `"dsh-memory-bubble": "link:<repo>"`，`dsh.profile.bundles` 加同名；重启 DSH。
2. **冒烟**：侧栏出现「忆泡」图标 → 点开主面板 → 空状态正常 → `/memory-bubble/api/status` 返回 200。
3. **抽取**：对话 2 轮 → 点「总结这一段」→ 图新增节点 → 检查 `.memory-bubble/graph.json` 与 `journal.jsonl`。
4. **注入**：点泡引用 → 托盘 → 「注入本轮对话」→ 下一轮问"你记得我什么" → 回答能引用；system prompt 调试里能看到"记忆简报"段。
5. **编辑/冲突**：改一条关系文本 → 1.5s 内出现冲突警告 → 注入权重变化（日志）→ 「确认保留」解除。
6. **持久化**：重启 DSH，图与编辑结果仍在。
7. **迁移**：`/export` 导出 → 在另一 profile `/import` → `/context` 能取到简报。

---

## 6. 备选方案（主线受阻时）

| 主线风险 | B 计划 |
|---|---|
| `main` 面板交互/性能不达标 | 图放 `shell.overlay`（全窗口浮层）或独立浏览器标签页（host 路由提供静态页） |
| 工具注册被策略限制 | 用 `/memory` 斜杠命令（先例：misakanet 的 `registerSource` / hindsight 的 commands） |
| 无法安装插件 | 先交"离线原型 + core 库 + 导出 JSON"，等你有空装；或做成独立 Electron/Tauri 壳（core 已分层） |
| 系统提示词注入破坏缓存 | 改为"工具按需 + 每 N 轮刷新"模式 |
| 抽取成本高 | 关自动、只手动；或换更便宜模型；或只抽取用户显式"记住这个" |

---

## 7. 结论

- **技术可行性：高**。所有需求都有明确接缝，且本机已有同类插件源码可抄（UI 抄 misakanet、工具/提示词抄 hindsight、路由/存储抄 plugin-console）。
- **产品可行性：中高**。真正的难点不是技术，而是 ①关系/冲突的 LLM 判断质量 ②"位置=频率"的用户教育 ③注入与缓存成本的平衡。
- **本会话可交付**：设计稿 + 可点原型 + 接口 schema + 实现清单；**不可交付**：已装进 DSH 的可见插件（审批策略 `never`）。
