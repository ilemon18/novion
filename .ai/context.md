# Novion - AI Context

> Quick reference for AI agents. For full project docs, see [../README.md](../README.md)

## Project Overview

**Tech**: Tauri 2 + React 18 + Rust | **Type**: Local-first note-taking app (Notion-like blocks)

**Stack**: Zustand + Tailwind v4 + TipTap/ProseMirror (frontend) | tokio async fs (backend)

## File Navigation Map

| What | Where |
|------|-------|
| **Sidebar UI** | `src/components/sidebar/Sidebar.tsx`, `TreeList.tsx`, `TreeRow.tsx` |
| **Sidebar menus** | `src/components/sidebar/node-actions.ts` (one action list for `⋮` + right-click), `NodeContextMenu.tsx`, `src/components/ui/float-menu.tsx` (fixed-position, no popper) |
| **New-node targets** | `src/lib/tree-targets.ts` (system groups / trash / archive never host new nodes) |
| **In-app updates** | `src-tauri/src/update.rs` (GitHub Releases check/download/install), `src/store/update.ts` (state machine), `src/lib/update-view.ts` (one status → label/icon/tone mapping, shared by both buttons), `src/components/editor/UpdateButton.tsx` |
| **Editor UI** | `src/components/editor/DocView.tsx`, `DocEditor.tsx`, `DocTitle.tsx` |
| **Slash menu** | `src/components/editor/SlashMenu.tsx`, `extensions/slash-command.ts` |
| **Block types** | `src/components/editor/slash-items.ts` (23 types) |
| **Inline formatting** | `src/components/editor/EditorBubbleMenu.tsx` (portal + placement), `bubble/` — `body.tsx` (composition), `parts.tsx` (ToolButton/Panel/Sep), `blocks.tsx`, `colors.tsx`, `link.tsx`, `table.tsx`, `signature.ts` (re-render fingerprint) |
| **Custom nodes** | `src/components/editor/extensions/` — `callout`, `toggle`, `toc`, `bookmark`, `math`, `image` (resize/caption), `code-block` (language picker) |
| **Shortcuts** | `src/lib/keybindings.ts` (single registry; `shortcutHint()` feeds the palette) |
| **Command palette** | `src/components/CommandPalette.tsx`, `src/lib/commands.ts` |
| **Find / replace** | `src/components/editor/FindBar.tsx` |
| **Version history** | `src/components/editor/VersionHistoryDialog.tsx`, `src-tauri/src/history.rs` |
| **Image handling** | `src/components/editor/image-insert.ts` (paste/drop → asset://) |
| **Content transform** | `src/components/editor/doc-content.ts` (assets/... ↔ asset:// URL) |
| **Save queue** | `src/lib/save-scheduler.ts` (debounce, single-flight, retry) |
| **Workspace state** | `src/store/workspace.ts` (tree, CRUD actions) |
| **UI state** | `src/store/ui.ts` (theme mode + palette, interface font (`--font-ui`, shell + document), body size, feature flags, sidebar width, dialogs) |
| **IPC layer** | `src/lib/tauri.ts` (typed invoke wrappers) |
| **Data models** | `src-tauri/src/models.rs` (camelCase serialization) |
| **Rust commands** | `src-tauri/src/lib.rs` (registration) |
| **Path logic** | `src-tauri/src/paths.rs` (~/Documents/Novion, id validation, path traversal protection) |
| **Workspace ops** | `src-tauri/src/workspace.rs` (workspace.json CRUD, single writer) |
| **Doc ops** | `src-tauri/src/docs.rs` (read/save document files) |
| **Asset ops** | `src-tauri/src/assets.rs` (save/delete images) |
| **Notion sync** | `src-tauri/src/notion.rs` (token, HTTP, errors), `notion_blocks.rs` (TipTap → Notion), `notion_sync.rs` (mirror run) |
| **Notion UI** | `src/components/settings/NotionSection.tsx`, `src/store/notion.ts` |
| **Atomic writes** | `src-tauri/src/atomic.rs` (temp → fsync → rename) |
| **Error types** | `src-tauri/src/error.rs` (structured {code, message}) |

## Core Rules

### Frontend
- **State**: Zustand only, NO editor state in store
- **Style**: Tailwind CSS v4 only, NO inline styles or CSS-in-JS
- **Editor**: TipTap instance in `useRef`, `shouldRerenderOnTransaction: false`
- **Performance**: Input path must not trigger React re-renders

### Backend
- **Async**: All file ops use `tokio::fs`, all commands are `async`
- **Atomicity**: All writes via `atomic.rs` (temp → flush+sync_all → rename)
- **Path safety**: NO hardcoded paths, derive from `document_dir()`, validate ids
- **Errors**: Always `Result<T, AppError>`, NO `unwrap()`/`expect()`
- **Serialization**: `#[serde(rename_all = "camelCase")]` for JS interop

### IPC Pattern
```rust
// lib.rs - register command
.invoke_handler(tauri::generate_handler![
    commands::my_command,
])

// Implementation in workspace.rs/docs.rs/assets.rs
pub async fn my_command(param: String) -> Result<Data, AppError> {
    // tokio::fs operations
}
```

```typescript
// tauri.ts - type-safe wrapper
export async function myCommand(param: string): Promise<Data> {
  return invoke('my_command', { param });
}
```

## Common Tasks

### Add Rust Command
1. Backend: `workspace.rs`/`docs.rs`/`assets.rs` → implement function
2. Register: `lib.rs` → add to `invoke_handler![...]`
3. Model: `models.rs` → define struct if needed
4. Frontend: `lib/tauri.ts` → add typed wrapper
5. State: `store/workspace.ts` → add action if needed

### Add Block Type
1. `slash-items.ts` → add to `SLASH_ITEMS` array
2. `slash-command.ts` → handle insertion logic if custom
3. TipTap extension → add to `useEditor({ extensions: [...] })` if new node type

### Add Asset Type
1. `image-insert.ts` → add MIME handling
2. `assets.rs` → add file extension validation
3. `doc-content.ts` → add URL transform if needed

## Critical Gotchas

### Editor Performance
- **NEVER** put TipTap editor instance in Zustand store (causes massive re-renders)
- **NEVER** set `shouldRerenderOnTransaction: true` (input lag)
- Editor updates only touch: local ref + save scheduler

### Save Scheduler
- **Debounce**: 600ms after last edit, max 2s forced flush
- **Single-flight**: Same doc writes are strictly serialized (no race conditions)
- **Snapshot**: Saves the content at flush time, not current content (no cross-doc contamination)

### Data Integrity
- **workspace.json**: Single source of truth, atomic rewrites only
- **Document files**: Must match workspace nodes, use atomic writes
- **Path traversal**: All paths validated in `paths.rs`, never trust input

### macOS
- **Path**: `~/Documents/Novion` is standard, created on first run
- **Asset protocol**: `asset://` URL requires Tauri scope config in `tauri.conf.json`

## Architecture

```
React Components → Zustand Store → lib/tauri.ts
         ↓ Tauri IPC (JSON)
lib.rs → workspace/docs/assets.rs
         ↓
    tokio::fs (atomic writes)
         ↓
~/Documents/Novion/{workspace.json, docs/*.json, assets/*}
```

**Example flow** (save document):
`DocEditor` → `onUpdate` → `save-scheduler` (debounce 600ms) → `tauri.saveDoc()` → `commands::save_doc()` → `docs::save_doc()` (atomic write) → disk

**Example flow** (create folder):
`Sidebar` → `workspace.createFolder()` → `tauri.createFolder()` → `commands::create_folder()` → `workspace::create_folder()` (read → modify → atomic write workspace.json) → return updated workspace → store.apply()

## Data Format

**workspace.json** (flat array + parentId + order):
```json
{
  "version": 1,
  "updatedAt": 1793774958391,
  "nodes": [
    { "id": "d_...", "kind": "doc", "name": "Title", "parentId": null, "order": 0, ... }
  ]
}
```

**docs/<id>.json** (TipTap JSON):
```json
{
  "id": "d_...",
  "title": "Title",
  "content": { "type": "doc", "content": [/* ProseMirror blocks */] }
}
```

**Image paths**: Stored as `assets/img_xxx.png`, loaded as `asset://localhost/assets/img_xxx.png`

## Dependencies

**Runtime**: None (standalone .app)
**Build**: Node 18+, pnpm, Rust 1.70+, Xcode CLI (macOS)
**Key libs**: zustand, @tiptap/react, lucide-react (frontend) | tokio, serde, tauri (backend)

## Debug

**Frontend**: DevTools in `pnpm app:dev`
**Backend**: `eprintln!("[DEBUG] {:?}", var);` or `dbg!(var);`
**IPC**: Log in `tauri.ts` wrapper
**Tests**: `cd src-tauri && cargo test`

**Packaging**: only the debug build is shipped, and it always lands in `release/`:
`Novion-debug.app` on macOS (`pnpm app:build`), `Novion-debug-setup.exe` on Windows
(`pnpm app:build:win` — NSIS, per-user). Both scripts end in `scripts/collect-app.mjs`, which
copies the bundle out of `src-tauri/target/debug/bundle/` and replaces the previous copy. No
cross-compile: each platform builds its own artifact. Never open the app from
`src-tauri/target/` directly.

**Updates**: `update_check` first reads the `latest.json` release asset
(`releases/latest/download/latest.json`, written by `scripts/make-latest-json.mjs` in the
release job) — served by the release CDN, so it costs **no** GitHub API quota. Only when a
release has no manifest does it fall back to `api.github.com/repos/ilemon18/novion/releases/latest`
(60 req/h/IP unauthenticated). No release yet ⇒ `hasRelease: false`, so the header button stays
hidden. Assets are `novion-macos-X.Y.Z.dmg` / `novion-win-X.Y.Z.exe`; `latest.json` also carries
size + SHA-256, which `update_download` verifies before the bundle can be installed. The
repository must be public — an unauthenticated request cannot read a private repo's releases.
`latest.json` is never committed: it describes one specific build.

**Installing an update** (`update_install`) never guesses. It writes `update-pending.json` (the
version it asked for) and starts a detached helper — `/bin/sh` on macOS, PowerShell on Windows —
which waits for this process to exit, verifies the unpacked bundle's version, swaps it in, logs
every step to `update.log` (`app_log_dir`), and reopens the app, including reopening the *old*
build when any step fails. `update_startup_report` reads that marker on the next launch, so an
installer that ran and changed nothing says so instead of looking like nothing happened.
macOS installs into the running bundle when its folder is writable, otherwise into `/Applications`
then `~/Applications` — an app opened from the downloaded dmg (a read-only volume, or a Gatekeeper
`AppTranslocation` path) updates itself instead of falling back to "show in Finder"; the stale copy
moves to the Trash. Windows runs the NSIS installer through a generated `.bat` (`/S /D=<dir>`, last
and unquoted), waits for it, and only then relaunches. A build under `src-tauri/target/` is never
replaced by a release bundle. The UI has exactly these states and one button each:
`检查更新 → 下载更新 → 42% → 重启更新 → 正在安装…`, plus `重试` on failure and an
「更新日志」link.

## Performance Notes

- Vite code-splitting: TipTap (~143KB gz) loads only when opening first doc
- Virtual scrolling: Sidebar activates at 200+ nodes
- Lazy loading: Documents load on-demand, not at app start
- Zero I/O input: Typing doesn't touch filesystem until debounce fires

---

**Last updated**: 2025-01-15
