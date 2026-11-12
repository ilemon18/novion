import type { TreeNode } from "@/lib/tauri";

/**
 * Where a "new document / new folder" request should land.
 *
 * The system groups (已归档 / 回收站) cannot host user content: the backend
 * rejects them outright (`validate_parent`), so a request made while a trashed
 * or archived note is selected used to fail silently — the menu closed, nothing
 * appeared, and the user read it as "the button does nothing". Everything that
 * creates a node goes through this helper so a stale selection can only ever
 * fall back to the workspace root.
 */
const SYSTEM_GROUP = new Set(["f_completed", "f_trash"]);

/** True when the node (or anything above it) sits in a system group. */
function inSystemGroup(nodes: Record<string, TreeNode>, node: TreeNode): boolean {
  let cursor: TreeNode | undefined = node;
  let guard = 0;
  while (cursor && guard++ < 128) {
    if (cursor.builtin || SYSTEM_GROUP.has(cursor.id)) return true;
    if (cursor.trashedAt || cursor.completedAt) return true;
    cursor = cursor.parentId ? nodes[cursor.parentId] : undefined;
  }
  return false;
}

/** True when `id` is a plain folder that may receive new children. */
export function canHostChildren(
  nodes: Record<string, TreeNode>,
  id: string | null | undefined,
): id is string {
  if (!id) return false;
  const node = nodes[id];
  if (!node || node.kind !== "folder") return false;
  return !inSystemGroup(nodes, node);
}

/**
 * The folder a new node should be created in, or `null` for the root.
 *
 * A selected folder hosts the new node. A selected document puts it next to
 * itself. Anything the backend would refuse (system groups, trashed or archived
 * subtrees, a missing selection) degrades to the root instead of failing.
 */
export function parentForNewNode(
  nodes: Record<string, TreeNode>,
  selectedId: string | null | undefined,
): string | null {
  const selected = selectedId ? nodes[selectedId] : undefined;
  if (!selected) return null;
  // nothing may be created next to a trashed / archived / system entry
  if (inSystemGroup(nodes, selected)) return null;

  const candidate = selected.kind === "folder" ? selected.id : selected.parentId;
  return canHostChildren(nodes, candidate) ? candidate : null;
}

/**
 * Same decision for a concrete row (context menu / row dropdown), where the
 * target is the row itself rather than the current selection.
 */
export function parentForNewNodeFrom(
  nodes: Record<string, TreeNode>,
  node: TreeNode | null | undefined,
): string | null {
  if (!node) return null;
  return parentForNewNode(nodes, node.id);
}