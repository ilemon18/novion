import { api, errorMessage, type ImportStats } from "@/lib/tauri";
import { saveQueue } from "@/lib/save-scheduler";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { t } from "@/i18n";

/**
 * Markdown / JSON import entry points.
 *
 * Both paths end in the same place: new folders and documents appended to the
 * workspace, images copied into `assets/`. Nothing is ever overwritten, so an
 * import is always safe to repeat.
 */

function parentForSelection(): string | null {
  const { nodes, selectedId } = useWorkspace.getState();
  const node = selectedId ? nodes[selectedId] : null;
  if (!node || node.builtin) return null;
  return node.kind === "folder" ? node.id : node.parentId;
}

function summarize(stats: ImportStats): string {
  const parts = [t("{count} documents", { count: stats.docs })];
  if (stats.folders > 0) parts.push(t("{count} folders", { count: stats.folders }));
  if (stats.assets > 0) parts.push(t("{count} images", { count: stats.assets }));
  if (stats.skipped > 0) parts.push(t("{count} skipped", { count: stats.skipped }));
  if (stats.failed > 0) parts.push(t("{count} failed", { count: stats.failed }));
  return parts.join(t(", "));
}

function report(stats: ImportStats) {
  const ui = useUi.getState();
  if (stats.docs === 0) {
    ui.notify(t("No Markdown documents found to import"), { tone: "info" });
    return;
  }
  const failed = stats.failed > 0;
  ui.notify(
    t("Imported {name}: {summary}", {
      name: stats.targetName || "",
      summary: summarize(stats),
    }).trim(),
    {
      tone: failed ? "info" : "success",
      timeout: failed ? 8000 : 5000,
    },
  );
}

/** Picks a folder with the native dialog, then imports everything under it. */
export async function importMarkdownFolder(): Promise<void> {
  try {
    const source = await api.pickImportFolder();
    if (!source) return; // cancelled
    const ui = useUi.getState();
    ui.notify(t("Importing Markdown…"), { timeout: 0 });
    const stats = await api.importMarkdown(source, parentForSelection());
    // the tree changed outside the usual CRUD replies: re-read it wholesale
    const ws = await api.ensure();
    useWorkspace.getState().apply(ws);
    report(stats);
  } catch (err) {
    useUi.getState().notify(errorMessage(err), { tone: "error", timeout: 8000 });
  }
}

const MARKDOWN_NAME = /\.(md|markdown|mdx)$/i;
const JSON_NAME = /\.json$/i;

/** Files the window accepts as a drop: Markdown notes and document JSON. */
export function isImportableFile(file: File): boolean {
  return MARKDOWN_NAME.test(file.name) || JSON_NAME.test(file.name);
}

/**
 * Imports files dropped onto the window. The webview exposes dropped files as
 * `File` objects without a path, so the text is read here and the title comes
 * from the file name.
 *
 * `.md` becomes a parsed Markdown document; `.json` is read as a document
 * export and — when it is not one — still lands as a plain-text document, so a
 * wrong file never fails the drop. Everything goes into the folder that is
 * selected in the sidebar (the parent of the open note), matching a normal
 * "new document" there.
 */
export async function importDroppedFiles(files: File[]): Promise<void> {
  const importable = files.filter(isImportableFile);
  if (!importable.length) return;
  await saveQueue.flushAll();
  const parent = parentForSelection();
  let docs = 0;
  const plain: string[] = [];
  const failures: string[] = [];
  for (const file of importable) {
    try {
      const text = await file.text();
      const stats = JSON_NAME.test(file.name)
        ? await api.importJsonText(file.name, text, parent)
        : await api.importMarkdownText(file.name, text, parent);
      docs += stats.docs;
      if (stats.plainText > 0) plain.push(file.name);
    } catch (err) {
      failures.push(t("{name}: {message}", { name: file.name, message: errorMessage(err) }));
    }
  }
  const ws = await api.ensure();
  useWorkspace.getState().apply(ws);
  const ui = useUi.getState();
  if (docs > 0) {
    ui.notify(t("Imported {count} documents", { count: docs }), {
      tone: "success",
      actionLabel: failures.length ? undefined : t("Open"),
    });
  }
  // a JSON file that was not a document export is still imported, just as text
  for (const name of plain.slice(0, 3)) {
    ui.notify(t("Imported {name} as plain text", { name }), { tone: "info", timeout: 7000 });
  }
  if (failures.length) {
    ui.notify(failures.slice(0, 3).join(t("; ")), { tone: "error", timeout: 9000 });
  }
}
