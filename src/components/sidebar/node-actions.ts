import {
  CheckCircle2,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { TreeNode } from "@/lib/tauri";
import { parentForNewNodeFrom } from "@/lib/tree-targets";

/**
 * One menu entry, shared by a row's `⋮` dropdown and the right-click menu so
 * the two can never drift apart (they used to be two hand-written lists).
 */
export interface NodeAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
  destructive?: boolean;
  separatorBefore?: boolean;
}

export interface NodeActionOptions {
  /** live tree, used to validate where a new node may be created */
  nodes: Record<string, TreeNode>;
  t: (key: string) => string;
  /** runs the action after the menu has closed (opening a rename field or
   *  rewriting the tree while a menu is still tearing down used to flash) */
  defer: (run: () => void) => void;
  onCreateDoc: (parentId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onStartEdit: (id: string) => void;
  onDelete: (node: TreeNode) => void;
  onSetCompleted: (id: string, completed: boolean) => void;
  onSetPinned: (id: string, pinned: boolean) => void;
}

export function buildNodeActions(node: TreeNode, options: NodeActionOptions): NodeAction[] {
  const { nodes, t, defer } = options;
  const isFolder = node.kind === "folder";
  const pinned = !!node.pinnedAt;
  const target = parentForNewNodeFrom(nodes, node);

  const actions: NodeAction[] = [
    {
      label: t("New document"),
      icon: Plus,
      run: () => defer(() => options.onCreateDoc(target)),
    },
    {
      label: t("New folder"),
      icon: FolderPlus,
      run: () => defer(() => options.onCreateFolder(target)),
    },
  ];

  if (!isFolder) {
    actions.push({
      label: t("Archive"),
      icon: CheckCircle2,
      separatorBefore: true,
      run: () => defer(() => options.onSetCompleted(node.id, true)),
    });
    actions.push({
      label: pinned ? t("Unpin") : t("Pin to top"),
      icon: pinned ? PinOff : Pin,
      run: () => defer(() => options.onSetPinned(node.id, !pinned)),
    });
  }

  actions.push(
    {
      label: t("Rename"),
      icon: Pencil,
      separatorBefore: true,
      run: () => defer(() => options.onStartEdit(node.id)),
    },
    {
      label: t("Move to Trash"),
      icon: Trash2,
      destructive: true,
      run: () => defer(() => options.onDelete(node)),
    },
  );

  return actions;
}