import { memo, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pin,
  Square,
} from "lucide-react";
import { useWorkspace, type TreeNode } from "@/store/workspace";
import { useImeSafeInput } from "@/lib/use-ime-safe-input";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TruncatedLabel } from "./TruncatedLabel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildNodeActions } from "./node-actions";
import { useT } from "@/i18n";

export type DropZone = "before" | "inside" | "after";

export interface TreeRowProps {
  node: TreeNode;
  depth: number;
  selected: boolean;
  /** the row a keyboard rename would target (the sidebar's "current" row) */
  active: boolean;
  expanded: boolean;
  /** inline rename is driven by the list, so Enter can open it */
  editing: boolean;
  /** this row is the one being dragged right now */
  dragging: boolean;
  dropZone: DropZone | null;
  /** suppress hover tooltips while a drag is in flight */
  tooltipDisabled: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onActivate: (id: string) => void;
  onStartEdit: (id: string) => void;
  onStopEdit: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (node: TreeNode) => void;
  onSetCompleted: (id: string, completed: boolean) => void;
  onSetPinned: (id: string, pinned: boolean) => void;
  onCreateDoc: (parentId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onDragStart: (id: string) => void;
  onDragOverRow: (id: string, zone: DropZone) => void;
  onDragLeaveRow: (id: string) => void;
  onDropRow: () => void;
  onDragEnd: () => void;
}

const ROW_H = 30;

function TreeRowImpl(props: TreeRowProps) {
  const {
    node,
    depth,
    selected,
    active,
    expanded,
    editing,
    dragging,
    tooltipDisabled,
    dropZone,
    onSelect,
    onToggle,
    onActivate,
    onStartEdit,
    onStopEdit,
    onRename,
    onDelete,
    onSetCompleted,
    onSetPinned,
    onCreateDoc,
    onCreateFolder,
    onDragStart,
    onDragOverRow,
    onDragLeaveRow,
    onDropRow,
    onDragEnd,
  } = props;

  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** name captured when editing started, so store updates can never overwrite
   *  what the user is typing (that used to reset the field and drop focus) */
  const startValue = useRef(node.name);

  const field = useImeSafeInput({
    initialValue: startValue.current,
    onCommit: (value) => {
      onStopEdit();
      onRename(node.id, value);
    },
    onCancel: () => onStopEdit(),
  });

  useEffect(() => {
    if (!editing) return;
    startValue.current = node.name;
    field.reset(node.name);
    // `scrollIntoView` as well: a freshly created row can sit at the very edge
    // of the scrolling list, where the caret would be clipped
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
      el.scrollIntoView({ block: "nearest" });
    });
    // only on entering edit mode — not when the store echoes a rename back
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const isFolder = node.kind === "folder";
  const pinned = !!node.pinnedAt;

  /**
   * Runs a menu action only after the menu has closed. Creating a document
   * rewrites the tree, which re-renders this row; doing it while the menu is
   * still closing made the menu flash.
   */
  const runDeferred = (run: () => void) => {
    setMenuOpen(false);
    window.setTimeout(run, 0);
  };

  // one action list for the row dropdown and the sidebar's right-click menu
  const actions = buildNodeActions(node, {
    nodes: useWorkspace.getState().nodes,
    t,
    defer: runDeferred,
    onCreateDoc,
    onCreateFolder,
    onStartEdit,
    onDelete,
    onSetCompleted,
    onSetPinned,
  });

  return (
    <div
      data-no-window-drag
      data-tree-row={node.id}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", node.id);
        onDragStart(node.id);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        // the list container also listens for dragover (blank area). Without
        // this, its handler ran right after this one and reset the hover
        // state, so no drop indicator ever appeared and `onDrop` saw null.
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientY - rect.top) / rect.height;
        const zone: DropZone = isFolder
          ? ratio < 0.28
            ? "before"
            : ratio > 0.72
              ? "after"
              : "inside"
          : ratio < 0.5
            ? "before"
            : "after";
        onDragOverRow(node.id, zone);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        e.stopPropagation();
        onDragLeaveRow(node.id);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDropRow();
      }}
      onDragEnd={onDragEnd}
      onClick={() => {
        onActivate(node.id);
        if (isFolder) onToggle(node.id);
        else onSelect(node.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartEdit(node.id);
      }}
      style={{ height: ROW_H, paddingLeft: 8 + depth * 13 }}
      className={cn(
        "group relative flex cursor-default items-center gap-1.5 rounded-md pr-1 text-[14px] transition-colors duration-75",
        dragging && "opacity-45",
        selected
          ? "bg-brand-soft text-foreground"
          : active
            ? "bg-sidebar-active text-foreground"
            : "text-foreground/85 hover:bg-sidebar-hover",
        dropZone === "inside" && "bg-brand-soft ring-1 ring-inset ring-brand/50",
      )}
    >
      {selected && (
        <span className="pointer-events-none absolute inset-y-[6px] left-0 w-[2px] rounded-full bg-brand" />
      )}
      {dropZone === "before" && (
        <span className="pointer-events-none absolute inset-x-1 -top-px h-[2px] rounded bg-brand transition-all duration-100" />
      )}
      {dropZone === "after" && (
        <span className="pointer-events-none absolute inset-x-1 -bottom-px h-[2px] rounded bg-brand transition-all duration-100" />
      )}

      {isFolder ? (
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
            expanded && "rotate-90",
          )}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.id);
          }}
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}

      {isFolder ? (
        expanded ? (
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
        ) : (
          <Folder className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
        )
      ) : editing ? (
        <FileText
          className={cn("size-3.5 shrink-0", pinned ? "text-brand" : "text-muted-foreground/80")}
          strokeWidth={1.8}
        />
      ) : (
        /* hovering flips the document icon into a "mark as done" checkbox */
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSetCompleted(node.id, true);
          }}
          title={t("Archive")}
          aria-label={t("Archive")}
          className="group/tick relative size-3.5 shrink-0 outline-none"
        >
          <FileText
            className={cn(
              "absolute inset-0 size-3.5 transition-opacity duration-100 group-hover/tick:opacity-0",
              pinned ? "text-brand" : "text-muted-foreground/80",
            )}
            strokeWidth={1.8}
          />
          <Square
            className="absolute inset-0 size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-100 group-hover/tick:opacity-100 hover:text-brand"
            strokeWidth={1.7}
          />
        </button>
      )}

      {editing ? (
        <input
          ref={inputRef}
          value={field.draft}
          onChange={field.handleChange}
          onCompositionStart={field.handleCompositionStart}
          onCompositionEnd={field.handleCompositionEnd}
          onClick={(e) => e.stopPropagation()}
          onBlur={field.handleBlur}
          onKeyDown={(e) => {
            e.stopPropagation();
            field.handleKeyDown(e);
          }}
          className="min-w-0 flex-1 selectable rounded border border-ring/60 bg-background px-1 py-0.5 text-[13.5px] outline-none"
        />
      ) : (
        <>
          <TruncatedLabel
            text={node.name}
            disabled={tooltipDisabled}
            className="flex-1"
            fallback={<span className="text-muted-foreground/70">{t("Untitled")}</span>}
          />
          {pinned && (
            <Pin
              className="size-3 shrink-0 rotate-45 text-brand"
              strokeWidth={2}
              aria-label={t("Pinned")}
            />
          )}
        </>
      )}

      {!editing && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              size="iconSm"
              variant="ghost"
              onClick={(e) => e.stopPropagation()}
              className="opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
              aria-label={t("Item actions")}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent onClick={(e) => e.stopPropagation()} className="min-w-40">
            {actions.map((a) => (
              <div key={a.label}>
                {a.separatorBefore && <DropdownMenuSeparator />}
                <DropdownMenuItem destructive={a.destructive} onSelect={a.run}>
                  <a.icon /> {a.label}
                </DropdownMenuItem>
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export const TreeRow = memo(TreeRowImpl);