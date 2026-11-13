import type { TreeNode } from "@/lib/tauri";

/**
 * Which folders the sidebar had closed, remembered per workspace root.
 *
 * Only the *closed* folders are written down, because a folder is open unless
 * the user closed it: anything the app has never seen (a folder made a minute
 * ago, a Notion sync, a tree pointed at another storage folder) then opens by
 * itself instead of starting hidden behind a default nobody chose.
 *
 * The state lives in localStorage next to the other view preferences (sidebar
 * width, outline toggle): `workspace.json` stays a description of the content
 * and is never rewritten just because someone folded a folder away.
 */
const KEY_PREFIX = "novion:collapsed-folders:";

/** The slice of `Storage` we need — tests pass a plain object. */
export type PreferenceStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const keyFor = (rootPath: string) => KEY_PREFIX + (rootPath || "default");

/** User folders only: the system groups (已归档 / 回收站) cannot be toggled. */
function userFolderIds(nodes: Record<string, TreeNode>): string[] {
  return Object.values(nodes)
    .filter((n) => n.kind === "folder" && !n.builtin)
    .map((n) => n.id);
}

/**
 * Closed folder ids for `rootPath`. Ids that no longer name a user folder are
 * dropped on the way out, so a tree that has been reorganised for months cannot
 * leave a growing list of dead ids behind.
 */
export function readCollapsedFolders(
  store: PreferenceStore,
  rootPath: string,
  nodes: Record<string, TreeNode>,
): Set<string> {
  let raw: string | null;
  try {
    raw = store.getItem(keyFor(rootPath));
  } catch {
    return new Set();
  }
  if (!raw) return new Set();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();

  const folders = new Set(userFolderIds(nodes));
  return new Set(
    parsed.filter((id): id is string => typeof id === "string" && folders.has(id)),
  );
}

/** Writes the closed subset of `expanded`; a fully open tree clears the key. */
export function saveCollapsedFolders(
  store: PreferenceStore,
  rootPath: string,
  nodes: Record<string, TreeNode>,
  expanded: Record<string, boolean>,
): void {
  const collapsed = userFolderIds(nodes).filter((id) => !expanded[id]);
  try {
    if (collapsed.length === 0) store.removeItem(keyFor(rootPath));
    else store.setItem(keyFor(rootPath), JSON.stringify(collapsed));
  } catch {
    // A full or unavailable localStorage must never break the sidebar.
  }
}