# LAN sharing

Novion can expose one computer's active workspace to another Novion on the
same local network.

This is a **host-authoritative remote workspace**:

- The host keeps the real workspace files.
- The connected computer sends read and write operations over the LAN.
- The client does not keep a second copy of the workspace.
- The client cannot work offline while connected.
- It is shared access, not real-time co-editing.

The same computer can share its own workspace and connect to another host at
the same time.

## Defaults and requirements

- Sharing is **off by default**. Novion does not open a LAN port until you start
  sharing in **Settings → Sharing**.
- Default port: `39262`.
- Allowed port range: `1024–65535`.
- Device name length: 1–64 characters.
- Default device name: `<user>'s Novion`.
- Both computers must run a compatible protocol version. The current protocol is
  version 1; a mismatch is rejected with a message asking both sides to update.
- Both computers must be on the same Wi-Fi or LAN. Guest networks and networks
  with client isolation block discovery and connections.
- macOS asks for Local Network permission the first time sharing or discovery is
  used.
- Windows needs a private-network firewall exception. Public-network profiles
  are intentionally not required.

The service stops when you press **Stop sharing** or quit Novion. It does not
auto-start on the next launch.

## Host setup

1. Open **Settings → Sharing**.
2. Set **This computer's name** and **Port** while sharing is stopped.
3. Press **Start sharing**.
4. Give the pairing code to the person connecting, or copy it.
5. Allow Novion through the operating-system firewall if prompted.

While sharing is running, the page shows:

- all local HTTPS addresses for the workspace, in the form
  `https://<address>:<port>`
- the host certificate fingerprint
- the current pairing code and its expiry time
- the paired-computers list, including permission and last-seen time
- a warning if automatic mDNS discovery is unavailable

### Pairing codes

- Format: `XXXX-XXXX` (nine characters including the hyphen).
- A code is generated automatically when sharing starts if there is no current
  code.
- A code is valid for **two minutes**.
- A code can be used once.
- After five failed attempts it is no longer accepted.
- Use **New pairing code** to replace it at any time; the previous code stops
  working immediately.

### Paired computers

Each paired computer appears with its device name, permission, and last-seen
time. Pairing currently grants read/write access. Press **Revoke** to remove a
device; revocation takes effect on that device's next request.

The host never shows a paired device's token again. `sharing.json` stores only
a SHA-256 hash of each token.

### Discovery fallback

The host advertises the workspace over mDNS. If advertising fails, sharing still
starts and the UI shows a warning. The other computer can use **Connect by
address instead** with one of the addresses shown on the host.

## Client setup

1. Open **Settings → Sharing → Connect to another computer**.
2. Press **Scan** and choose a discovered host.
3. Enter the pairing code shown on the host and press **Connect**.
4. Alternatively, open **Connect by address instead** and enter the host
   address, port, and pairing code manually.

The scan list shows each host's name, address, port, and workspace name.

### First connection and certificate trust

- A scanned host advertises its certificate fingerprint over mDNS, and the
  client verifies that fingerprint before pairing.
- A manual first connection trusts the certificate returned during pairing
  (trust on first use). Use scanning when possible, or compare the fingerprint
  shown on the host.

### Connected state

After connecting:

- The main window shows a **Connected to …** badge.
- The Sharing page shows the host name, workspace name, latency, and root path.
- Workspace operations are sent to the host.
- Novion pings the host every 10 seconds and updates the latency reading.
- Press **Disconnect** to return to the local workspace.
- Press **Forget this computer** to remove the saved connection.
- A saved connection can be reopened with **Reconnect** without entering the
  pairing code again.

If the host is stopped, revoked, or unreachable, the connection ends or shows a
“needs attention” state. Disconnect or reconnect from the Sharing page.

## Saved files and identity

All files live under Novion's application config directory.

Host:

- `sharing.json` — host id, device name, port, paired-device records, token
  hashes, permissions, and timestamps.
- `remote-identity/ca.pem` — the local certificate authority shown to clients.
- `remote-identity/server.pem` — the TLS server certificate.
- `remote-identity/server-key.pem` — the server private key.

Client:

- `remote.json` — saved host, port, CA PEM, certificate fingerprint, and bearer
  token.

On macOS and Linux, these files are written with private permissions (`0600`).
The client token is kept in the app config and is not exposed by the webview as
a workspace file.

The host identity is stable across restarts. It is regenerated only when one of
the identity files is missing or empty. If the identity changes, every client
must pair again. Stopping and starting sharing does **not** rotate the identity.

## What is shared

The host accepts these workspace operations from a paired client:

### Workspace

- `ensure_workspace`
- `workspace_stamp`
- `restore_workspace`

### Folders

- `create_folder`
- `rename_folder`
- `delete_folder`

### Notes

- `create_doc`
- `rename_doc`
- `delete_doc`
- `duplicate_doc`

### Note state

- `restore_node`
- `set_completed`
- `set_pinned`
- `move_node`

### Documents

- `read_doc`
- `save_doc`
- `doc_stamp`

### Search and links

- `search_docs`
- `backlinks_doc`

### Images and assets

- `save_asset`
- `delete_asset`
- `list_dir`

### Version history

- `list_doc_versions`
- `read_doc_version`
- `create_doc_version`
- `restore_doc_version`

This covers the workspace tree, folders, notes, note bodies, search, backlinks,
assets, and version history.

Images are loaded through a local proxy on the client. The client does not hold
a copy of the host's workspace file tree or image files.

## Local-only / blocked actions

The following are intentionally not proxied to the host:

- permanently deleting a node or emptying Trash (`purge_node`, `empty_trash`) —
  remote deletion only moves items to the host's Trash
- switching storage or revealing the storage folder
- Notion sync and Notion settings
- MCP settings
- importing, exporting, and revealing exported or host paths
- application updates
- sharing configuration itself

The UI shows this message for blocked workspace actions:

> This action is unavailable while connected to a remote workspace.

Sharing settings are local to each computer. A client does not change the
host's sharing configuration.

## Concurrency and conflicts

The host serializes workspace-tree mutations with a per-workspace write lock.
Two clients, or the host UI and a client, can therefore rename, move, and delete
concurrently without losing a `workspace.json` update.

Document bodies keep the existing mtime conflict check. If another computer
saves the same note first, the second save pauses with the normal conflict
banner instead of silently overwriting the newer file.

While the workspace is being shared (or when this app is connected to a host),
an open note is checked about every two seconds. If the note changes on the
other computer and the local copy has no unsaved edits, it reloads
automatically. If there are unsaved edits, the editor is left alone and the
normal conflict banner decides what to keep.

This is shared access, not live co-editing. Changes are not streamed to other
clients in real time.

## Network and security

- The host serves TLS using a local CA generated on first use. Clients pin that
  CA after pairing.
- A scanned host must also match the certificate fingerprint advertised over
  mDNS.
- The app never falls back to plain HTTP for host RPC.
- The mDNS service type is `_novion._tcp.local.` Its TXT records contain the
  host id, device name, protocol version, certificate fingerprint, workspace
  name, and CA certificate split into chunks. They never contain a bearer token
  or pairing code.
- Pairing codes are one-time, expire after two minutes, and are invalidated
  after five failed attempts.
- Tokens are returned only once during pairing. The host stores only SHA-256
  hashes.
- Revoking a device takes effect on its next request.
- Stopping sharing rejects all clients immediately.
- RPC request bodies are limited to 64 MiB and each RPC call has a 120-second
  execution timeout.

## Troubleshooting

**Host not found**

- Confirm both computers are on the same Wi-Fi/LAN and neither is on a guest or
  client-isolated network.
- If multicast DNS is blocked, use **Connect by address instead** and one of the
  HTTPS addresses shown on the host.

**Connection refused**

- Confirm the host still has sharing enabled.
- Confirm the host is using the expected port and that another program is not
  using it.
- Check the host firewall.

**Pairing rejected**

- The code may have expired, already been used, or exceeded its failed-attempt
  limit. Generate a new code on the host.

**Unauthorized / device revoked**

- The device was revoked or its saved token is no longer valid. Use **Forget**
  on the client and pair again.

**Certificate mismatch**

- The host identity changed, for example because its identity files were
  regenerated. Use **Forget** on the client and pair again.
- Stopping and starting sharing does not fix a mismatch by itself; the host
  identity must remain the one the client trusts, or the client must re-pair.

**Protocol mismatch**

- Both computers must run the same compatible protocol version. Update both
  copies of Novion.

**Remote connection needs attention**

- A ping failed or the connection became invalid. Open **Settings → Sharing**,
  then reconnect or disconnect.

**Windows firewall**

- Allow Novion on private networks. Do not enable public-network profiles.

**macOS Local Network permission**

- Allow Local Network access in **System Settings → Privacy & Security → Local
  Network**.

## Limitations

- The host must be online and running Novion with sharing started.
- The client has no offline copy and cannot keep editing if the host disappears.
- The client cannot permanently delete notes, empty Trash, import/export,
  switch storage, use Notion sync, change MCP settings, or install updates.
- There is no real-time collaborative editing.
- One host serves one active workspace at a time.

## See also

- [Development](development.md) — local development and test commands.
- [MCP server](mcp.md) — local AI access to the active workspace.
