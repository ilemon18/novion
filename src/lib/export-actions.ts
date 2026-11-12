import { api, errorMessage, type ExportFormat, type ExportResult } from "@/lib/tauri";
import { saveQueue } from "@/lib/save-scheduler";
import { useUi } from "@/store/ui";
import { t } from "@/i18n";

/**
 * Export entry points shared by the document menu, the ⌘⇧P palette and the
 * storage settings page — one implementation, one message format, one place
 * that knows how to reveal the result in Finder.
 */

const LABELS: Record<ExportFormat, string> = {
  md: "Markdown",
  html: "HTML",
  json: "JSON",
};

/**
 * `~/Downloads/Novion/x.md` → `Novion/x.md`, short enough for a toast.
 * Rust hands back native paths, so Windows arrives with backslashes.
 */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function reveal(path: string) {
  void api.revealPath(path).catch((err) => {
    useUi.getState().notify(errorMessage(err), { tone: "error" });
  });
}

function announce(path: string, text: string) {
  useUi.getState().notify(text, {
    tone: "success",
    actionLabel: t("Show in folder"),
    action: () => reveal(path),
  });
}

function announceError(err: unknown) {
  useUi.getState().notify(errorMessage(err), { tone: "error", timeout: 7000 });
}

/**
 * Exports one document. Pending autosave work is flushed first, otherwise the
 * file on disk could be one edit behind what the user is looking at.
 */
export async function exportDoc(
  docId: string,
  format: ExportFormat,
): Promise<ExportResult | null> {
  try {
    await saveQueue.flush(`doc:${docId}`);
    const result = await api.exportDoc(docId, format);
    announce(
      result.path,
      t("{format} exported to {path}", {
        format: LABELS[format],
        path: shortPath(result.path),
      }),
    );
    return result;
  } catch (err) {
    announceError(err);
    return null;
  }
}

/** Full backup: raw JSON copy + Markdown mirror of the whole workspace. */
export async function exportWorkspace(): Promise<ExportResult | null> {
  try {
    await saveQueue.flushAll();
    const result = await api.exportWorkspace();
    announce(
      result.path,
      t("Backup complete: {count} files ({size})", {
        count: result.files,
        size: formatBytes(result.bytes),
      }),
    );
    return result;
  } catch (err) {
    announceError(err);
    return null;
  }
}
