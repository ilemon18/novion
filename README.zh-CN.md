<p align="center">
  <img src="docs/logo.png" width="110" alt="Novion" />
</p>

<h1 align="center">Novion</h1>

<p align="center">
  本地优先的笔记应用，支持 Notion 与 iCloud 同步。
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <a href="https://github.com/ilemon18/novion/releases">下载</a>
</p>

<p align="center">
  <img src="docs/screenshots/preview.png" alt="Novion 界面预览" />
</p>

## 特性

### 轻量快速
基于 Tauri，启动快，无需内置 Chromium。

### 本地优先
无需账号，离线可用，数据以普通 JSON 文件保存。

### iCloud 同步
通过 iCloud 云盘，在多台 Mac 间同步笔记。

### Notion 同步
从 Novion 到 Notion 的单向镜像：本地始终为准，「已归档」单独放在同名文件夹里，本地删除的文档会从 Notion 移除。同步目标被移入 Notion 回收站时会自动恢复；恢复不了就重建一个新页面并全量重推。强制推送会按本地重写所有页面。

镜像规则与恢复行为见 [docs/notion.md](docs/notion.md)。

### 局域网共享
在同一局域网内共享工作区。文件始终保存在主机上，另一台电脑通过配对和 TLS 加密连接直接编辑。默认关闭。

设置、安全说明与限制见 [docs/sharing.md](docs/sharing.md)。

### MCP
可选启动仅监听本机的 MCP 服务，让 AI 客户端搜索、读取和编辑笔记。默认无需令牌，可在设置中开启访问令牌验证。

客户端配置与完整工具说明见 [docs/mcp.md](docs/mcp.md)。

### 专注写作
简洁的写作空间，支持浅色、深色与多种主题配色。

### 搜索与快捷键
全文搜索、命令面板与页内查找，快速定位内容。

## 文档

- [开发](docs/development.md)
- [局域网共享](docs/sharing.md)
- [MCP 服务](docs/mcp.md)
