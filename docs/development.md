# Development

Build, run and release Novion.

## Quick start

```bash
pnpm install
pnpm app:dev
```

Requirements: macOS 11+ / Windows 10+, Node.js 20+, pnpm, Rust 1.88+. macOS also needs the Xcode Command Line Tools; Windows needs WebView2 (the installer adds it).

## Local builds

Each platform builds its own artifacts — there is no cross-compile step, so a
Windows installer is built on Windows and a `.app` on macOS.

Release bundle (`app` + `dmg` on macOS, an NSIS installer on Windows):

```bash
pnpm app:release
```

Debug bundle for review (debug symbols kept, no signing, copied to `release/`):

| Host | Command | Output |
| --- | --- | --- |
| macOS | `pnpm app:build` | `release/Novion-debug.app` — run `open release/Novion-debug.app` |
| Windows | `pnpm app:build:win` | `release/Novion-debug-setup.exe` — double-click to install |

Both scripts end in `scripts/collect-app.mjs`, which copies the bundle out of
`src-tauri/target/debug/bundle/` (`macos/Novion.app` or `nsis/*-setup.exe`,
whichever this host produced) into `release/`, replacing the previous copy so a
stale build can never be handed out. Never run the artifact straight from
`src-tauri/target/`.

Windows notes:

- The installer is per-user (`installMode: currentUser` in
  `src-tauri/tauri.windows.conf.json`, SimpChinese + English) — no admin rights.
- `--bundles nsis` is passed on the command line to match the release workflow;
  `tauri.windows.conf.json` narrows `bundle.targets` to `nsis` as well, so both
  places agree. `pnpm app:build` is macOS-only (`app` is not a Windows bundle).
- `src-tauri/icons/icon.ico` must exist (it is listed in `bundle.icon`); without
  it the NSIS step fails after the whole Rust compile.
- A debug build needs no certificate. Only `pnpm app:release` looks at the
  `WINDOWS_CERTIFICATE` secrets, and an unsigned installer shows the SmartScreen
  prompt on first run.
- The first Windows build needs the MSVC Rust toolchain and WebView2 (both in the
  requirements above); NSIS itself is downloaded by tauri-cli.

## Releasing

Pushing a tag publishes a release, and the tag decides the version:

```bash
git tag v0.0.1
git push origin v0.0.1
```

GitHub Actions builds and publishes two artifacts:

| Platform | Artifact | Notes |
| --- | --- | --- |
| macOS | `novion-macos-0.0.1.dmg` | universal (Apple Silicon + Intel) |
| Windows | `novion-win-0.0.1.exe` | NSIS installer, per-user |

`scripts/set-version.mjs` writes the tag version into `package.json`, `tauri.conf.json`, `Cargo.toml` and `Cargo.lock` before the build, so the version shown in About is the release version.

Artifacts are **unsigned** by default: on macOS the first launch needs right-click -> Open, and Windows shows a SmartScreen prompt. To enable signing, add these repository secrets:

- macOS signing and notarization: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
- Windows signing: `WINDOWS_CERTIFICATE` (base64 of the .pfx), `WINDOWS_CERTIFICATE_PASSWORD`

Missing secrets skip the corresponding step; a half-configured set fails immediately instead of halfway through the build.

If the certificate itself is unusable (not a readable `.p12`, wrong password, or no private key), the workflow validates it first: by default it falls back to an **unsigned** build, prints an `::error::`/`::warning::` explaining why, and keeps going. Set the repository variable `REQUIRE_SIGNING` to `true` if you would rather fail the run.

To export it: Keychain Access -> My Certificates -> Developer ID Application -> Export as `.p12`, then `base64 -i cert.p12 | pbcopy` into `APPLE_CERTIFICATE`.

## MCP development

The optional MCP server is implemented in `src-tauri/src/mcp.rs`; its settings
UI is `src/components/settings/McpSection.tsx`. It uses `rmcp` Streamable HTTP
with tools only, binds to `127.0.0.1`, and defaults to port `39261`. The port and
bearer token are stored in the application config as `mcpPort` and `mcpToken`.

The server never starts with the app. `mcp_get_status` is also what creates the
first token, and `mcp_set_port` / `mcp_rotate_token` only work while the server
is stopped.

Run the MCP unit tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml mcp::tests
```

Manual check: run `pnpm app:dev`, open **Settings → MCP**, start the server, and
confirm that a request without the bearer token gets `401`. Copy the connection
details into an MCP client and verify `initialize` plus `tools/list` succeed.

## LAN sharing development

The optional Sharing settings page starts a TLS server on the LAN, advertises it
over mDNS (`_novion._tcp.local.`), and lets a paired client run workspace
commands on the host. See [sharing.md](sharing.md).

Backend modules:

| Module | Responsibility |
| --- | --- |
| `src-tauri/src/remote/store.rs` | Sharing/client config, token hashes, local CA and server certificate |
| `src-tauri/src/remote/server.rs` | HTTPS routes and the RPC dispatch allowlist |
| `src-tauri/src/remote/client.rs` | Pairing, hello, pinned TLS client, RPC calls |
| `src-tauri/src/remote/discovery.rs` | mDNS advertising and scanning |
| `src-tauri/src/remote/asset_proxy.rs` | Loopback image proxy on the client |
| `src-tauri/src/remote/mod.rs` | Commands, session state, pairing lifecycle, server task |

Frontend state and UI are in `src/store/remote.ts` and
`src/components/settings/SharingSection.tsx`. In remote mode,
`src/lib/tauri.ts` routes workspace operations through `remote_call`; local-only
wrappers reject with `remote_unsupported`.

Defaults are port `39262` and protocol version `1`. Run the sharing unit tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml remote::
```

Two-machine smoke test:

1. Start sharing on the host and connect with **Scan**.
2. Repeat with **Connect by address instead**.
3. Disconnect, reconnect from the saved entry, and check the latency badge.
4. Revoke the client on the host and confirm its next request is rejected.
5. While connected, confirm export, storage switching, Notion, and MCP settings
   are blocked.
6. Stop sharing and confirm the client loses access immediately.

macOS needs the Local Network usage description and Bonjour service declaration
in `src-tauri/Info.plist`; Windows asks for a private-network firewall exception
the first time sharing starts. Identity and config files live in the application
config directory (`sharing.json`, `remote.json`, and `remote-identity/`).

## Tests

```bash
pnpm test          # vitest
pnpm check:i18n    # every t() string has a translation row
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs the frontend and Rust suites on both Ubuntu and Windows.

## Tech stack

React 18 · TypeScript · Vite · Tauri v2 · Rust · TipTap / ProseMirror · Tailwind CSS v4 · Zustand
