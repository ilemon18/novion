# MCP server

Novion can run an optional Model Context Protocol server so a local AI client can work with the active Novion workspace. The server is stopped when Novion launches and listens only on `127.0.0.1` after you start it from **Settings → MCP**.

## Connect a client

1. Open **Settings → MCP** in Novion.
2. Choose a port and save it while the server is stopped.
3. Start the server.
4. Copy the connection details and add them to an MCP client that supports Streamable HTTP and custom HTTP headers.

The default endpoint is `http://127.0.0.1:39261/mcp`. Send the displayed token as a bearer credential:

```http
Authorization: Bearer <token shown in Novion>
```

Client configuration formats vary. Use the endpoint as the Streamable HTTP URL and add the `Authorization` header using the client's supported header setting. The token is stored in Novion's application config so it remains stable between launches. Stop the service before rotating the token or changing the port.

## Available tools

| Tool | Purpose |
| --- | --- |
| `list_notes` | List notes and their folder paths; optionally include Trash or filter by parent folder. |
| `list_folders` | List active folders and their ids for use as parent ids. |
| `search_notes` | Search titles and bodies using Novion search syntax. |
| `get_note` | Read a note as Markdown and return its revision marker. |
| `create_note` | Create a Markdown note at the workspace root or inside an existing folder. |
| `update_note` | Replace the title and/or body. Pass the revision from `get_note`; stale edits are rejected. |
| `move_note` | Move a note to a folder or the workspace root. |
| `delete_note` | Move a note to Trash, where it can still be restored in Novion. |
| `restore_note` | Restore a note from Trash. |

The server cannot permanently delete notes. Use Novion's Trash controls for permanent deletion.
