# 忆泡 v0.3.5 — 外部软件在线桥接

## 这一版做了什么

以前 MCP / CLI 是**直接读写** `state.json` 的「冷模式」：外部软件写一条记忆，DSH 里的泡泡图不会动；两边同时写还可能互相覆盖；`extract`、`conversation`、`tray`、`session` 这些必须靠运行中插件的操作根本做不了。

v0.3.5 给插件加了一个**只监听本机、带令牌的桥接服务**，外部适配器（MCP / CLI / 你自己写的脚本）启动时自动发现它，之后所有读写都走运行中的插件——**一份内存状态、同一套处理函数、改完立刻出现在 UI 里**。

## 工作方式

```
DSH 进程
 └─ 忆泡插件：启动时取独占锁 → startBridge()
      ├─ HTTP 127.0.0.1:<随机端口>（每次启动换端口/令牌）
      ├─ 写 <profile>/.memory-bubble/bridge.json（0600）
      │    { url, token, pid, stateFile }
      └─ /memory-bubble/api/* → 插件原有 handler
MCP / CLI：读 bridge.json → 校验 stateFile → 带 Bearer 调用
退出：关端口 + 删 bridge.json + 释放锁
```

- 只监听 `127.0.0.1`，拒绝带 `Origin` 的浏览器请求，令牌不放日志/提示词；
- 没有可用桥接时自动退回**离线文件模式**（写操作持 `state.json.lock/` 独占锁，锁内记录 `owner.json` 的 PID）；
- 在线连接出错**不会**悄悄回退到文件写入，避免两边各写一份。

## 在线模式多出来的能力

MCP 保留原有 5 个工具（`memory_search / brief / remember / link / forget`），在线时增加统一入口 `memory_action { operation, params }`，共 23 个操作：

`health / interop / graph / bundle / prompt / chat`（读）、`remember / edit / forget / edge / unlink / extract / conversation / rollback / tray / session / carry / clear / import / export / config / configure / batches`（写或跑插件逻辑）。

几个关键点：

- **`extract`**：外部软件可触发一次「用 DSH 当前模型总结」；
- **`conversation`**：把外部对话 `[{role:"user",text:…},{role:"assistant",text:…}]` 交给忆泡总结成记忆（不会自动监听其他软件，需要对方回合结束时主动调用）；
- **`carry`**：把 S1 的记忆归属带到 S2（`/session/attach`）；
- **`edit / forget / edge / unlink / tray / session / clear`**：改动即时反映到 UI；
- **`graph / bundle / chat / prompt`**：拿实时图谱、记忆包、纯对话粘贴卡。

CLI 对应：`node interop/cli.mjs action <operation> --json '<params>'`。

## 离线文件模式的边界

- 支持：`list / bundle / export / chat / carry / import` 和 5 个工具；
- 不支持：`extract / conversation / edit / forget / tray / session / clear` 等，会明确报 `requires a running DSH plugin`；
- 插件运行期间持有 `state.json.lock`，**手工编辑 state.json 或旧版适配器需要先停 DSH**；
- 进程崩溃留下的锁：先确认 `owner.json` 里 PID 已停止，再删锁和过期的 `bridge.json`。

## 兼容性与升级

- **插件和 `interop/` 适配器必须一起升级**；旧发布包（≤ v0.3.4）不含桥接与独占锁；
- 新版适配器在找不到桥接时仍能离线工作，所以升级顺序不强制；
- 本轮不改标题栏、窗口布局、缩放与冲突评分。

## 安装

- 下载 `dsh-memory-bubble-v0.3.5.zip` 解压即得 `dsh-memory-bubble/`；或直接安装 `dsh-memory-bubble-0.3.5.tgz`（DSH 插件管理器 `install_bundle` 接受绝对路径或下载 URL）；
- 安装后刷新页面 / 重启 DSH，侧栏出现「忆泡」；
- 升级已有安装后也建议重启 DSH，让加载器换到新包并重新建立桥接文件。

## 自测（main 分支）

- core 13/13、plugin（宿主+客户端）15/15、layout 3/3（300 气泡无重叠/越界）、interop 6/6
- `node --check` 通过；宿主动态 `import` 导出 `apply/inject/name` 正常；`package.json` 的 `exports`、`dsh.bundle.patch`、`dsh.client` 完整
- 桥接用例：启动/鉴权/拒绝 Origin/路由映射/退出清理；离线：独占锁、报错不回退

## 备注

- `bridge.json` 权限 0600，令牌每次 DSH 启动重新生成；**不要把令牌贴进提示词或分享**；
- 远程/云端 AI 无法直接访问本机桥接，仍请用 `chat` 记忆包复制粘贴，或由本机客户端代为调用。
