import type { TreeNode } from "@/lib/tauri";
import { FloatMenu, FloatMenuItem, FloatMenuSeparator } from "@/components/ui/float-menu";
import type { NodeAction } from "./node-actions";

export interface NodeMenuRequest {
  node: TreeNode;
  /** viewport coordinates of the right-click */
  x: number;
  y: number;
}

/**
 * The sidebar's right-click menu.
 *
 * One instance per list: the coordinates come straight from the `contextmenu`
 * event and are drawn by `FloatMenu`, so the menu can never be laid out against
 * a stale anchor and flash in the corner before jumping to the pointer.
 */
export function NodeContextMenu({
  menu,
  actions,
  onClose,
}: {
  menu: NodeMenuRequest | null;
  actions: NodeAction[];
  onClose: () => void;
}) {
  return (
    <FloatMenu
      open={!!menu}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      onClose={onClose}
      label={menu?.node.name}
      className="min-w-40"
    >
      {actions.map((action) => (
        <div key={action.label}>
          {action.separatorBefore && <FloatMenuSeparator />}
          <FloatMenuItem
            icon={action.icon}
            destructive={action.destructive}
            onSelect={action.run}
          >
            {action.label}
          </FloatMenuItem>
        </div>
      ))}
    </FloatMenu>
  );
}