# MCP server

Novion can run an optional Model Context Protocol (MCP) server so a local AI
client can search, read, create, and edit notes in the active workspace.

The listener is local-only. It binds to `127.0.0.1`, does not start with
Novion, and stops when you press **Stop server** or quit the app. It is
available only while Novion is running.

## Overview

- The server works on the workspace that is currently open, including an iCloud
  workspace.
- It uses MCP Streamable HTTP and returns JSON responses.
- It advertises **tools only** — there are no MCP resources or prompts.
- Every request needs the bearer token shown in Novion.
- The server is not exposed over the LAN. Another computer cannot connect to
  this MCP endpoint directly.

## Quick start

1. Open **Settings → MCP**.
2. Choose a port and press **Save port** while the server is stopped.
3. Press **Start server**.
4. Press **Copy connection details**, or copy the endpoint and token separately.
5. Add the endpoint and `Authorization` header to an MCP client that supports
   Streamable HTTP and custom HTTP headers.

The default endpoint is:

```text
http://127.0.0.1:39261/mcp
```

Send the token as a bearer credential:

```http
Authorization: Bearer <token shown in Novion>
```

Port rules:

- Allowed range: `1024–65535`.
- Default: `39261`.
- The port can only be changed while the server is stopped.

Token rules:

- The token is created the first time MCP settings are opened and is stored in
  Novion's application config.
- It remains stable between launches, so saved client configurations keep
  working.
- **Rotate token** is available only while the server is stopped. Existing
  clients immediately receive `401 Unauthorized` after a rotation.
- **Copy connection details** copies the endpoint and the `Authorization` line.

## Client configuration

Client formats vary. The important parts are the Streamable HTTP URL and the
request header. A common JSON shape looks like this:

```json
{
  "mcpServers": {
    "novion": {
      "url": "http://127.0.0.1:39261/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

Some clients use a different key such as `serverUrl`, require a transport field
such as `"type": "http"`, or ask for the URL and headers in separate UI fields.
Use the endpoint from Novion and add the bearer header using that client's
supported setting.

## Security model

- The listener only binds to `127.0.0.1`; it never listens on a LAN interface.
- The bearer token is compared in constant time. A missing or incorrect token
  returns `401 Unauthorized`.
- If a request includes an `Origin` header, it must be a loopback origin using
  `http`, `https`, or `tauri`, with one of these hosts:
  - `localhost`
  - `tauri.localhost`
  - `127.0.0.1`
  - `[::1]`
  Other origins are rejected with `403 Forbidden`.
- Treat the token like any other local secret. Do not commit it, paste it into a
  public issue, or share it with another user.
- MCP settings apply to the local workspace. While connected to a remote
  workspace through **Settings → Sharing**, the MCP page is locked until you
  disconnect.

## Tool reference

All tools return JSON text content. Note that tool argument names use
snake_case, while returned object fields use camelCase.

| Tool | Arguments | Returns / behavior |
| --- | --- | --- |
| `list_notes` | `include_trash` (bool, default `false`), `parent_id` (optional folder id), `root_only` (bool, default `false`) | Note summaries with `id`, `title`, `parentId`, `path`, `updatedAt`, `revision`, and `trashed`. |
| `list_folders` | `parent_id` (optional folder id) | Active, non-system folders with `id`, `name`, `parentId`, and `path`. |
| `search_notes` | `query` (string) | Search hits with `id`, `title`, `snippet`, `titleMatch`, and `updatedAt`. |
| `get_note` | `note_id` | Note metadata plus `contentMarkdown` and a `revision` marker. |
| `create_note` | `title`, `content_markdown` (optional), `parent_id` (optional) | The new note's `id` and `revision`. |
| `update_note` | `note_id`, `expected_revision`, `title` (optional), `content_markdown` (optional) | The new `revision`. |
| `move_note` | `note_id`, `parent_id` (optional), `index` (optional) | `{ "moved": true }`. |
| `delete_note` | `note_id` | `{ "trashed": true }`; moves the note to Trash. |
| `restore_note` | `note_id` | `{ "restored": true }`; restores from Trash when possible. |

### `list_notes`

Lists notes in the active workspace. By default Trash is excluded.

- `parent_id` returns only direct children of that folder.
- `root_only: true` returns only notes at the workspace root. It is ignored
  when `parent_id` is supplied.
- `path` is the slash-separated folder path plus the note title.
- `updatedAt` is the latest known update time.
- `revision` is the value to pass to `update_note` after reading the note.

### `list_folders`

Lists folders that can be used as a `parent_id`. System folders such as Trash
and Completed are not returned, and folders inside Trash are excluded.

Use `parent_id` to list only direct child folders.

### `search_notes`

Searches note titles and bodies using Novion's search syntax. Trash is not
searched. See [Search syntax](#search-syntax) below.

### `get_note`

Returns:

```json
{
  "id": "d_...",
  "title": "Weekly plan",
  "createdAt": 1793774958391,
  "updatedAt": 1793774958391,
  "revision": 1793774958391,
  "contentMarkdown": "# Weekly plan\n\n..."
}
```

The `revision` value is opaque. Store it and pass it back to `update_note`; do
not calculate or guess a newer revision.

### `create_note`

Creates a note at the workspace root, or inside an existing folder when
`parent_id` is supplied.

- `title` is required.
- `content_markdown` is optional and defaults to an empty body.
- The folder id must come from `list_folders` (or another valid workspace
  folder id).

### `update_note`

Updates a note using its current revision.

- `expected_revision` is required.
- Supply `title`, `content_markdown`, or both. Supplying neither is an error.
- `content_markdown` replaces the **entire** body. It is not a patch or an
  append operation.
- If the note changed after `get_note`, the call is rejected and you must read
  the note again.
- A note in Trash cannot be updated. Run `restore_note` first.

### `move_note`

Moves a note to a folder or to the workspace root.

- Omit `parent_id` to move it to the root.
- `index` is a zero-based sibling position. Omit it to append.
- The target folder must already exist.

### `delete_note`

Moves a note to Novion's recoverable Trash. It does **not** permanently delete
the note.

### `restore_note`

Restores a trashed note, returning it to its previous folder when possible.

## Revision workflow

Use a read-modify-write cycle:

1. Call `get_note` and keep the returned `revision`.
2. Build the new Markdown body, or change the title.
3. Call `update_note` with `expected_revision` from step 1.
4. Keep the new `revision` if you plan another update.

If the revision is stale, the server returns an error instead of overwriting a
newer edit. Read the note again and repeat the change.

The same revision check protects updates from the Novion editor and from other
clients.

## Search syntax

`search_notes` accepts Novion's search query syntax:

- Plain terms search titles and bodies.
- `title:term` restricts a term to titles.
- `path:folder` restricts results to notes under a matching folder path.
- `updated:>7d`, `updated:<30d`, and `updated:7d` filter by update time.
- `updated:2025-01-01` filters by a specific date.
- `"quoted phrase"` searches for a phrase containing spaces.
- Filters and terms can be combined.

Examples:

```text
title:周报
path:项目 roadmap
updated:>7d meeting
"exact phrase"
```

An empty query returns the most recently updated notes, up to 24 results.

## Markdown and images

Note bodies use Markdown. Common Markdown structures round-trip through
Novion's converter, including:

- headings, paragraphs, and horizontal rules
- bullet, ordered, and task lists
- blockquotes, code blocks, and tables
- links and images
- inline and block math
- callouts, toggles, and wiki links

Images use workspace-relative asset paths, for example:

```markdown
![Diagram](assets/img_1a2b.png)
```

The MCP server does not provide an image upload tool. It can only reference
assets that already exist in the workspace. `get_note` returns Markdown that can
be passed directly back to `update_note`.

## What MCP cannot do

The MCP surface is intentionally limited:

- It can list folders but cannot create, rename, move, or delete them.
- It cannot permanently delete a note or empty Trash.
- It does not expose version history, import/export, Notion sync, storage
  switching, or application updates.
- It does not upload or manage assets.
- It does not provide MCP resources or prompts.
- It is not a LAN sharing service. Remote devices cannot connect to this MCP
  endpoint directly.

Use the Novion UI for those operations.

## Troubleshooting

- **`401 Unauthorized`:** the token is missing, incorrect, or was rotated.
  Copy the current token from **Settings → MCP**.
- **`403 Forbidden`:** the request came from a non-loopback `Origin`. Use a
  local client, or remove the invalid origin header.
- **Server will not start:** the port may already be in use. Stop the server,
  choose another port in the `1024–65535` range, and start again.
- **MCP settings are locked:** the app is connected to a remote workspace.
  Disconnect in **Settings → Sharing** first.
- **Update rejected as stale:** call `get_note` again and use its new
  `revision`.
- **Cannot update a note:** the note is in Trash. Call `restore_note` first.
- **Connection refused:** make sure Novion is running and the server has been
  started from **Settings → MCP**. The service does not auto-start.

## See also

- [Development](development.md) — local development and test commands.
- [LAN sharing](sharing.md) — sharing a workspace between computers.
