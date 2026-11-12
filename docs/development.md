# Development

Build, run and release Novion.

## Quick start

```bash
pnpm install
pnpm app:dev
```

Requirements: macOS 11+ / Windows 10+, Node.js 20+, pnpm, Rust 1.77+. macOS also needs the Xcode Command Line Tools; Windows needs WebView2 (the installer adds it).

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

## Tests

```bash
pnpm test          # vitest
pnpm check:i18n    # every t() string has a translation row
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs the frontend and Rust suites on both Ubuntu and Windows.

## Tech stack

React 18 · TypeScript · Vite · Tauri v2 · Rust · TipTap / ProseMirror · Tailwind CSS v4 · Zustand