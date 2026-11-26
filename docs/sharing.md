# LAN sharing

Novion can expose one computer's active workspace to another Novion on the same local network. This is a host-authoritative remote workspace: the host keeps the real files, and the connected computer sends read and write operations over the LAN. The client does not keep a second copy and does not work offline.

Sharing is **off by default**. Novion does not listen on a LAN port until you start sharing in **Settings → Sharing**, and it stops listening when you press **Stop sharing** or quit the app.

## Host

1. Open **Settings → Sharing**.
2. Choose a name and port, then press **Start sharing**.
3. Read the pairing code to the person connecting, or copy it.
4. The host may need to allow Novion through the operating system firewall. On macOS, the first LAN use also asks for Local Network permission.
5. Paired computers can be revoked from the same page.

The host keeps:

- `sharing.json` with paired-device token hashes;
- a local CA and server certificate under the app config folder (`remote-identity/`);
- the workspace itself in the normal Novion storage location.

Tokens are never shown to the host UI after pairing, and the host stores only SHA-256 hashes.

## Client

1. Open **Settings → Sharing → Connect to another computer**.
2. Press **Scan** and choose a host, or use **Connect by address instead**.
3. Enter the pairing code shown on the host and press **Connect**.
4. The main window shows a “Connected to …” badge. All workspace operations now run on the host.
5. Press **Disconnect** to return to the local workspace, or **Forget this computer** to remove the saved connection.

The client stores the host certificate, token, and last address in its app config (`remote.json`). This file is created with private permissions on macOS/Linux and is never exposed to the webview.

## What is shared

- workspace tree and folders
- document read/save
- search and backlinks
- images under `assets/`
- version history

These actions are intentionally blocked from remote clients:

- permanent deletion and emptying the trash (remote deletion only moves items to the host's Trash)
- storage switching
- Notion sync
- MCP settings
- import/export and revealing host files in Finder
- app updates and sharing configuration

## Concurrency and conflicts

The host serializes workspace-tree mutations. Two clients (or the host UI and a client) can therefore rename, move, and delete concurrently without a lost `workspace.json` update.

Document bodies keep the existing mtime conflict check. If another computer saves the same note first, the second save pauses with the normal conflict banner instead of silently overwriting it. This is shared access, not real-time co-editing.

## Network and security

- The host serves TLS with a local CA generated on first use. Clients pin that CA after pairing; a discovered host must also match the certificate fingerprint advertised over mDNS.
- A manual first connection trusts the certificate returned during pairing. Use scan when possible, or compare the fingerprint shown on the host.
- Pairing codes expire after two minutes and are invalidated after five failed attempts. A new code can be generated at any time.
- mDNS traffic contains the host name, workspace label, certificate fingerprint, and CA certificate, but never a token or pairing code.
- The data connection is TLS-protected; the app never falls back to plain HTTP for host RPC.
- Revoking a device takes effect on its next request. Stopping sharing rejects all clients immediately.

## Troubleshooting

- **Host not found:** make sure both computers are on the same Wi-Fi/LAN, not a guest or client-isolated network. Use the manual address if multicast DNS is blocked.
- **Connection refused:** check the host is still sharing and the port is not used by another program.
- **Certificate mismatch:** stop and start sharing on the host, then pair again. A regenerated identity requires re-pairing.
- **Windows firewall:** allow Novion on private networks. Public-network profiles are intentionally not required.
- **macOS:** allow Local Network access for Novion in System Settings → Privacy & Security → Local Network.
