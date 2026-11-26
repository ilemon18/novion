<p align="center">
  <img src="docs/logo.png" width="110" alt="Novion" />
</p>

<h1 align="center">Novion</h1>

<p align="center">
  Local-first notes. Sync with Notion and iCloud.
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/ilemon18/novion/releases">Download</a>
</p>

<p align="center">
  <img src="docs/screenshots/preview.png" alt="Novion screenshot" />
</p>

## Features

### Lightweight
Built with Tauri. Fast startup, no bundled Chromium.

### Local-first
Write offline, no account needed. Plain JSON files you own.

### iCloud sync
Keep notes in sync across Macs with iCloud Drive.

### Notion sync
Incremental, one-way pushes from Novion to Notion.

### LAN sharing
Share a workspace with another Novion on the same network. The host keeps the files; the connected computer edits them directly over a paired, TLS-protected connection. Off by default.

See [docs/sharing.md](docs/sharing.md) for setup, security, and limitations.

### MCP
Let local AI clients search, read and edit notes through an optional MCP server that listens on your computer only. No token is required by default; enable token authentication in settings when needed.

See [docs/mcp.md](docs/mcp.md) for client setup and the full tool reference.

### Distraction-free
A clean writing space with light and dark modes and built-in color themes.

### Search & shortcuts
Full-text search, a command palette, and in-note find.

## Documentation

- [Development](docs/development.md)
- [LAN sharing](docs/sharing.md)
- [MCP server](docs/mcp.md)
