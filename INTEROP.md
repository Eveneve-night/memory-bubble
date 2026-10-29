# 忆泡 · 跨 AI 互操作（INTEROP）

> 目标：忆泡不只是 DSH 里的一个插件。你在 DSH 里养大的记忆，可以被 **Claude Desktop / Cursor / 任意脚本 / 你自己的 AI** 读取、继承，也能从别的 AI 导回来。
> 所有通道共用同一份数据与同一套格式，**零第三方依赖**，全部是 `node` 内置模块。

## 当前开发版：连接运行中的 DSH

需同时更新插件和本目录的适配器；旧 v0.3.4 插件没有在线桥接和独占锁。
插件启动后，在 `<profile>/.memory-bubble/bridge.json` 写入本机地址和令牌。
MCP/CLI 根据 `--data` 自动发现它。在线操作复用插件处理函数，不直接改运行中插件的数据文件。
界面仍使用原 HTTP 接口；原五个 MCP 工具、图和记忆包格式均保留。

```bash
node interop/mcp-server.mjs --data "<profile>/.memory-bubble/state.json" --session S2
node interop/cli.mjs remember --data "<profile>/.memory-bubble/state.json" --session S2 --title "偏好" --summary "喜欢用例子解释"
node interop/cli.mjs carry --from S1 --to S2
```

在线 MCP 额外提供 `memory_action {operation, params}`，可执行图谱读取、节点编辑、关系编辑、
托盘、会话开关、设置、总结、撤销和导入导出。完整操作名见 `plugin/lib/bridge.js` 的 `BRIDGE_ROUTES`。
CLI 对应 `action <操作名> --json '<参数 JSON>'`，也可用 `--file` 传参数，避免 shell 转义。

`conversation` 接受 `{sessionId,messages:[{role:"user",text:"用户原话"},{role:"assistant",text:"回复"}]}`，
复用 DSH 当前模型进行一次总结。外部软件需要在自己的回合结束时调用；桥接不会自动监听其他软件。
本地来源的角色标记由发送方负责准确提供，忆泡仍要求自动记忆有用户原话依据。

其他平台可以直接读取发现文件，用 `Authorization: Bearer <token>` 请求该地址上的原 `/memory-bubble/api/*`。
也可给 MCP/CLI 显式传 `--url <地址> --token <令牌>`。令牌不要放进提示词或分享。
桥接只监听 `127.0.0.1`，不开放浏览器跨域；不需要修改 DSH 原有 GUI 端口。

没有在线桥接时，文件模式继续可用，写命令在读改写全过程持有独占锁；损坏的数据文件直接报错，不覆盖为空库。
在线连接出错不会退回文件写入。正常退出会释放锁；进程崩溃后如遗留 `state.json.lock`，
先核对其中 `owner.json` 的 PID 已停止，再清理该锁和同目录过期的 `bridge.json`，不能在运行中删除。
手工编辑 state.json 和旧版适配器不受此锁约束，应先停止 DSH。

## 纯对话端：无需 MCP、插件或工具调用

```bash
node interop/cli.mjs chat --session S1 --out memory-chat.md
# 将文件完整粘贴或上传到纯对话端。对话结束后，请它返回更新后的记忆包 JSON。
node interop/cli.mjs import --file returned-bundle.json --session S2 --apply
```

`chat` 包含使用说明和本会话的节点、关系，支持只靠复制粘贴继承。
`--session S2` 显式加入目标会话；`--apply` 明确允许更新已有节点和关系，不加则仍按原合并语义导入。
继承复用节点身份；编辑共享节点会在所有归属会话生效，清空一个会话只解除它的归属。
不把回传 JSON 中缺少的条目当作删除命令；删除需要显式 `forget`。
纯对话端只能在自己的上下文使用记忆，不能自动同步或调用 DSH；导回由用户或有文件权限的软件执行。
MCP 也提供 `memory://chat` 资源和带记忆内容的使用提示词。

## 一张图

```
                         ┌──────────────────────────────┐
                         │  <profile>/.memory-bubble/   │
  DSH 插件 ──自动总结──▶ │  state.json（唯一真相）       │ ◀── 你手动编辑/备份
  （记忆气泡 UI）         └──────────┬───────────────────┘
                                    │ 同一份文件
        ┌───────────────┬───────────┼───────────────┬────────────────┐
        ▼               ▼           ▼               ▼                ▼
   MCP stdio        CLI 命令       HTTP API      记忆包文件      便携提示词
 (Claude Desktop  (node interop/  (DSH 运行时)   (bundle.json)   (PORTABLE_PROMPT)
  / Cursor)        cli.mjs)                                       
```

## 0. 数据在哪

| 环境 | 默认位置 | 覆盖方式 |
| --- | --- | --- |
| DSH 插件 | `<profile>/.memory-bubble/state.json`（如 `C:\Users\<你>\.dsh\profiles\desktop\.memory-bubble\state.json`） | 插件设置里显示完整路径 |
| CLI / MCP | 自动探测 DSH profile；也可显式指定 | `--data <path>` 或环境变量 `MEMORY_BUBBLE_STATE` |

- 备份：直接复制 `state.json`；插件每次写入会留一份 `state.json.bak`。
- 迁移：换电脑时把 `state.json` 放进新 profile 的同名目录即可。

## 1. MCP（Claude Desktop / Cursor / 任何 MCP 客户端）

忆泡自带一个 stdio MCP 服务器：`interop/mcp-server.mjs`。

```bash
node interop/mcp-server.mjs --data "<你的>/state.json"
# 可选：--session <id> 指定默认会话；--read-only 禁止写入
```

**Claude Desktop**（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "memory-bubble": {
      "command": "node",
      "args": ["D:/path/to/memory-bubble/interop/mcp-server.mjs", "--data", "C:/Users/<你>/.dsh/profiles/desktop/.memory-bubble/state.json"]
    }
  }
}
```

**Cursor**（`~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`）配置结构相同。

服务器能力：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| tools | `memory_search` | 检索记忆点（标题/摘要/关键词） |
| tools | `memory_brief` | 读稳定记忆简报 |
| tools | `memory_remember` | 写入一条新记忆（`--read-only` 时禁用） |
| tools | `memory_link` | 连接两条记忆、标冲突 |
| tools | `memory_forget` | 删除记忆（`--read-only` 时禁用） |
| resources | `memory://graph` | 完整记忆图 JSON |
| resources | `memory://digest` | 稳定简报文本 |
| resources | `memory://prompt` | 跨 AI 使用说明 |
| prompts | `memory-bubble-usage` | 一键把使用说明注入对话 |

`initialize` 返回的 `instructions` 里已经带了便携提示词，Claude 连上就会知道怎么用这份记忆。

## 2. CLI（零依赖，适合脚本 / 其他 AI 的 shell 工具）

```bash
node interop/cli.mjs list                          # 列出全部记忆
node interop/cli.mjs search --query "在学 Rust"     # 检索
node interop/cli.mjs brief                         # 打印稳定简报
node interop/cli.mjs export --out graph.json       # 导出可继承的图
node interop/cli.mjs bundle --out bundle.json      # 导出记忆包（图+简报+提示词+工具）
node interop/cli.mjs import --file bundle.json     # 合并一份记忆包 / 图
node interop/cli.mjs remember --title "在学 Rust" --summary "用具体例子讲" --importance 78
node interop/cli.mjs forget --id n_xxx
```

给其他 AI 用的时候，让它执行 `node interop/cli.mjs brief`（或 `search`）就能拿到记忆，不需要任何 SDK。

## 3. HTTP API（DSH 运行中，给局域网 / 其他进程）

默认前缀 `/memory-bubble/api`。原接口仍由 DSH 的 `webServer` 提供；开发版额外提供上述带令牌的本机桥接端口。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/interop` | 能力清单：数据文件位置、可用工具、便携提示词、各通道入口 |
| GET | `/ai/bundle?sessionId=` | 打包 `memory-bubble-bundle`（图+简报+提示词+工具） |
| GET | `/ai/prompt` | 纯文本便携提示词，可直接贴进 system prompt |
| GET | `/graph?sessionId=&scope=all\|session` | 图谱（含布局） |
| POST | `/import` | 合并图 / 记忆包（`{graph}` 或 bundle） |

例：

```bash
curl http://127.0.0.1:<DSH端口>/memory-bubble/api/ai/bundle > bundle.json
```

## 4. 记忆包文件（最通用的“继承”方式）

`bundle.json` 里包含：

- `graph`：全部记忆点与连线（`memory-bubble/v1` 结构）
- `digest`：当前会话的稳定简报
- `prompt`：便携使用说明（贴进别的 AI 的 system prompt）
- `tools`：5 个工具的 JSON-Schema，供 function calling 转写

Schema：`schema/memory-bubble-bundle-v1.schema.json`、`schema/memory-bubble-v1.schema.json`。

**换 AI / 换机器 / 换对话的三种用法**：

1. 新 AI 读懂：把 `bundle.json` 放在它可读的位置，让它用 CLI 读 `brief` / `search`；
2. 直接继承：把 `prompt` 内容贴进它的 system prompt，把 `digest` 当第一条上下文；
3. 反向导入：在设置页「导入记忆包」、或 `cli.mjs import`、或 `POST /import`，同 id 的记忆会合并去重。

## 5. 便携提示词（不用任何工具也能用）

`PORTABLE_PROMPT` 全文见 `plugin/lib/core.js` 或 `GET /ai/prompt`，核心规则：

1. 只采用与当前问题相关的记忆；与用户最新说法冲突时以最新为准，并提醒该记忆可能过期；
2. `禁忌` 优先遵守，`偏好` 影响表达，`计划/目标` 用于主动提醒；
3. 不复述整段记忆，记忆里没有的不编造；
4. 用户说“忘掉”时删除对应节点（有写权限时）；
5. 不确定时向用户确认，不拿记忆推断隐私。

## 6. 安全与隐私

- **本地优先**：默认使用本机桥接或指定 JSON；外部对话总结会使用 DSH 配置的模型服务。
- **默认只读**：MCP 加 `--read-only` 后 `remember/link/forget` 返回错误；CLI 的写命令需你显式执行。
- **可审计**：`state.json` 是纯 JSON，每次写入留 `.bak`；插件里可导出 / 撤销上一批总结。
- **换 AI 前想清楚**：记忆里可能包含私人信息，导入别的 AI 前先看一眼 `brief`。

## 7. 版本与兼容

| 格式 | 当前版本 | 说明 |
| --- | --- | --- |
| `memory-bubble/v1` | v1 | 图导出/导入；带 `schema` 字段与 `graph` 信封 |
| `memory-bubble-bundle` | v1 | 记忆包 |
| state.json | `stateVersion: 2` | 插件内部状态 |

其他宿主（浏览器、Tauri、MCP）想接入，只需实现 `memory-bubble/v1` 的导入导出，插件即可与其互操作。

## 8. 自检

```bash
node interop/dev/test-interop.mjs   # 5 项：CLI / bundle schema / MCP 全套
node plugin/dev/test-host.mjs       # 13 项：插件 host 全链路（含 /interop、/ai/bundle）
node plugin/dev/test-core.mjs       # 12 项：纯函数
node plugin/dev/test-client.mjs     # 3 项：客户端 slot 注册
```
