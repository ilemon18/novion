import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { parentForNewNode } from "@/lib/tree-targets";
import { formatShortcut, isMac } from "@/lib/platform";

/**
 * One table for every application shortcut.
 *
 * Before this, the same combination was spelled out three times: once in the
 * keydown handler, once as the palette's `hint`, and once in a tooltip. The
 * registry is the single source, and `shortcutHint()` feeds the palette so a
 * displayed shortcut can no longer drift from the one that actually fires.
 */
export interface KeyBinding {
  /** command id this shortcut runs, when the palette has a matching entry */
  id: string;
  /** how the combination is displayed */
  shortcut: string;
  /** lowercase `event.key` */
  key: string;
  shift?: boolean;
  /** the focused input / textarea / editor keeps this key for itself */
  skipWhileTyping?: boolean;
  /** the shortcut only applies in this state (no selection → no action) */
  available?: () => boolean;
  /** when set, the binding only fires on that platform */
  platform?: "mac" | "windows";
  run: () => void;
}

/** True when a caret (editor, input, title field) currently owns the keyboard. */
export function isTypingTarget(): boolean {
  const element = document.activeElement as HTMLElement | null;
  return !!element?.closest?.("input, textarea, select, [contenteditable='true']");
}

export const KEYBINDINGS: KeyBinding[] = [
  // ------------------------------------------------------------ 编辑 / 历史
  {
    id: "workspace.undo",
    shortcut: "⌘Z",
    key: "z",
    skipWhileTyping: true,
    available: () => useWorkspace.getState().undoStack.length > 0,
    run: () => void useWorkspace.getState().undo(),
  },
  {
    id: "workspace.redo",
    shortcut: "⌘⇧Z",
    key: "z",
    shift: true,
    skipWhileTyping: true,
    available: () => useWorkspace.getState().redoStack.length > 0,
    run: () => void useWorkspace.getState().redo(),
  },
  {
    // Windows convention; ⌘⇧Z above stays bound there too.
    id: "workspace.redo",
    shortcut: "Ctrl+Y",
    key: "y",
    platform: "windows",
    skipWhileTyping: true,
    available: () => useWorkspace.getState().undoStack.length > 0,
    run: () => void useWorkspace.getState().redo(),
  },

  // ------------------------------------------------------------ 查找 / 导航
  {
    id: "find.inDoc",
    shortcut: "⌘F",
    key: "f",
    available: () => {
      const state = useWorkspace.getState();
      return !!state.selectedId && state.nodes[state.selectedId]?.kind === "doc";
    },
    run: () => {
      const ui = useUi.getState();
      ui.setFindOpen(!ui.findOpen);
    },
  },
  {
    id: "search.open",
    shortcut: "⌘K",
    key: "k",
    run: () => {
      const ui = useUi.getState();
      ui.setSearchOpen(!ui.searchOpen);
    },
  },
  {
    id: "command.open",
    shortcut: "⌘⇧P",
    key: "p",
    shift: true,
    run: () => {
      const ui = useUi.getState();
      ui.setCommandOpen(!ui.commandOpen);
    },
  },

  // ------------------------------------------------------------ 视图
  {
    id: "outline.toggle",
    shortcut: "⌘\\",
    key: "\\",
    available: () => useUi.getState().features.outline,
    run: () => useUi.getState().toggleOutline(),
  },
  {
    id: "sidebar.toggle",
    shortcut: "⌘⇧\\",
    key: "\\",
    shift: true,
    run: () => useUi.getState().toggleSidebar(),
  },
  {
    id: "settings.open",
    shortcut: "⌘,",
    key: ",",
    run: () => useUi.getState().setSettingsOpen(true),
  },

  // ------------------------------------------------------------ 文档
  {
    id: "save.flush",
    shortcut: "⌘S",
    key: "s",
    run: () => window.dispatchEvent(new Event("novion:flush")),
  },
  {
    id: "doc.new",
    shortcut: "⌘N",
    key: "n",
    run: () => {
      const state = useWorkspace.getState();
      void state.createDoc(parentForNewNode(state.nodes, state.selectedId));
    },
  },
  {
    id: "folder.new",
    shortcut: "⌘⇧N",
    key: "n",
    shift: true,
    run: () => void useWorkspace.getState().createFolder(null),
  },
];

function platformFits(binding: KeyBinding): boolean {
  if (!binding.platform) return true;
  return binding.platform === (isMac ? "mac" : "windows");
}

// One hint per command, always the first applicable binding: `workspace.redo`
// has both ⌘⇧Z and (on Windows) Ctrl+Y, and the palette should keep showing
// the primary one.
const HINTS = new Map<string, string>();
for (const binding of KEYBINDINGS) {
  if (!platformFits(binding) || HINTS.has(binding.id)) continue;
  HINTS.set(binding.id, binding.shortcut);
}

/**
 * The shortcut a command is bound to, for the palette's right-hand column.
 * Rewritten into the local convention on Windows (`⌘N` → `Ctrl+N`).
 */
export function shortcutHint(commandId: string): string | undefined {
  const hint = HINTS.get(commandId);
  return hint ? formatShortcut(hint) : undefined;
}

/** `undefined` when the event is not a registered shortcut. */
export function matchBinding(event: KeyboardEvent): KeyBinding | undefined {
  if (!(event.metaKey || event.ctrlKey)) return undefined;
  if (event.altKey) return undefined;
  const key = event.key.toLowerCase();
  return KEYBINDINGS.find(
    (binding) =>
      platformFits(binding) &&
      binding.key === key &&
      !!binding.shift === event.shiftKey,
  );
}