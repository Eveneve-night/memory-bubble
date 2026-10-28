# 忆泡 v0.3.3 — 侧栏图标可靠地重新打开窗口

## 修复

- **关闭浮窗后点左侧栏「忆泡」图标打不开**：入口从只监听 `click` 改为**按下即切换**（`pointerdown`，主键），不再受上层拖拽、焦点抢占或指针偏移影响。
- 入口按钮加上 `draggable:false`、`touch-action:manipulation`、`pointer-events:auto` 与层级修正，避免被相邻元素遮挡或被当成可拖拽元素。
- 键盘 Enter / 空格仍可打开与收起（无障碍可用）。
- 窗口内容挂载后监听自身尺寸变化，拖动四边/四角改大小时图像一定按新比例重排。

## 自测

- core 13/13、plugin（宿主+客户端）14/14、interop 5/5，`node --check` 通过。
- 已通过 `plugin_manager install_bundle` 真机安装 v0.3.3。

## 安装

- 插件包：`dsh-memory-bubble-v0.3.3.zip`（解压得 `dsh-memory-bubble/`）或 `dsh-memory-bubble-0.3.3.tgz`
- 用 `plugin_manager` 的 `install_bundle` 指向解压目录或 `.tgz` 绝对路径；装完**刷新页面**，左侧栏「忆泡」图标点一下即可打开浮窗。
