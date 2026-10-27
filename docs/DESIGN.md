# 忆泡 Memory Bubble · DSH 插件设计方案（v0.1）

> 一句话：**把 AI 对话里沉淀下来的记忆，养成一张会呼吸的泡泡图**——人看得见、管得住；AI 读得到、带得走。
>
> 本篇是「整理思路 + 可行性检验 + 方案」；交互方向有可点的离线原型 `prototype.html`，可安装的 DSH 插件代码在 `plugin/`（见 §12）。

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 能不能在 DSH 里做？ | **能**。DSH 的 slot / 事件 / 工具 / 系统提示词 / HTTP 路由都能覆盖全部需求，且本机已装插件里有完整先例（`misakanet`、`dsh-plugin-steward`）可对照。 |
| 最关键的技术支点？ | Host 侧插件（存储 + 抽取流水线 + 工具 + 路由）+ Client 侧整页 `main` 面板与 `sidebar.panellist` 图标。 |
| 最大的三个风险？ | ①「连线冲突」只能做成**建议式**判断（LLM 判官，非确定性）；②插件安装/启用受本机审批策略影响，当前会话无法替你装；③记忆注入若每轮改动 system prompt，会破坏 prompt 缓存（成本↑）。 |
| 建议先做什么？ | 先做**能跑的最小闭环**：手动「总结这一段」→ 图上有泡 → 点泡注入到下一轮 → 改大小/删/编辑 → 冲突警告。自动流水线放第二步。 |
| 与现有插件的关系？ | `dsh-hindsight` 是「后端记忆引擎 + 工具/命令」，**没有 UI 工作台**；`billion-context` 管上下文压缩；本工具补的是**可视化 + 治理 + 可迁移**这一层，并预留 adapter 可接 Hindsight。 |

---

## 1. 产品定位

**给谁**：把 DeepSeek 当日常对话伙伴、但苦于「聊完就忘 / 上下文一满就要开新会话」的人。

**两个用户价值，分开设计**：

1. **对人**：记忆可视化 + 可治理。看清 AI 记住了什么、记错没有、哪些重要；像整理抽屉一样编辑、合并、删除、调权重。
2. **对 AI**：可预算的上下文。不再「把历史全塞进去」，而是按**权重 + 与本轮的相关性**取一小把记忆（brief），直接降低「满上下文 → 换会话」的频率。

**不做什么（v1 明确边界）**：
- 不做向量数据库/检索服务（那是 Hindsight 的活）；本工具用「关键词 + 轻量相似度 + LLM 判断」。
- 不做跨设备同步（v1 只本机；接口预留）。
- 不自动改写历史消息、不改 DSH 会话日志格式。
- 不替用户做有破坏性的决定：冲突只「警告 + 降权」，不自动删。

---

## 2. 核心闭环（用户故事）

```
日常对话 ──(turn-stopping / 手动按钮)──▶ AI 抽取记忆点
      ▲                                        │
      │                                        ▼
  选中泡泡 ◀── (点泡泡 / 引用到托盘) ◀── 图上出现新泡泡、自动连线
      │                                        │
      └── 下一轮 system prompt 带「记忆简报」 ◀──┘
```

三个动作撑起 90% 的体验：**看（缩放逛图）→ 点（读/改）→ 用（拖进对话）**。

---

## 3. 记忆模型

### 3.1 节点（记忆点 / bubble）

| 字段 | 含义 | 谁改 |
|---|---|---|
| `id` | `mem_<8hex>` | 系统 |
| `title` | ≤ 12 字短标题（图上中/近档显示） | AI 生成，用户可改 |
| `summary` | ≤ 80 字事实描述 | AI 生成，用户可改 |
| `keywords` | 1–4 个关键字 chips | AI 生成，用户可改 |
| `importance` | 0–1，**决定圆半径** | AI 初判；用户拖滑杆改（主动权重） |
| `frequency` | 出现/被引用次数，**决定离中心远近** | 只被动累加（合并、被引用、被搜到都 +1） |
| `createdAt` / `updatedAt` | 记录时间（图上近档显示） | 系统 |
| `status` | `active` / `conflict` / `archived` | 冲突时系统置位，用户可解除 |
| `sourceRefs` | `{sessionId, seqStart, seqEnd, excerpt}` 列表 | 系统（溯源用） |
| `tags` | 主题标签（分布局分簇 + 过滤） | AI 生成，用户可改 |

半径映射：`r = 10 + 34 × importance`（视觉抖动 ±2px 仅动画）；距中心：`R = Rmin + (Rmax−Rmin) × log1p(freq)/log1p(maxFreq)`。

### 3.2 边（关系）

| 字段 | 含义 |
|---|---|
| `relation` | 一句话关系说明（"因果 / 补充 / 同一项目的偏好 / 时间先后 / 冲突"） |
| `confidence` | 0–1，AI 自评；低于 0.5 的关系不画（避免噪声） |
| `conflict` / `conflictNote` | 是否被判为与端点内容冲突 + 理由 |
| `weightScale` | 注入时的权重系数：正常 1.0，冲突 0.4（"后续思考中降权"落在这里） |

**连线视觉粗细统一**（需求如此）；粗细差异只体现在 hover/选中态。

### 3.3 权重公式（注入排序用）

```
w(node) = 0.55×importance + 0.25×recency + 0.20×frequencyScore
w *= status==='conflict' ? 0.4 : 1
w *= 1 + 0.1×(选中/托盘中)           // 用户显式关注优先
recency = exp(−天数/30)；frequencyScore = log1p(freq)/log1p(maxFreq)
```

一句话记忆简报预算：默认 **top-8 ≈ 400 tokens**；托盘选中记忆另算 **≤ 600 tokens**（每泡 ≤ 120 字），总注入 ≤ 1K tokens。

### 3.4 冲突规则（需求原文的落法）

1. **触发**：用户编辑某节点/某边的文本后，1 跳邻居进入"待校验"；或用户手动点「重新校验」。
2. **预筛**：关键词重合 + 否定词/时间矛盾启发式，减少 LLM 调用。
3. **判官**：LLM 比较「边的 relation」与「两端节点 summary」是否矛盾，输出 `{conflict, reason, severity}`，带原文引用。
4. **效果**：边变警示虚线、两节点描边告警、详情卡片顶部横幅写"该关系与两端记忆存在冲突，已在后续思考中降权"；注入时该边不计入、相关节点权重 ×0.4；**绝不自动删除**。
5. **解除**：用户点「确认保留」→ `conflict=false, weightScale=1.0`，记入审计日志（谁在何时解除了哪条）。
6. **诚实边界**：这是**建议式**判断，会误报/漏报；UI 文案必须写"AI 判断，仅供参考"。

---

## 4. 交互设计

### 4.1 主界面：整页 `main` 面板

```
┌──────────────────────────────────────────────────────────────┐
│ 忆泡 Memory Bubble        [搜索____]  [全部|本会话|冲突|最近]  │
│ 把对话里的记忆，养在一张会呼吸的图里                            │
├───────────────────────────────────────────────┬──────────────┤
│                                               │  记忆详情卡   │
│        ○        ○                             │  ┌────────┐  │
│           ○────────○        ○                 │  │ 标题    │  │
│      ○    ╲      ╱   ○                       │  │ 摘要    │  │
│            ○────○                            │  │ 时间    │  │
│                ○                              │  │ 关键词  │  │
│                                               │  │ 重要性▬ │  │
│  [图例：大=重要 中心=高频]        [缩放 120%]  │  │[引用][改]│  │
│                                               │  └────────┘  │
├───────────────────────────────────────────────┴──────────────┤
│ 记忆托盘： (泡1 ×) (泡2 ×)                    [注入本轮对话]   │
└──────────────────────────────────────────────────────────────┘
```

- 左栏图标（`sidebar.panellist`）+ 主面板（`main`，用同一个 id 派发，见 §7 证据）。
- 会话内的轻量入口：对话右侧栏 `conversation.view` 增加「忆泡」页签（只显示本会话触及的泡），以及输入框左侧一个「忆泡」按钮打开浮层选择器。

### 4.2 语义缩放（需求"随缩放显示不同信息"）

| 档位 | 显示 | 目的 |
|---|---|---|
| 远 < 0.5× | 柔光团块、按 tag 的色相、簇密度；无文字 | "我的记忆都长什么样" |
| 中 0.5–1.2× | 圆 + 短标题 + 连线 | 日常浏览 |
| 近 > 1.2× | 重要性 ≥60 的泡自动展开摘要首行 + 时间 + 关键词，其余泡悬停展开；连线关系短标签 | 阅读与核对 |

缩放以光标为中心、带 240ms 缓动；双击空白"适应窗口"；`Esc` 关卡片。缩放档位切换用透明度+字体尺寸过渡，不重排布局。

### 4.3 编辑动作（点开泡泡/连线）

| 动作 | 交互 | 备注 |
|---|---|---|
| 改标题/摘要 | 卡片内联 `textarea`，失焦保存 | 触发冲突校验 |
| 改重要性 | 滑杆 0–100，圆半径实时过渡 | 写回 `importance`，立即影响注入权重 |
| 改关键词/标签 | chips 输入 | — |
| 删除 | 二次确认；有连线时提示"将同时删除 N 条关系" | 软删 `archived` 7 天可恢复 |
| 合并 | 选中两泡 →「合并」→ 保留一个、另一个作为 sourceRef 并入 | v1.1 |
| 引用到对话 | 卡片按钮 / Shift+点击 / 长按 | 进托盘 → 「注入本轮对话」 |

**位置不可拖动**：拖空白 = 平移画布；拖泡泡 = 不做（防止与需求"位置只能被动改变"冲突）。首次使用有 3 秒提示条解释这一点。

### 4.4 视觉：暖调、丝滑、像在泡泡里

- 底：暖奶油 `#FFF7EF` + 双径向蜜桃/杏黄光晕；深色模式给"夜色琥珀"对应色（走 `--dsw-alias-*` token + artwork 层）。
- 泡：径向渐变（蜜桃→珊瑚、杏黄→琥珀…）、内高光、柔外发光、1px 半透明白描边；极小幅度漂浮（±3px, 6–9s，错相位），`prefers-reduced-motion` 关闭。
- 连线：暖棕 40%，圆头；hover 珊瑚色加粗；冲突态砖红虚线。
- 卡片/控件：暖白玻璃（blur 18px）、大圆角、柔阴影；按钮 hover 上浮 1px。
- 空状态：3 个呼吸的示例泡 + 一句"要不要用这次对话，长出第一颗记忆？"+ 主按钮。
- 所有容器/文字颜色必须走 DSH 主题 token（`--dsw-alias-bg-base`、`label-primary` 等），暖色只作为 artwork 叠加，保证深浅色模式都不破。

### 4.5 "提醒 AI"的三条路径（按可靠性排序）

1. **系统提示词里的「记忆简报」段**（`systemPrompt.section`）：top-K + 托盘选中项，随图变化刷新。AI 每轮都看得到 → 推荐主路径。
2. **工具按需拉取**：`memory_search` / `memory_get` / `memory_brief`。AI 想深挖时自己调，节省常驻 token。
3. **输入框插入**：把选中记忆渲染成一段 Markdown 引用塞进草稿（取决于 DSH 输入框是否暴露写草稿能力；做不到就退化成"复制到剪贴板"）。**这条待实现前验证**。

---

## 5. AI 侧设计

### 5.1 摘要流水线

```
触发：turn-stopping（去抖 8s）| 手动「总结这一段」| 定时批量回填
  ↓
取料：session/event 缓存的本轮 user+assistant 文本（只取增量，不读全史）
  ↓
抽取：一次 llm.stream() → 严格 JSON
      {memories:[{title,summary,keywords,importance,tags,relatedTo[]}],
       links:[{toId,relation,confidence}]}
  ↓
归并：归一化文本 → 关键词 Jaccard + 字 bigram Dice ≥ 0.55 判同 → 合并（频次+1、sourceRef 追加、摘要取新并记录旧值）
  ↓
连线：新泡 vs 已有 top-30（按 tag/关键词召回），每条 ≤3 条边；confidence<0.5 丢弃
  ↓
落盘：graph.json 原子写 + journal.jsonl 追加（可撤销/审计）
```

- **模型**：默认跟随 `agentDefaultModel.currentSelection()`（本机是 deepseek-flash）；可在设置里单独指定更便宜的模型；每次抽取限 1 次调用（链路一次性给完 links，不逐对调用）。
- **成本闸**：每日调用上限（默认 200 次）、单轮最多 1 次、单次输入 ≤ 6K token；统计写入 state，设置页可见。
- **防脏数据**：AI 自动写入的记忆默认 `confidence` 字段（展示为"AI 初判"），从未被用户确认/引用的泡 30 天后自动降权（不删）。
- **历史回填**（可选）：会话日志在 `~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`（zstd 压缩），解码能力与格式版本需实测，列为 v1.1 风险项；v1 只保证"从现在开始的活会话"。

### 5.2 工具清单（draft）

| 工具 | 作用 | 参数 |
|---|---|---|
| `memory_search` | 语义/关键词找记忆 | `{query, limit=8, tags?, days?}` |
| `memory_get` | 取指定记忆全文+邻居 | `{ids:[], depth=0}` |
| `memory_brief` | 取"可直接放进上下文的简报" | `{budgetTokens=800, focusIds?}` |
| `memory_remember` | 主动记一条（模型判断值得记时） | `{title,summary,keywords,importance?,links?}` |
| `memory_link` | 补关系 | `{fromId,toId,relation}` |

写操作受设置约束：`auto`（直接写）/ `ask`（写前询问）/ `off`（只能用户手动）；删除永远只允许用户/UI。

### 5.3 系统提示词段（`systemPrompt.section`）

```text
【忆泡记忆】你有一个跨会话的长期记忆图（当前 N 条记忆）。规则：
- 与用户提到的人/项目/偏好相关时，先 memory_search 再回答；不要凭猜测补空白。
- 用户本轮"关注"的记忆如下（已注入，勿重复检索）：
  · {title}: {summary}（重要性 0.8，2026-10-12）
- 关系标注 [冲突] 的记忆对你不可靠，需向用户确认后再用。
- 需要记住新事实时用 memory_remember；不确定是否值得长期记住时先问用户。
```

> ⚠️ 这段每轮变化会**改变 system prompt 前缀**，破坏 provider 的 prompt cache（本机 `billion-context` 的缓存经济学对此敏感）。缓解：只放"稳定 top-K"（图变才刷新，最多 5 分钟一次）+ 托盘选中项；冲突/动态内容交给工具按需取。这一取舍写进设置项「注入模式：稳定简报 / 实时简报」。

---

## 6. 技术架构

### 6.1 分层（为"以后做成 app / 多平台"留门）

```
┌─────────────────────────── 忆泡 core（无宿主依赖，纯 JS/TS）───────────────────────────┐
│ MemoryStore(JSON+journal) │ Summarizer(LLM iface) │ Linker │ ConflictJudge │ Layout │
│ PromptRenderer(简报)      │ ImportExport(JSON schema v1) │ Engine(extract/search/context) │
└───────────────▲──────────────────────────────▲──────────────────────────────▲──────────┘
                │                              │                              │
   DshHostAdapter (v1)                 BrowserAdapter                AppAdapter / MCPAdapter (v2+)
   · llm.stream / sessions /           · 本地 IndexedDB             · Tauri/Electron 包装
     session/event / tools /           · 纯前端演示                 · MCP server 暴露同 5 个工具
     systemPrompt / webServer / fs
```

**关键**：core 里没有任何 `ctx.`、`node:fs`、React；DSH 插件只是它的第一个宿主。这样"预留接口给其他 AI 读取/继承"不是嘴上说说——core 的 `Engine` + JSON schema 就是接口。

### 6.2 Host 半边（`lib/index.js`）

```js
export const name = 'memory-bubble'
export const inject = ['sessions', 'llm', 'agentDefaultModel', 'tools', 'webServer', 'systemPrompt', 'fs']
export function apply(ctx) {
  // 1) 存储：<profile>/.memory-bubble/{graph.json, journal.jsonl, state.json}
  // 2) 事件：ctx.on('session/event') 缓存本轮增量；ctx.on('agent/turn-stopping') 去抖抽取
  // 3) 工具：ctx.tools.register(...) × 5
  // 4) 提示词：ctx.systemPrompt.section({ name:'memory-brief', order: 60, text: () => brief() })
  // 5) HTTP：ctx.webServer.register({ method:'GET', path:'/memory-bubble/api/graph', handler })
  // 6) 配置：ctx.settings? => 设置页表单（auto/manual、模型、预算、注入模式）
}
```

### 6.3 Client 半边（`lib/client.js`）

```js
window.__ModuleLoader__.load({ id: 'dsh-memory-bubble', factory: (require) => {
  const React = require('react')            // 浏览器模块表里唯一可依赖的包
  const inject = ['slots']
  function apply(ctx) {
    // sidebar.panellist: 图标（id = MEMORY_PANEL_ID）
    // main:              { key: MEMORY_PANEL_ID } → <MemoryGraphPage/>
    // conversation.view: { id:'memory-bubble' } → 会话内小图/托盘
    // shell.overlay:     快速选泡浮层（点输入框旁按钮时打开）
    // settings.section:  设置页
    // 每个注册都包 ctx.effect + ctx.slots.inject(...)，单点失败不影响其它 surface
  }
  return { inject, apply }
}})
```

- 数据：`fetch('/memory-bubble/api/*')` 同源；变更后 `api-session/status` 不涉及，自建 1.5s 轮询/SSE（webServer 可流式）二者取一。
- 渲染：SVG（`<g transform>` 做平移缩放）+ rAF 合批；力导向布局在 worker 或主线程 300ms 预算内算完，期间显示"正在整理…"气泡。
- 主题：读 `--dsw-alias-*`；深浅色都出；动画尊重 reduced-motion。
- 无第三方依赖（客户端只能 require 浏览器模块表里的包），布局/图形全部手写。

### 6.4 数据与接口

**文件**（都在 profile 目录，便于整体搬迁/备份）：

```
.dsh/profiles/desktop/.memory-bubble/
  graph.json      # 节点+边（version 1，带 layoutCache）
  journal.jsonl   # 每次写操作一行（谁/何时/改了什么，支持撤销与审计）
  state.json      # 预算计数、上次抽取位置、设置覆盖
  exports/        # 用户导出的 *.bubble.json
```

**HTTP API**（同源、仅本机、path 前缀 `/memory-bubble/api`）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/graph?graphId=default` | 取整图（含 layoutCache） |
| POST | `/node` | create/update/delete（body: `{action, node}`） |
| POST | `/edge` | create/update/delete |
| POST | `/extract` | 手动触发一次抽取 `{sessionId}` |
| POST | `/conflict/check` | 校验某条边 `{edgeId}` |
| GET | `/context?sessionId=&budget=` | **给外部 AI 的简报**（纯文本/JSON 两态） |
| GET | `/export` · POST `/import` | JSON schema v1 完整迁移 |
| GET | `/status` | 队列、最近运行、花费、错误 |

**迁移/继承**：导出物 = `{schema:'memory-bubble/v1', graph, brief:{topK}, meta}`；新会话/新机器导入后，`/context` 立刻可用 → "当前对话满了移动到下一对话"只需把 brief 作为首条消息或系统段。

### 6.5 与 DSH 现有能力的对接（详见 FEASIBILITY.md 的证据表）

- 取对话内容：`session/event`（提交后 append feed）+ `agent/turn-stopping`（回合关闭前）；
- 调模型：`ctx.get('llm').stream({provider, model, messages})`（与已装插件 `dsh-plugin-steward` 的 AI 标签同路径）；
- 注入上下文：`systemPrompt.section`（已装 `dsh-hindsight` 用过同形态）；
- 工具：`tools.register`（`dsh-hindsight` 有 6 个工具先例）；
- UI：`sidebar.panellist` + `main` + `conversation.view` + `shell.overlay` + `settings.section`（`misakanet` 有完整注册先例，见 `misakanet/lib/client.js:1924-1933`）；
- 路由：`webServer.register`（`plugin-console/lib/index.js` 用同形态挂了 `/plugin-console/api/*`）。

---

## 7. 可行性检验（结论先行，证据表在 FEASIBILITY.md）

| # | 需求 | 结论 | 主要不确定性 |
|---|---|---|---|
| 1 | AI 对话后总结上下文/信息 | ✅ | 抽取质量与成本；需严格 JSON 输出 |
| 2 | 圆=记忆点的网络图 | ✅ | 无 |
| 3 | 大小=重要性 | ✅ | 无 |
| 4 | 频率越高越靠中心 | ✅ | 频率定义需统一（出现/引用/搜索都算？建议=合并次数+被引用次数） |
| 5 | 主动推断关系并连线 | ⚠️ 可行但质量是产品难点 | LLM 关系判断会过度连线/漏连；要 confidence 阈值 + 用户可删 |
| 6 | 点开圆/线可改/删/调大小 | ✅ | 无 |
| 7 | 位置只能被动变，大小可主动改权重 | ✅ | 布局重排时的动画要顺滑 |
| 8 | 连线与两端冲突 → 警告+降权 | ⚠️ 建议式可行 | 判官误报/漏报；必须写明"仅供参考" |
| 9 | 缩放显示不同信息 | ✅ | 语义缩放三档的视觉打磨占工时 |
| 10 | 每泡含信息/时间/关键字 | ✅ | 无 |
| 11 | 选泡提醒 AI | ✅（主路径） / ⚠️（输入框插入） | 输入框写草稿能力待验证 |
| 12 | 对人可视化+管理 | ✅ | 大图（>500 泡）性能需优化 |
| 13 | 对 AI 控上下文长度 | ✅ | 注入与 prompt cache 的取舍 |
| 14 | 预留接口给其他 AI 读取/继承 | ✅ | v1 是 HTTP+JSON；MCP/工具化 v2 |
| 15 | 插件先行，后续 app/多平台 | ✅ | core/adapter 分层从第一天就要坚持 |
| 16 | 暖调、丝滑、像泡泡 | ✅ | 视觉规范已给，原型可点 |
| 17 | DSH 插件验证 | ⚠️ 能写能装，但本会话审批被设为 never，装/启用需你授权或手动执行 | 见风险 R1 |

### 7.1 原型自检（2026-10-27，真实浏览器点击）

`prototype.html` 已通过 15 项 CDP 自动断言（`_qa.mjs` → `qa-results.json`）：加载/渲染、首屏布局、点泡详情卡、滑杆改半径、改名同步、删除二次确认、连线详情、冲突校验反馈、搜索三态、托盘注入、三档缩放、新增记忆、连续缩放 ~53fps、刷新持久化、零未捕获异常。**它验证的是交互与视觉，不是插件运行时**（差距见 §9.1）。

## 8. 风险清单（按严重度）

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 本会话 approval=never，`plugin_manager` 安装/启用会被自动拒绝 | 无法当场验证"装进 DSH 后长什么样" | 你手动执行安装命令或把审批策略临时改回 ask；我可以先给"link 安装 + 重启后自检清单" |
| R2 | 系统提示词每轮变化破坏 prompt cache | token 成本上升（尤其本机在用 billion-context 缓存经济学） | 默认"稳定简报"模式：图不变不刷新；托盘项走工具按需 |
| R3 | 抽取/连线是 LLM 判断 | 记错、过度连线、漏连 | 严格 JSON + 置信度阈值 + 每条可溯源（sourceRefs）+ 用户可编辑/删除 |
| R4 | 冲突判断主观 | 误报造成噪声 | 建议式文案 + "确认保留"一键解除 + 审计日志 |
| R5 | 冷历史回填需 zstd 解码（会话日志 `session.v4.jsonl.zstd`），格式版本/解码库不确定 | 历史记忆无法自动补 | v1 不做回填；只处理活会话；v1.1 实测后补 |
| R6 | 大图性能 | 缩放卡顿 | <300 泡纯 SVG；>300 用分层/聚类聚合显示，必要时 canvas 后备 |
| R7 | "位置=频率"反直觉 | 用户想手动固定某泡位置 | 明确不做手动定位，改用"pin 到简报首位"满足重要性诉求 |
| R8 | 所有记忆都在本机明文 | 隐私 | 提供"不落盘敏感词"过滤 + 一键清空；模型调用本身仍会发送选中内容（需在设置里说明） |
| R9 | 插件 UI 与 shell 其他 surface 冲突 | Web 启动失败时整页报错 | 每个 surface 单独 try/ctx.effect 注册（misakanet 的教训：一次 throw 会让整个插件 failed） |
| R10 | 注入记忆导致 AI 过度依赖/串味 | 对话质量下降 | 简报里明确"仅在你判断相关时使用"，并限制条数与字数 |

## 9. 里程碑（单人工时估算）

| 阶段 | 内容 | 工时 |
|---|---|---|
| M0 | 本设计 + 可点原型（`prototype.html`，15 项 CDP 自检全过） | ✅ 本次 |
| M1 | 插件骨架：host 存储/路由 + client 主面板静态读图（含暖色视觉骨架） | 1.5 天 |
| M2 | 抽取流水线 + 5 个工具 + 简报注入（稳定模式） | 2 天 |
| M3 | 编辑/删除/滑杆/托盘注入/会话视图/冲突校验 | 1.5 天 |
| M4 | 动效打磨、语义缩放三档、设置页、导入导出、自检脚本 | 1 天 |
| 合计 | | **≈ 6 人天** |

### 9.1 原型与最终实现的差距（诚实清单）

原型证明的是「交互与视觉方向」，不是「已经能用的插件」。差异：

| 项 | 原型 | 最终插件 |
|---|---|---|
| 数据来源 | 20 条手写示例 + 按钮模拟「AI 总结」 | `session/event` 增量 + `llm.stream` 真抽取 |
| 存储 | 浏览器 `localStorage`（演示持久化） | `<profile>/.memory-bubble/graph.json` + `journal.jsonl` |
| 「引用到对话」 | 托盘 + toast 模拟 | `systemPrompt.section` 简报 + 工具按需（输入框插草稿待实测） |
| 冲突校验 | 点「重新校验」给固定结果 | LLM 判官 + 启发式预筛 + 权重真的进上下文 |
| 图布局 | 一次性力导向 + 固定半径 | 同算法，但布局结果缓存、增量更新 |
| 跨会话/迁移 | 无 | `/export`、`/import`、`/context` |


验收（M1 起每步都验）：侧栏出现忆泡图标 → 主面板出图 → 对话跑 2 轮后点"总结这一段" → 图上新增泡与连线 → 点泡引用 → 下一轮 AI 回答能引用该记忆（看 system prompt 调试/日志）→ 改一条关系触发冲突警告 → 重启 DSH 后数据仍在。

## 10. 需要你拍板的点

见本轮对话末尾的 5 个问题（记忆范围与图结构、自动总结触发、注入方式/缓存取舍、与 Hindsight 的关系、安装验证方式）。答案会回填到本文件 §11。

## 11. 决策记录（已回填）

用户 2026-10-27 答复：

| # | 问题 | 选择 |
|---|---|---|
| 1 | 记忆范围 | 全局图 + **会话内过滤视图**（默认看全部，可切到当前会话） |
| 2 | 自动总结 | **每回合后自动、去抖**；可撤销、可取消、可整体开关 |
| 3 | 注入方式 | **稳定简报为主**（固定顺序 + 动态尾注，优先保住 KV 缓存），托盘作为置顶钉选 |
| 4 | 是否接 Hindsight | **不接**，独立自带存储（`<profile>/.memory-bubble/`），避免双份数据源 |
| 5 | 安装验证 | **先把插件代码写完**，安装与真机验证放到下一个对话单独做；本轮补**深色模式** |
| 6 | 近景信息密度 | 保持「3–6 条自动展开 + 其余短标题」，不摊文字墙 |
| 7 | 标签取舍 | 接受避让/隐藏，但悬停必须能补全；设置里可开「总是显示全部标签」 |
| 8 | 首屏留白 | 保留 87% 克制感，可选「默认更满」只做设置项、不改默认 |
| 9 | 产品面向 | 主要面向与 AI 日常聊天的人——价值在「让 AI 记得住、让人看得清」，不是开发者面板 |

## 12. 实现落地记录（v0.1 代码）

代码在 `plugin/`，host + client 两半已写完并通过本地自检：

| 层 | 文件 | 已实现 |
|---|---|---|
| 宿主 | `plugin/lib/index.js` | `session/event` 折叠（只认真实用户消息）→ `turn/end` 去抖 → `llm.stream` 抽取 → 合并入图；原子持久化；稳定简报；`systemPrompt.section` / `agent/pre-step` 双路注入；`/memory-bubble/api/*` 共 16 条路由；`memory_search/brief/remember/link/forget` 5 个工具；策略探测与降级 |
| 逻辑 | `plugin/lib/core.js` | 抽取解析容错、判重合并（标题/包含/词集）、布局（极坐标环 + 力导向松弛，760×560）、稳定简报、整批撤销、导入导出、提示词 |
| 存储 | `plugin/lib/store.js` | `<profile>/.memory-bubble/state.json`，临时文件 + `.bak` 原子替换，导出目录 |
| 客户端 | `plugin/lib/client.js` | 单文件无构建，注册 `sidebar.panellist` / `main` / `conversation.input.left` / `settings.section`；三档缩放、拖动平移、详情卡、滑杆改重要性、编辑/删除、冲突连线与重新校验、搜索、托盘、撤销、导入导出、深浅色 |

**配置（v0.2.1 增补）**：设置页四项控制自动生成——「读取对话并自动生成记忆」总开关、每轮最多生成条数（`maxPerExtraction`，默认 3，范围 1–5）、记忆总量上限（`maxTotalNodes`，默认 300，范围 20–2000）、总结去抖与最小间隔；注入方式与摘要条数仍在同一页。「＋ 手动记一条」按钮只负责手动新增/编辑，不触发自动抽取；每个会话还能在托盘里单独暂停自动读取。

自检结果：core 15/15（新增生成数量/总量上限用例）、host 13/13（伪造 ctx + 真实 HTTP 流程，含互操作路由与配置钳制）、client 冒烟 3/3、interop 5/5、`node --check` 四文件通过。
真机未验证项与安装三选一写在 `plugin/README.md`。

## 13. 跨 AI 互操作层（v0.2）

需求（用户原话）：“保留接口，让其他 ai 也能下载并使用。”
目标：忆泡不是 DSH 专属。同一份 `state.json`，别的 AI / 宿主 / 脚本都能读；记忆可以跨 AI、跨对话、跨机器继承。

### 13.1 四条通道（全部零第三方依赖）

| 通道 | 实现 | 给谁用 | 协议 / 入口 |
|---|---|---|---|
| MCP stdio | `interop/mcp-server.mjs` | Claude Desktop、Cursor、任何 MCP 客户端 | JSON-RPC 2.0（2024-11-05）：5 tools、3 resources、1 prompt；`initialize.instructions` 自带便携提示词；`--read-only` 可禁用写入 |
| CLI | `interop/cli.mjs` | 脚本、其他 AI 的 shell 工具 | `list / search / brief / export / import / bundle / remember / forget`；`--data` 指定任意 state.json |
| HTTP | 插件路由 `/memory-bubble/api/interop`、`/ai/bundle`、`/ai/prompt` | 本机进程、局域网工具（DSH 运行中） | 与插件共用 webServer，不开新端口 |
| 记忆包文件 | `bundle.json` | 换 AI / 换机器 / 换对话 | `memory-bubble-bundle v1`：`graph` + `digest` + `prompt` + `tools` |

### 13.2 格式契约（唯一真相 = schema/）

- `memory-bubble/v1`：图导出格式。`{ schema, version, exportedAt, source, graph: { id, nodes, edges } }`，节点带 `importance / hits / kind / keywords / sessions`。
- `memory-bubble-bundle v1`：记忆包。`graph` 内联，`prompt` 是可直接贴进 system prompt 的中文规则，`tools` 是 5 个工具的 JSON-Schema（function calling / MCP 可直接转写）。
- 导入兼容三种输入：v1 信封、旧版扁平 `{nodes,edges}`、bundle。判重沿用标题/关键词规则，`report` 返回新增/跳过数。
- 记忆图与状态分离：`state.json` 是内部状态（含会话缓冲、批次、托盘），导出只带可继承部分；导入方不需要懂内部状态。

### 13.3 安全与隐私

- 全部本地、不联网；MCP 与 CLI 不订阅网络端口。
- 默认只读优先：MCP `--read-only`；CLI 写命令需显式执行；HTTP 写接口仅在 DSH 本地端口可达。
- 可审计：state.json 纯 JSON + `.bak`；插件支持整批撤销；导出/导入都在用户显式操作下发生。

### 13.4 测试证据

`interop/dev/test-interop.mjs` 5/5：CLI 写入/读取/导出/导入、bundle 结构、schema 可解析、MCP 握手 + tools/list + tools/call + resources/read；
`plugin/dev/test-host.mjs` 13/13 覆盖 `/interop`、`/ai/bundle`、`/ai/prompt` 与导入去重；MCP 在具体客户端（Claude Desktop / Cursor）里的真实握手仍待真机验证。

### 13.5 边界

- 不绑定具体模型：bundle 里的记忆是数据，任何 AI 都能读；抽取仍由 DSH 内配置的默认模型完成。
- 不做云同步：继承靠文件搬运（bundle.json / state.json），避免账号与隐私复杂度；想要同步可在上层加自己的同步工具。
- 其他宿主接入只需实现 `memory-bubble/v1` 导入导出，即可与 DSH 插件互操作。

## 附：参考先例（本机已装，可直接读源码对照）

| 先例 | 看什么 |
|---|---|
| `C:\Users\COLORFUL\.dsh\profiles\desktop\node_modules\misakanet\lib\client.js:1834-1937` | `sidebar.panellist` + `main` 同 id 注册、slot 声明守卫、失败隔离 |
| `D:\Deepseek Harness\plugin-console\lib\index.js` + `lib\client.js` | host 路由 + 单文件 client + profile 目录读写的最小形态 |
| `C:\Users\COLORFUL\.dsh\profiles\desktop\node_modules\dsh-hindsight\README.md` | 记忆类插件的工具/命令/系统提示词注入形态（可直接借鉴） |
| `billion-context` 的 `dsh.bundle.patch.yml` | 插件如何 patch profile 的 loader 行（以后若需改 compaction/preset） |
