# Agent Instructions

Read `.ai/context.md` before changing code. It holds the file map, core rules, and gotchas.

## Verification default: no GUI

- Verify headlessly: `pnpm build`, `pnpm test`, and
  `cargo test --manifest-path src-tauri/Cargo.toml` when Rust changed.
- Do NOT launch the app or drive the UI (`pnpm app:dev`, `pnpm app:build`,
  Playwright, tauri-driver, cua-driver, clicking/screenshots) unless the user
  explicitly asks for GUI or manual testing.
- If a change cannot be verified headlessly, say so and ask before opening the app.
