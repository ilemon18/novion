/**
 * Platform identity for the parts of the UI that are not portable on their own:
 * shortcut glyphs, the overlay title bar and the file-manager wording.
 *
 * The webview user agent is enough — the app only ships on macOS and Windows,
 * and this keeps the check dependency-free (no `plugin-os`, no IPC at boot).
 */
const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isWindows = /Windows/i.test(ua);
export const isMac = !isWindows && /Mac OS X|Macintosh/i.test(ua);

/** Modifier glyph shown in shortcut hints. */
const MOD = isMac ? "⌘" : "Ctrl+";

/**
 * Rewrites a macOS-style hint (`⌘⇧P`) into the local convention (`Ctrl+Shift+P`).
 * Imported labels come straight from the i18n catalogue, which keeps the glyphs.
 */
export function formatShortcut(label: string): string {
  const text = label.trim();
  if (!text) return text;
  if (isMac) return text;
  return text
    .replaceAll("⌘", MOD)
    .replaceAll("⌃", "Ctrl+")
    .replaceAll("⇧", "Shift+")
    .replaceAll("⌥", "Alt+");
}

/**
 * Marks the document with the platform so CSS can drop the macOS-only chrome
 * (overlay title bar padding, traffic-light offsets) without a flash.
 */
export function applyPlatform(): void {
  const platform = isWindows ? "windows" : isMac ? "macos" : "linux";
  document.documentElement.dataset.platform = platform;
}