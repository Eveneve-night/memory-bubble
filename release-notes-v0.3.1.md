## 忆泡 v0.3.1 · 浮窗化 + 默认关闭 + 工具 schema 修复

> 这一版主要修两件事：**不再接管界面**（改成侧栏小窗口、默认关闭），以及**修掉工具注册的 schema 报错**（模型侧 `parameters` 校验失败）。

### 插件（下载 `dsh-memory-bubble-v0.3.1.zip`）

- 🪟 浮窗化：侧栏「忆泡」图标打开可拖动 / 可缩放的小窗口，窗口内 × 关闭；位置和尺寸会记住
- 🌙 默认关闭：装好不自动打开、不读对话、不调模型；首次是空图，点图标才出现
- 🚪 侧栏入口 `order: 900`，排在其它插件之后，不挤乱已装插件
- 🧰 修复 5 个工具的 `parameters`：统一为标准 JSON Schema（顶层 `type: 'object'` + `properties` + `required`），修掉 memory_brief 等工具在模型侧的参数校验报错
- 🧪 自检：core 13/13、plugin 14/14（含"工具 schema 形状"断言）

### 互操作（下载 `memory-bubble-interop-v0.3.1.zip`）

- MCP / CLI / HTTP / 记忆包四条通道不变，格式仍对齐仓库根目录 `schema/`

### 安装

1. 下载 zip，解压得到 `dsh-memory-bubble/`
2. 用 DSH 的插件管理器安装该目录，或在 profile 里 `pnpm add "file:<path>/dsh-memory-bubble"`
3. 刷新 Web GUI → 侧栏出现「忆泡」图标 → 点开小窗口，首次为空图

### 验证（本机实测）

- 安装版本 0.3.1，loader 条目 `disabled: false`
- `/memory-bubble/api/health` 返回 `ok:true, firstRun:true, auto:false, totalNodes:0, sessions:2`（从零开始、不读对话）
- 安装包内 `index.js` 含 5 个 `type: 'object'` 工具 schema；`client.js` 含浮窗代码
