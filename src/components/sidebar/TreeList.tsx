import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flattenTree, useWorkspace, type TreeNode } from "@/store/workspace";
import { useUi } from "@/store/ui";
import { useAutoHideScrollbar } from "@/lib/use-auto-hide-scrollbar";
import { TreeRow, type DropZone } from "./TreeRow";
import { buildNodeActions } from "./node-actions";
import { NodeContextMenu, type NodeMenuRequest } from "./NodeContextMenu";
import { useT } from "@/i18n";

const ROW_H = 30;
const VIRTUALIZE_OVER = 200;
/** how long a collapsed folder has to be hovered during a drag to open it */
const EXPAND_HOVER_MS = 600;

function isDescendant(nodes: Record<string, TreeNode>, ancestorId: string, id: string) {
  let cur: TreeNode | undefined = nodes[id];
  let guard = 0;
  while (cur?.parentId && guard++ < 64) {
    if (cur.parentId === ancestorId) return true;
    cur = nodes[cur.parentId];
  }
  return false;
}

export function TreeList() {
  const t = useT();
  const nodes = useWorkspace((s) => s.nodes);
  const children = useWorkspace((s) => s.children);
  const expanded = useWorkspace((s) => s.expanded);
  const selectedId = useWorkspace((s) => s.selectedId);
  const focusRequest = useWorkspace((s) => s.focusRequest);
  const renameRequest = useWorkspace((s) => s.renameRequest);
  const select = useWorkspace((s) => s.select);
  const toggleExpand = useWorkspace((s) => s.toggleExpand);
  const rename = useWorkspace((s) => s.rename);
  const remove = useWorkspace((s) => s.remove);
  const move = useWorkspace((s) => s.move);
  const setCompleted = useWorkspace((s) => s.setCompleted);
  const setPinned = useWorkspace((s) => s.setPinned);
  const createDoc = useWorkspace((s) => s.createDoc);
  const createFolder = useWorkspace((s) => s.createFolder);
  const askConfirm = useUi((s) => s.askConfirm);

  const rows = useMemo(
    () => flattenTree(nodes, children, expanded),
    [nodes, children, expanded],
  );

  const dragId = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; zone: DropZone } | null>(null);
  /** hovering the empty area below the tree means "move to the root end" */
  const [dropBlank, setDropBlank] = useState(false);
  /** row targeted by keyboard rename (Enter); follows the open document */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** the row currently being dragged, used to dim it */
  const [draggedId, setDraggedId] = useState<string | null>(null);
  /** right-click target + pointer position, drawn by `NodeContextMenu` */
  const [menu, setMenu] = useState<NodeMenuRequest | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  useAutoHideScrollbar(containerRef);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewport(el.clientHeight);
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleDelete = useCallback(
    (node: TreeNode) => {
      askConfirm({
        title: node.kind === "doc" ? t("Move to Trash?") : t("Move the folder to the Trash?"),
        description:
          node.kind === "doc"
            ? t("“{name}” will be moved to the Trash. You can restore it at any time.", {
                name: node.name || t("Untitled"),
              })
            : t("“{name}” and everything inside it will be moved to the Trash. You can restore it at any time.", {
                name: node.name || t("Untitled"),
              }),
        confirmLabel: t("Move to Trash"),
        destructive: true,
        onConfirm: () => void remove(node.id),
      });
    },
    [askConfirm, remove],
  );

  const expandTimer = useRef<number | null>(null);

  const cancelExpand = useCallback(() => {
    if (expandTimer.current !== null) {
      window.clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }
  }, []);

  const handleDrop = useCallback(() => {
    const dragged = dragId.current;
    const target = drop ? nodes[drop.id] : null;
    const zone = drop?.zone;
    setDrop(null);
    dragId.current = null;
    if (!dragged || !target || dragged === target.id) return;
    if (isDescendant(nodes, dragged, target.id)) return;

    if (zone === "inside") {
      void move(dragged, target.id, children[target.id]?.length ?? 0);
      return;
    }
    const parentId = target.parentId;
    const siblings = children[parentId ?? ""] ?? [];
    const idx = siblings.indexOf(target.id);
    let index = zone === "before" ? idx : idx + 1;
    const currentIdx = siblings.indexOf(dragged);
    if (nodes[dragged].parentId === parentId && currentIdx > -1 && currentIdx < index) {
      index -= 1;
    }
    void move(dragged, parentId, Math.max(0, index));
  }, [children, drop, move, nodes]);

  // keep the drop handler behind a ref: it changes on every hover, but the rows
  // must not re-render for that (React.memo would be defeated otherwise)
  const dropHandler = useRef(handleDrop);
  dropHandler.current = handleDrop;
  const onDropRow = useCallback(() => dropHandler.current(), []);

  const onDragStart = useCallback((id: string) => {
    dragId.current = id;
    setDraggedId(id);
  }, []);

  const onDragEnd = useCallback(() => {
    dragId.current = null;
    setDraggedId(null);
    setDrop(null);
    setDropBlank(false);
  }, []);

  /**
   * Hover bookkeeping for one row. The store is read through `getState()` so
   * this callback keeps a stable identity: rows are memoised and would
   * otherwise re-render on every tree change.
   */
  const onDragOverRow = useCallback(
    (id: string, zone: DropZone) => {
      setDrop((prev) => (prev && prev.id === id && prev.zone === zone ? prev : { id, zone }));
      setDropBlank(false);

      const state = useWorkspace.getState();
      const target = state.nodes[id];
      const canOpen = zone === "inside" && target?.kind === "folder" && !state.expanded[id];
      if (!canOpen) {
        cancelExpand();
        return;
      }
      if (expandTimer.current === null) {
        expandTimer.current = window.setTimeout(() => {
          expandTimer.current = null;
          const latest = useWorkspace.getState();
          if (latest.nodes[id]?.kind === "folder" && !latest.expanded[id]) {
            latest.toggleExpand(id);
          }
        }, EXPAND_HOVER_MS);
      }
    },
    [cancelExpand],
  );

  const onDragLeaveRow = useCallback(
    (id: string) => {
      setDrop((prev) => (prev && prev.id === id ? null : prev));
      cancelExpand();
    },
    [cancelExpand],
  );

  const onActivate = useCallback((id: string) => setActiveId(id), []);
  const onStartEdit = useCallback((id: string) => {
    setActiveId(id);
    setEditingId(id);
  }, []);
  const onStopEdit = useCallback(() => setEditingId(null), []);

  /**
   * Right-click is handled once for the whole list instead of one Radix root
   * per row: the coordinates therefore come from the real event, and the menu
   * lives at a stable place in the tree (a row that re-renders or unmounts
   * cannot take the open menu with it).
   */
  const onContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    // the inline rename field keeps its native text menu
    if (target?.closest("input, textarea")) return;
    const row = target?.closest("[data-tree-row]");
    if (!row) return; // empty area: leave the native menu alone
    event.preventDefault();
    const id = row.getAttribute("data-tree-row");
    const node = id ? useWorkspace.getState().nodes[id] : undefined;
    if (!node) return;
    setMenu({ node, x: event.clientX, y: event.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const deferMenuAction = useCallback((run: () => void) => {
    setMenu(null);
    // let the menu unmount before the tree is rewritten underneath it
    window.setTimeout(run, 0);
  }, []);

  const menuActions = useMemo(() => {
    if (!menu) return [];
    return buildNodeActions(menu.node, {
      nodes,
      t,
      defer: deferMenuAction,
      onCreateDoc: createDoc,
      onCreateFolder: createFolder,
      onStartEdit,
      onDelete: handleDelete,
      onSetCompleted: setCompleted,
      onSetPinned: setPinned,
    });
  }, [
    menu,
    nodes,
    t,
    deferMenuAction,
    createDoc,
    createFolder,
    onStartEdit,
    handleDelete,
    setCompleted,
    setPinned,
  ]);

  // selection changes that do not come from a row click (search jump, new doc,
  // storage switch) must move the rename target too
  useEffect(() => {
    if (selectedId) setActiveId(selectedId);
  }, [selectedId]);

  /**
   * Breadcrumb clicks arrive here through `focusRequest`. The store has already
   * expanded the folder, so `rows` contains it; the nonce guard keeps this from
   * re-scrolling on every unrelated tree update.
   */
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest.nonce) return;
    handledFocus.current = focusRequest.nonce;
    setActiveId(focusRequest.id);
    const index = rows.findIndex((row) => row.id === focusRequest.id);
    const el = containerRef.current;
    if (!el || index < 0) return;
    // fixed-height rows: the index already is the pixel offset, and centring
    // leaves enough context above and below to see where the folder sits
    const top = Math.max(0, index * ROW_H - Math.max(0, (el.clientHeight - ROW_H) / 2));
    // `scroll-behavior` support doubles as the check for the options-object
    // form of scrollTo (older WebKit silently ignores it)
    if ("scrollBehavior" in el.style) el.scrollTo({ top, behavior: "smooth" });
    else el.scrollTop = top;
  }, [focusRequest, rows]);

  const visibleIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);

  /**
   * "重命名…" from the command palette and every freshly created node arrive
   * here. The store has already expanded the ancestors, so the row exists —
   * but with virtual scrolling the row may still be outside the rendered
   * window, and an `editingId` set for an unmounted row is invisible ("新建文档
   * 没反应"). Scroll first, then enter edit mode on the next frame.
   */
  const handledRename = useRef(0);
  const editFrame = useRef<number | null>(null);
  useEffect(() => {
    if (!renameRequest || handledRename.current === renameRequest.nonce) return;
    const index = rows.findIndex((row) => row.id === renameRequest.id);
    if (index < 0) return; // hidden inside a collapsed folder: parent not expanded (yet)
    handledRename.current = renameRequest.nonce;
    setActiveId(renameRequest.id);

    const el = containerRef.current;
    if (el) {
      const top = index * ROW_H;
      const bottom = top + ROW_H;
      const outside = top < el.scrollTop || bottom > el.scrollTop + el.clientHeight;
      if (outside) {
        // centring leaves context above and below, matching `focusRequest`
        const next = Math.max(0, top - Math.max(0, (el.clientHeight - ROW_H) / 2));
        el.scrollTop = next;
        setScrollTop(next);
      }
    }
    // one frame later the virtual window contains the row; setting the field
    // any earlier would target a row that is not mounted. The frame is not
    // cancelled by a later tree update — the edit must still happen.
    editFrame.current = requestAnimationFrame(() => {
      editFrame.current = null;
      setEditingId(renameRequest.id);
    });
  }, [renameRequest, rows]);

  useEffect(
    () => () => {
      if (editFrame.current !== null) cancelAnimationFrame(editFrame.current);
    },
    [],
  );

  /**
   * Enter (or F2) renames the sidebar's current row — the open document, or the
   * folder the user last clicked. The inline field selects the whole name, so a
   * rename is just "type, Enter".
   *
   * Anything that owns a caret (editor, title, dialog, menu) keeps its own
   * Enter; the window listener bails out on those. `useUi.getState()` is read
   * inside the handler so opening a dialog does not re-render the tree.
   */
  useEffect(() => {
    if (editingId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== "F2") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      // a caret, a menu or a dialog already owns this key
      if (
        el?.closest(
          "input, textarea, select, [contenteditable='true'], [role='menu'], [role='dialog'], [data-radix-popper-content-wrapper]",
        )
      ) {
        return;
      }
      const ui = useUi.getState();
      if (ui.searchOpen || ui.settingsOpen || ui.confirm.open) return;
      const target = [activeId, selectedId].find((id) => id && visibleIds.has(id));
      if (!target) return;
      e.preventDefault();
      setActiveId(target);
      setEditingId(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, editingId, selectedId, visibleIds]);

  /**
   * Double-clicking the empty area below the tree creates a document at the
   * root. Rows handle their own double-click (rename), so anything inside a
   * row is ignored here.
   */
  const lastCreate = useRef(0);
  const onContainerDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-tree-row]")) return;
      const now = Date.now();
      if (now - lastCreate.current < 400) return;
      lastCreate.current = now;
      void createDoc(null);
    },
    [createDoc],
  );

  const total = rows.length;
  const virtual = total > VIRTUALIZE_OVER;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - 6) : 0;
  const end = virtual
    ? Math.min(total, Math.ceil((scrollTop + viewport) / ROW_H) + 6)
    : total;
  const slice = virtual ? rows.slice(start, end) : rows;

  return (
    <div
      ref={containerRef}
      className="scroller scroll-pane auto-hide-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-4"
      onDoubleClick={onContainerDoubleClick}
      onContextMenu={onContextMenu}
      onScroll={(e) => {
        if (!virtual) return;
        const next = e.currentTarget.scrollTop;
        setScrollTop(next);
      }}
      onDragOver={(e) => {
        if (!dragId.current) return;
        // a row owns this hover (it stops propagation); this is the blank area
        if ((e.target as HTMLElement | null)?.closest("[data-tree-row]")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDrop(null);
        setDropBlank(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropBlank(false);
        cancelExpand();
      }}
      onDrop={(e) => {
        // empty-area drop -> move to workspace root end
        const dragged = dragId.current;
        dragId.current = null;
        setDrop(null);
        setDropBlank(false);
        if (!dragged) return;
        e.preventDefault();
        // skip the two system folders when appending to the root
        const rootOrder = (children[""] ?? []).filter((id2) => !nodes[id2]?.builtin).length;
        void move(dragged, null, rootOrder);
      }}
    >
      {rows.length === 0 && (
        <div className="px-3 py-6 text-[13.5px] leading-relaxed text-muted-foreground">
          {t("Click")} <span className="font-medium">+</span> {t("above to create one, or double-click the empty area.")}
        </div>
      )}
      {virtual && start > 0 && <div style={{ height: start * ROW_H }} />}
      {slice.map((row) => (
        <TreeRow
          key={row.id}
          node={row.node}
          depth={row.depth}
          selected={row.id === selectedId}
          active={row.id === activeId && row.id !== selectedId}
          expanded={!!expanded[row.id]}
          editing={row.id === editingId}
          dragging={row.id === draggedId}
          tooltipDisabled={draggedId !== null}
          dropZone={drop?.id === row.id ? drop.zone : null}
          onSelect={select}
          onToggle={toggleExpand}
          onActivate={onActivate}
          onStartEdit={onStartEdit}
          onStopEdit={onStopEdit}
          onRename={rename}
          onDelete={handleDelete}
          onSetCompleted={setCompleted}
          onSetPinned={setPinned}
          onCreateDoc={createDoc}
          onCreateFolder={createFolder}
          onDragStart={onDragStart}
          onDragOverRow={onDragOverRow}
          onDragLeaveRow={onDragLeaveRow}
          onDropRow={onDropRow}
          onDragEnd={onDragEnd}
        />
      ))}
      {virtual && end < total && <div style={{ height: (total - end) * ROW_H }} />}
      {dropBlank && draggedId !== null && (
        <div className="pointer-events-none mx-1 h-[2px] rounded bg-brand" />
      )}
      <div className="h-8" />
      <NodeContextMenu menu={menu} actions={menuActions} onClose={closeMenu} />
    </div>
  );
}
