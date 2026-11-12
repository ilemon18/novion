import { create } from "zustand";
import {
  api,
  errorMessage,
  type NodeKind,
  type TreeNode,
  type Workspace,
} from "@/lib/tauri";
import { canHostChildren } from "@/lib/tree-targets";
import { useUi } from "@/store/ui";

export type { NodeKind, TreeNode };

export interface WorkspaceState {
  ready: boolean;
  rootPath: string;
  nodes: Record<string, TreeNode>;
  /** parentId ("" = root) -> ordered child ids */
  children: Record<string, string[]>;
  selectedId: string | null;
  expanded: Record<string, boolean>;
  /**
   * Last "reveal this folder in the sidebar" request. The nonce makes a repeat
   * click on the same breadcrumb scroll again; the sidebar consumes it and
   * never changes the selection, so the open document stays open.
   */
  focusRequest: { id: string; nonce: number } | null;
  /** Asks the sidebar to open its inline rename field for `id` (palette ⇄ tree). */
  renameRequest: { id: string; nonce: number } | null;
  /**
   * Tree snapshots for ⌘Z. Dragging, renaming, archiving and moving to the
   * trash all rewrite `workspace.json`, so undo is the same write with an
   * older tree. Document bodies keep their own editor-level history.
   */
  undoStack: Workspace[];
  redoStack: Workspace[];
  busy: boolean;
  error: string | null;

  init: () => Promise<void>;
  apply: (ws: Workspace) => void;
  /** Full re-index after the workspace root changed (storage switch). */
  adopt: (ws: Workspace, root: string) => void;
  setError: (msg: string | null) => void;
  select: (id: string | null) => void;
  /** Expands every ancestor of `id` then selects it (search jumps). */
  reveal: (id: string) => void;
  /** Expands a folder (and its ancestors) and asks the sidebar to scroll to it. */
  focusFolder: (id: string) => void;
  /** Opens the sidebar's inline rename field for `id`, expanding its parents. */
  requestRename: (id: string) => void;
  toggleExpand: (id: string) => void;
  createDoc: (parentId: string | null) => Promise<string | null>;
  createFolder: (parentId: string | null) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setCompleted: (id: string, completed: boolean) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  expandAll: () => void;
  collapseAll: () => void;
  restore: (id: string) => Promise<void>;
  purge: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  move: (id: string, parentId: string | null, index: number) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const ROOT = "";

/** Deep enough for a long organising session, small enough to stay free. */
const HISTORY_LIMIT = 30;

/** The live tree shaped exactly like `workspace.json`. */
function workspaceOf(state: WorkspaceState): Workspace {
  return { version: 1, updatedAt: Date.now(), nodes: Object.values(state.nodes) };
}

function pushHistory(stack: Workspace[], snapshot: Workspace): Workspace[] {
  return [...stack, snapshot].slice(-HISTORY_LIMIT);
}

/** Stable ids of the two system folders, mirrored from the Rust side. */
export const COMPLETED_ID = "f_completed";
export const TRASH_ID = "f_trash";

function sameNode(old: TreeNode, next: TreeNode): boolean {
  return (
    old.kind === next.kind &&
    old.name === next.name &&
    old.parentId === next.parentId &&
    old.order === next.order &&
    old.updatedAt === next.updatedAt &&
    old.builtin === next.builtin &&
    old.originParent === next.originParent &&
    old.completedAt === next.completedAt &&
    old.trashedAt === next.trashedAt &&
    old.pinnedAt === next.pinnedAt
  );
}

/**
 * Re-indexes the flat node list into `nodes` + `children`.
 *
 * Unchanged nodes keep their previous object identity, and when *nothing* at all
 * changed the previous containers are returned as well: a workspace write that
 * resolved to the same tree (a rename that was a no-op, an optimistic update the
 * backend echoed back) then costs zero re-renders.
 */
function indexWorkspace(
  ws: Workspace,
  prev: Record<string, TreeNode>,
  prevChildren?: Record<string, string[]>,
) {
  const nodes: Record<string, TreeNode> = {};
  const children: Record<string, string[]> = { [ROOT]: [] };
  let changed = Object.keys(prev).length !== ws.nodes.length;

  for (const n of ws.nodes) {
    const old = prev[n.id];
    // keep object identity when nothing changed so memoised rows stay quiet
    if (old && sameNode(old, n)) {
      nodes[n.id] = old;
    } else {
      nodes[n.id] = n;
      changed = true;
    }
    const key = n.parentId ?? ROOT;
    (children[key] ??= []).push(n.id);
    if (n.kind === "folder") children[n.id] ??= [];
  }

  if (!changed) return { nodes: prev, children: prevChildren ?? children, changed };

  for (const key of Object.keys(children)) {
    // pinned documents float to the top of their folder, mirroring the Rust
    // `siblings()` ordering so drag & drop indices agree with what is rendered
    children[key].sort((a, b) => {
      const na = nodes[a];
      const nb = nodes[b];
      const pa = na?.pinnedAt ?? 0;
      const pb = nb?.pinnedAt ?? 0;
      if (!!pb !== !!pa) return pb > 0 ? 1 : -1;
      if (pa !== pb) return pb - pa;
      return (na?.order ?? 0) - (nb?.order ?? 0);
    });
  }
  return { nodes, children, changed };
}

/**
 * Guards the create actions against a doubled click: the row is only appended
 * once the backend answered, so two rapid invocations both looked "unhandled"
 * and produced two documents.
 */
let createInFlight = false;

/** `requestRename` only works on a mounted sidebar, so make sure it is there. */
function revealForRename(id: string) {
  const { requestRename } = useWorkspace.getState();
  if (!useUi.getState().sidebarOpen) useUi.getState().setSidebarOpen(true);
  requestRename(id);
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ready: false,
  rootPath: "",
  nodes: {},
  children: { [ROOT]: [] },
  selectedId: null,
  expanded: {},
  focusRequest: null,
  renameRequest: null,
  undoStack: [],
  redoStack: [],
  busy: false,
  error: null,

  init: async () => {
    try {
      set({ busy: true });
      const [root, ws] = await Promise.all([api.root(), api.ensure(useUi.getState().locale)]);
      const { nodes, children } = indexWorkspace(ws, {});
      const expanded: Record<string, boolean> = {};
      for (const n of ws.nodes) if (n.kind === "folder") expanded[n.id] = true;
      const firstDoc = ws.nodes.find(
        (n) =>
          n.kind === "doc" &&
          !n.completedAt &&
          !n.trashedAt &&
          !(n.parentId && isTrashed(nodes, n.parentId)),
      );
      set({
        ready: true,
        busy: false,
        rootPath: root,
        nodes,
        children,
        expanded,
        selectedId: firstDoc?.id ?? null,
        undoStack: [],
        redoStack: [],
        error: null,
      });
    } catch (err) {
      set({ ready: true, busy: false, error: errorMessage(err) });
    }
  },

  apply: (ws) => {
    const state = get();
    const { nodes, children, changed } = indexWorkspace(ws, state.nodes, state.children);
    const selectedId = state.selectedId;
    const nextSelected = selectedId && nodes[selectedId] ? selectedId : null;
    // an identical tree must not wake the sidebar (or the editor) up at all
    if (!changed && nextSelected === selectedId) return;
    set({ nodes, children, selectedId: nextSelected });
  },

  adopt: (ws, root) => {
    const { nodes, children } = indexWorkspace(ws, {});
    const expanded: Record<string, boolean> = {};
    for (const n of ws.nodes) if (n.kind === "folder") expanded[n.id] = true;
    const firstDoc = ws.nodes.find(
      (n) =>
        n.kind === "doc" &&
        !n.completedAt &&
        !n.trashedAt &&
        !(n.parentId && isTrashed(nodes, n.parentId)),
    );
    set({
      ready: true,
      rootPath: root,
      nodes,
      children,
      expanded,
      selectedId: firstDoc?.id ?? null,
      undoStack: [],
      redoStack: [],
      error: null,
    });
  },

  setError: (error) => set({ error }),

  select: (id) => set({ selectedId: id }),

  reveal: (id) => {
    const { nodes, expanded } = get();
    const next = { ...expanded };
    let cur = nodes[id];
    let guard = 0;
    while (cur?.parentId && guard++ < 64) {
      next[cur.parentId] = true;
      cur = nodes[cur.parentId];
    }
    set({ expanded: next, selectedId: id });
  },

  focusFolder: (id) => {
    const { nodes, expanded, focusRequest } = get();
    if (!nodes[id]) return;
    // open the folder itself and every ancestor, otherwise the row the sidebar
    // is about to scroll to could still be hidden inside a collapsed parent
    const next = { ...expanded };
    let cur: TreeNode | undefined = nodes[id];
    let guard = 0;
    while (cur && guard++ < 64) {
      if (cur.kind === "folder") next[cur.id] = true;
      cur = cur.parentId ? nodes[cur.parentId] : undefined;
    }
    // no selection change on purpose: the user is reading a document and only
    // asked where it lives, so the editor must not close
    set({
      expanded: next,
      focusRequest: { id, nonce: (focusRequest?.nonce ?? 0) + 1 },
    });
  },

  requestRename: (id) => {
    const { nodes, expanded, renameRequest } = get();
    if (!nodes[id]) return;
    // the row has to be on screen: a collapsed parent would swallow the edit
    const next = { ...expanded };
    let cur: TreeNode | undefined = nodes[id];
    let guard = 0;
    while (cur && guard++ < 64) {
      if (cur.parentId) next[cur.parentId] = true;
      cur = cur.parentId ? nodes[cur.parentId] : undefined;
    }
    set({
      expanded: next,
      renameRequest: { id, nonce: (renameRequest?.nonce ?? 0) + 1 },
    });
  },

  toggleExpand: (id) =>
    set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),

  createDoc: async (parentId) => {
    if (createInFlight) return null;
    createInFlight = true;
    const before = workspaceOf(get());
    try {
      // a stale selection (trashed / archived / system group) must not reach
      // the backend, which refuses those parents and used to fail silently
      const target = canHostChildren(get().nodes, parentId) ? parentId : null;
      const res = await api.createDoc(target, "");
      set((s) => ({ undoStack: pushHistory(s.undoStack, before), redoStack: [] }));
      get().apply(res.workspace);
      if (target) set((s) => ({ expanded: { ...s.expanded, [target]: true } }));
      set({ selectedId: res.docId });
      revealForRename(res.docId);
      return res.docId;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    } finally {
      createInFlight = false;
    }
  },

  createFolder: async (parentId) => {
    if (createInFlight) return;
    createInFlight = true;
    const before = workspaceOf(get());
    try {
      const target = canHostChildren(get().nodes, parentId) ? parentId : null;
      const res = await api.createFolder(target, "New folder");
      set((s) => ({ undoStack: pushHistory(s.undoStack, before), redoStack: [] }));
      get().apply(res.workspace);
      if (target) set((s) => ({ expanded: { ...s.expanded, [target]: true } }));
      revealForRename(res.folderId);
    } catch (err) {
      set({ error: errorMessage(err) });
    } finally {
      createInFlight = false;
    }
  },

  rename: async (id, name) => {
    const node = get().nodes[id];
    if (!node) return;
    const clean = name.trim() || (node.kind === "doc" ? "Untitled" : "New folder");
    if (clean === node.name) return;
    const before = workspaceOf(get());
    // optimistic: the row should not flicker while the file write lands
    set((s) => ({ nodes: { ...s.nodes, [id]: { ...node, name: clean } } }));
    try {
      const ws =
        node.kind === "doc"
          ? await api.renameDoc(id, clean)
          : await api.renameFolder(id, clean);
      set((s) => ({ undoStack: pushHistory(s.undoStack, before), redoStack: [] }));
      get().apply(ws);
    } catch (err) {
      set((s) => ({ nodes: { ...s.nodes, [id]: node }, error: errorMessage(err) }));
    }
  },

  remove: async (id) => {
    const node = get().nodes[id];
    if (!node) return;
    const before = workspaceOf(get());
    try {
      const ws = node.kind === "doc" ? await api.deleteDoc(id) : await api.deleteFolder(id);
      set((s) => ({ undoStack: pushHistory(s.undoStack, before), redoStack: [] }));
      get().apply(ws);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  setCompleted: async (id, completed) => {
    const before = workspaceOf(get());
    try {
      const ws = await api.setCompleted(id, completed);
      set((s) => ({ undoStack: pushHistory(s.undoStack, before), redoStack: [] }));
      get().apply(ws);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  setPinned: async (id, pinned) => {
    const before = workspaceOf(get());
    try {
      const ws = await api.setPinned(id, pinned);
      set((s) => ({ undoStack: pushHistory(s.undoStack, before), redoStack: [] }));
      get().apply(ws);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  expandAll: () =>
    set((s) => {
      const expanded = { ...s.expanded };
      for (const node of Object.values(s.nodes)) {
        if (node.kind === "folder" && !node.builtin) expanded[node.id] = true;
      }
      return { expanded };
    }),

  collapseAll: () =>
    set((s) => {
      const expanded = { ...s.expanded };
      for (const node of Object.values(s.nodes)) {
        if (node.kind === "folder" && !node.builtin) expanded[node.id] = false;
      }
      return { expanded };
    }),

  restore: async (id) => {
    const before = workspaceOf(get());
    try {
      const ws = await api.restoreNode(id);
      set((s) => ({ undoStack: pushHistory(s.undoStack, before), redoStack: [] }));
      get().apply(ws);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  purge: async (id) => {
    try {
      const ws = await api.purgeNode(id);
      // the files are gone for good: an older snapshot must never resurrect a
      // node that no longer has a document behind it
      set({ undoStack: [], redoStack: [] });
      get().apply(ws);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  emptyTrash: async () => {
    try {
      const ws = await api.emptyTrash();
      set({ undoStack: [], redoStack: [] });
      get().apply(ws);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  move: async (id, parentId, index) => {
    const before = workspaceOf(get());
    try {
      const ws = await api.moveNode(id, parentId, index);
      set((s) => ({ undoStack: pushHistory(s.undoStack, before), redoStack: [] }));
      get().apply(ws);
      if (parentId) set((s) => ({ expanded: { ...s.expanded, [parentId]: true } }));
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  undo: async () => {
    const { undoStack, redoStack } = get();
    if (!undoStack.length) return;
    const target = undoStack[undoStack.length - 1];
    const current = workspaceOf(get());
    try {
      const ws = await api.restoreWorkspace(target);
      set({
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, current].slice(-HISTORY_LIMIT),
      });
      get().apply(ws);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  redo: async () => {
    const { undoStack, redoStack } = get();
    if (!redoStack.length) return;
    const target = redoStack[redoStack.length - 1];
    const current = workspaceOf(get());
    try {
      const ws = await api.restoreWorkspace(target);
      set({
        undoStack: [...undoStack, current].slice(-HISTORY_LIMIT),
        redoStack: redoStack.slice(0, -1),
      });
      get().apply(ws);
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },
}));

export const selectChildren = (parentId: string | null) => (s: WorkspaceState) =>
  s.children[parentId ?? ROOT] ?? [];

/** True when the node or any ancestor sits in 回收站. */
export function isTrashed(nodes: Record<string, TreeNode>, id: string): boolean {
  let cur: TreeNode | undefined = nodes[id];
  let guard = 0;
  while (cur && guard++ < 128) {
    if (cur.trashedAt || cur.builtin === "trash") return true;
    cur = cur.parentId ? nodes[cur.parentId] : undefined;
  }
  return false;
}

/** True when every expandable folder is currently open. */
export function allFoldersExpanded(
  nodes: Record<string, TreeNode>,
  expanded: Record<string, boolean>,
): boolean {
  const folders = Object.values(nodes).filter((n) => n.kind === "folder" && !n.builtin);
  return folders.length > 0 && folders.every((n) => expanded[n.id]);
}

/**
 * Folders from the workspace root down to `id`'s parent, root first — the
 * chain a breadcrumb renders. System folders (回收站 / 已归档) are included so
 * a trashed document still shows where it sits.
 */
export function ancestorFolders(
  nodes: Record<string, TreeNode>,
  id: string,
): TreeNode[] {
  const chain: TreeNode[] = [];
  let cur = nodes[id];
  let guard = 0;
  while (cur?.parentId && guard++ < 64) {
    const parent = nodes[cur.parentId];
    if (!parent) break;
    chain.push(parent);
    cur = parent;
  }
  return chain.reverse();
}

/** True when `ancestorId` is on the node's parent chain (or is the node). */
export function hasAncestor(
  nodes: Record<string, TreeNode>,
  id: string,
  ancestorId: string,
): boolean {
  let cur: TreeNode | undefined = nodes[id];
  let guard = 0;
  while (cur && guard++ < 128) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId ? nodes[cur.parentId] : undefined;
  }
  return false;
}

/** Flattened, visible rows for the sidebar (folders collapsed are skipped,
 * system folders are rendered in their own section). */
export interface FlatRow {
  id: string;
  depth: number;
  node: TreeNode;
}

export function flattenTree(
  nodes: Record<string, TreeNode>,
  children: Record<string, string[]>,
  expanded: Record<string, boolean>,
): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const id of children[parentId] ?? []) {
      const node = nodes[id];
      if (!node || node.builtin) continue;
      rows.push({ id, depth, node });
      if (node.kind === "folder" && expanded[id]) walk(id, depth + 1);
    }
  };
  walk(ROOT, 0);
  return rows;
}

/** Fully expanded rows below a system folder (回收站 / 已归档). */
export function flattenAll(
  nodes: Record<string, TreeNode>,
  children: Record<string, string[]>,
  rootId: string,
): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const id of children[parentId] ?? []) {
      const node = nodes[id];
      if (!node) continue;
      rows.push({ id, depth, node });
      if (node.kind === "folder") walk(id, depth + 1);
    }
  };
  walk(rootId, 0);
  return rows;
}

/** Number of documents below a system folder. */
export function countDocs(
  nodes: Record<string, TreeNode>,
  children: Record<string, string[]>,
  rootId: string,
): number {
  return sectionTree(nodes, children, rootId).docs;
}

/**
 * Fully expanded rows below a system folder plus its document count.
 *
 * The badge and the list are always needed together, so they come from one
 * walk: counting used to build every `FlatRow` again only to filter it.
 */
export function sectionTree(
  nodes: Record<string, TreeNode>,
  children: Record<string, string[]>,
  rootId: string,
): { rows: FlatRow[]; docs: number } {
  const rows: FlatRow[] = [];
  let docs = 0;
  const walk = (parentId: string, depth: number) => {
    for (const id of children[parentId] ?? []) {
      const node = nodes[id];
      if (!node) continue;
      rows.push({ id, depth, node });
      if (node.kind === "folder") walk(id, depth + 1);
      else docs += 1;
    }
  };
  walk(rootId, 0);
  return { rows, docs };
}