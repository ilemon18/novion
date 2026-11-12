import { invoke } from "@tauri-apps/api/core";

/**
 * Client-side crash reporting.
 *
 * Everything that goes wrong in the webview ends up in
 * `<app_config_dir>/client-errors.log`, because a packaged desktop app shows a
 * blank window when React throws and there is no console to read. Capped so a
 * render loop cannot flood the file or the IPC channel.
 */
let sent = 0;
const MAX_REPORTS = 20;

export function reportClientError(message: string): void {
  if (sent >= MAX_REPORTS) return;
  sent += 1;
  void invoke("report_client_error", { message }).catch(() => {
    /* logging must never make things worse */
  });
}

/** Wires the global error hooks once, at boot. */
export function installClientErrorHooks(): void {
  window.addEventListener("error", (event) => {
    const error = event.error as Error | undefined;
    reportClientError(
      [
        `error: ${event.message}`,
        `${event.filename}:${event.lineno}:${event.colno}`,
        error?.stack ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { stack?: string; message?: string } | string;
    const text =
      typeof reason === "string" ? reason : (reason?.stack ?? reason?.message ?? String(reason));
    reportClientError(`unhandledrejection: ${text}`);
  });
}
