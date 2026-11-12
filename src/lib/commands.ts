import {
  ArrowDown,
  ArrowUp,
  Bold,
  CheckSquare,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Copy,
  Eraser,
  FileDown,
  FileText,
  FolderPlus,
  Highlighter,
  Import,
  Italic,
  PanelLeft,
  Pencil,
  Redo2,
  Undo2,
  HardDrive,
  Heading,
  History,
  Moon,
  NotebookPen,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  SquareCheckBig,
  Strikethrough,
  Sun,
  Trash2,
  Underline,
  Archive,
  Laptop,
  type LucideIcon,
} from "lucide-react";
import { api, errorMessage } from "@/lib/tauri";
import { exportDoc, exportWorkspace } from "@/lib/export-actions";
import { importMarkdownFolder } from "@/lib/import-actions";
import { getActiveEditor } from "@/lib/editor-registry";
import { useUi } from "@/store/ui";
import { parentForNewNode } from "@/lib/tree-targets";
import { t } from "@/i18n";
import {
  COMPLETED_ID,
  TRASH_ID,
  flattenAll,
  hasAncestor,
  useWorkspace,
} from "@/store/workspace";

/**
 * Everything the ⌘⇧P palette can run.
 *
 * Actions are plain functions over the stores (never React state), so they can
 * also be triggered from menus and keyboard shortcuts without prop drilling.
 * `available()` decides whether an entry is shown for the current selection.
 *
 * `title` / `detail` hold the English source text and are translated where they
 * are rendered, so the palette follows the language setting without rebuilding
 * the registry.
 */

/** Stable identifiers: never translate these, the palette groups by them. */
export type CommandGroup = "doc" | "edit" | "view" | "export" | "settings";

export interface Command {
  id: string;
  /** English source text, translated at render time */
  title: string;
  detail?: string;
  /** shortcut hint rendered on the right of the row */
  hint?: string;
  keywords?: string[];
  group: CommandGroup;
  icon: LucideIcon;
  available: () => boolean;
  run: () => void;
}

function selectedDocId(): string | null {
  const state = useWorkspace.getState();
  const id = state.selectedId;
  if (!id) return null;
  return state.nodes[id]?.kind === "doc" ? id : null;
}

function hasDoc() {
  return selectedDocId() !== null;
}

function withErrorHandling(run: () => Promise<unknown>) {
  return () => {
    void run().catch((err) => {
      useUi.getState().notify(errorMessage(err), { tone: "error", timeout: 7000 });
    });
  };
}

function ui() {
  return useUi.getState();
}

/** Documents in sidebar order, excluding anything archived or in the trash. */
function orderedDocs(): string[] {
  const state = useWorkspace.getState();
  return flattenAll(state.nodes, state.children, "")
    .filter((row) => row.node.kind === "doc")
    .filter(
      (row) =>
        !hasAncestor(state.nodes, row.id, TRASH_ID) &&
        !hasAncestor(state.nodes, row.id, COMPLETED_ID),
    )
    .map((row) => row.id);
}

function stepDoc(delta: number) {
  const id = selectedDocId();
  if (!id) return;
  const list = orderedDocs();
  const at = list.indexOf(id);
  if (at < 0 || list.length < 2) return;
  const next = list[(at + delta + list.length) % list.length];
  useWorkspace.getState().reveal(next);
}

export const COMMANDS: Command[] = [
  // ------------------------------------------------------------- document
  {
    id: "workspace.undo",
    title: "Undo",
    detail: "Undo the last move, rename, archive or delete",
    hint: "⌘Z",
    keywords: ["undo", "revert", "撤销", "后悔"],
    group: "doc",
    icon: Undo2,
    available: () => useWorkspace.getState().undoStack.length > 0,
    run: () => void useWorkspace.getState().undo(),
  },
  {
    id: "workspace.redo",
    title: "Redo",
    detail: "Redo the change you just undid",
    hint: "⌘⇧Z",
    keywords: ["redo", "重做"],
    group: "doc",
    icon: Redo2,
    available: () => useWorkspace.getState().redoStack.length > 0,
    run: () => void useWorkspace.getState().redo(),
  },
  {
    id: "doc.new",
    title: "New document",
    detail: "Create it inside the selected folder",
    hint: "⌘N",
    keywords: ["new", "doc", "create", "新建", "文档"],
    group: "doc",
    icon: Plus,
    available: () => true,
    run: () => {
      const state = useWorkspace.getState();
      void state.createDoc(parentForNewNode(state.nodes, state.selectedId));
    },
  },
  {
    id: "folder.new",
    title: "New folder",
    detail: "Created at the first level",
    hint: "⌘⇧N",
    keywords: ["new", "folder", "create", "文件夹", "新建"],
    group: "doc",
    icon: FolderPlus,
    available: () => true,
    run: () => void useWorkspace.getState().createFolder(null),
  },
  {
    id: "doc.completed",
    title: "Archive",
    keywords: ["done", "complete", "archive", "归档", "完成"],
    group: "doc",
    icon: SquareCheckBig,
    available: () => {
      const id = selectedDocId();
      if (!id) return false;
      return !useWorkspace.getState().nodes[id]?.completedAt;
    },
    run: () => {
      const id = selectedDocId();
      if (id) void useWorkspace.getState().setCompleted(id, true);
    },
  },
  {
    id: "doc.uncompleted",
    title: "Unarchive",
    keywords: ["undo", "restore", "unarchive", "归档", "完成", "取消"],
    group: "doc",
    icon: SquareCheckBig,
    available: () => {
      const id = selectedDocId();
      return !!id && !!useWorkspace.getState().nodes[id]?.completedAt;
    },
    run: () => {
      const id = selectedDocId();
      if (id) void useWorkspace.getState().setCompleted(id, false);
    },
  },
  {
    id: "doc.pin",
    title: "Pin to top of folder",
    keywords: ["pin", "置顶", "收藏"],
    group: "doc",
    icon: Pin,
    available: () => {
      const id = selectedDocId();
      return !!id && !useWorkspace.getState().nodes[id]?.pinnedAt;
    },
    run: () => {
      const id = selectedDocId();
      if (id) void useWorkspace.getState().setPinned(id, true);
    },
  },
  {
    id: "doc.unpin",
    title: "Unpin",
    keywords: ["unpin", "置顶", "取消"],
    group: "doc",
    icon: PinOff,
    available: () => {
      const id = selectedDocId();
      return !!id && !!useWorkspace.getState().nodes[id]?.pinnedAt;
    },
    run: () => {
      const id = selectedDocId();
      if (id) void useWorkspace.getState().setPinned(id, false);
    },
  },
  {
    id: "doc.history",
    title: "Version history…",
    detail: "Browse and restore earlier versions of this note",
    keywords: ["history", "version", "restore", "版本", "历史", "恢复"],
    group: "doc",
    icon: History,
    available: () => hasDoc() && ui().features.history,
    run: () => {
      const id = selectedDocId();
      if (id) ui().openHistory(id);
    },
  },

  {
    id: "doc.rename",
    title: "Rename…",
    detail: "Edit the name directly in the sidebar",
    hint: "F2",
    keywords: ["rename", "title", "重命名", "改名"],
    group: "doc",
    icon: Pencil,
    available: hasDoc,
    run: () => {
      const id = selectedDocId();
      if (id) useWorkspace.getState().requestRename(id);
    },
  },
  {
    id: "doc.duplicate",
    title: "Duplicate",
    detail: "Copy the body next to the original",
    keywords: ["duplicate", "copy", "clone", "副本", "复制"],
    group: "doc",
    icon: Copy,
    available: hasDoc,
    run: () => {
      const id = selectedDocId();
      if (!id) return;
      void (async () => {
        try {
          const state = useWorkspace.getState();
          const node = state.nodes[id];
          const doc = await api.readDoc(id);
          const name = t("{name} copy", { name: node?.name || t("Untitled") });
          const res = await api.duplicateDoc(id, name, doc.content);
          state.apply(res.workspace);
          state.select(res.docId);
          ui().notify(t("Created “{name}”", { name }), { tone: "success" });
        } catch (err) {
          ui().notify(errorMessage(err), { tone: "error", timeout: 7000 });
        }
      })();
    },
  },
  {
    id: "doc.delete",
    title: "Move to Trash",
    keywords: ["delete", "remove", "trash", "删除", "回收站"],
    group: "doc",
    icon: Trash2,
    available: hasDoc,
    run: () => {
      const id = selectedDocId();
      if (!id) return;
      const state = useWorkspace.getState();
      const node = state.nodes[id];
      ui().askConfirm({
        title: t("Move to Trash?"),
        description: t("“{name}” will be moved to the Trash. You can restore it at any time.", {
          name: node?.name || t("Untitled"),
        }),
        confirmLabel: t("Move to Trash"),
        destructive: true,
        onConfirm: () => void state.remove(id),
      });
    },
  },

  // ----------------------------------------------------------------- edit
  {
    id: "format.bold",
    title: "Bold",
    hint: "⌘B",
    keywords: ["bold", "加粗"],
    group: "edit",
    icon: Bold,
    available: () => !!getActiveEditor(),
    run: () => getActiveEditor()?.chain().focus().toggleBold().run(),
  },
  {
    id: "format.italic",
    title: "Italic",
    hint: "⌘I",
    keywords: ["italic", "斜体"],
    group: "edit",
    icon: Italic,
    available: () => !!getActiveEditor(),
    run: () => getActiveEditor()?.chain().focus().toggleItalic().run(),
  },
  {
    id: "format.underline",
    title: "Underline",
    hint: "⌘U",
    keywords: ["underline", "下划线"],
    group: "edit",
    icon: Underline,
    available: () => !!getActiveEditor(),
    run: () => getActiveEditor()?.chain().focus().toggleUnderline().run(),
  },
  {
    id: "format.strike",
    title: "Strikethrough",
    keywords: ["strike", "删除线"],
    group: "edit",
    icon: Strikethrough,
    available: () => !!getActiveEditor(),
    run: () => getActiveEditor()?.chain().focus().toggleStrike().run(),
  },
  {
    id: "format.highlight",
    title: "Highlight",
    keywords: ["highlight", "mark", "高亮"],
    group: "edit",
    icon: Highlighter,
    available: () => !!getActiveEditor(),
    run: () =>
      getActiveEditor()?.chain().focus().toggleHighlight({ color: "#f9e79a" }).run(),
  },
  {
    id: "format.code",
    title: "Inline code",
    keywords: ["code", "代码"],
    group: "edit",
    icon: Code2,
    available: () => !!getActiveEditor(),
    run: () => getActiveEditor()?.chain().focus().toggleCode().run(),
  },
  {
    id: "format.clear",
    title: "Clear formatting",
    keywords: ["clear", "plain", "清除", "格式"],
    group: "edit",
    icon: Eraser,
    available: () => !!getActiveEditor(),
    run: () => getActiveEditor()?.chain().focus().unsetAllMarks().run(),
  },
  {
    id: "format.todo",
    title: "Toggle task list",
    keywords: ["task", "todo", "待办", "清单"],
    group: "edit",
    icon: CheckSquare,
    available: () => !!getActiveEditor(),
    run: () => getActiveEditor()?.chain().focus().toggleTaskList().run(),
  },

  // ----------------------------------------------------------------- view
  {
    id: "doc.prev",
    title: "Previous document",
    keywords: ["previous", "prev", "上一篇", "上一个"],
    group: "view",
    icon: ArrowUp,
    available: hasDoc,
    run: () => stepDoc(-1),
  },
  {
    id: "doc.next",
    title: "Next document",
    keywords: ["next", "下一篇", "下一个"],
    group: "view",
    icon: ArrowDown,
    available: hasDoc,
    run: () => stepDoc(1),
  },
  {
    id: "find.inDoc",
    title: "Find in this note",
    hint: "⌘F",
    keywords: ["find", "search", "查找", "文内"],
    group: "view",
    icon: Search,
    available: hasDoc,
    run: () => ui().setFindOpen(true),
  },
  {
    id: "search.open",
    title: "Search notes",
    hint: "⌘K",
    keywords: ["search", "find", "搜索", "查找"],
    group: "view",
    icon: Search,
    available: () => true,
    run: () => ui().setSearchOpen(true),
  },
  {
    id: "sidebar.toggle",
    title: "Toggle sidebar",
    hint: "⌘⇧\\",
    keywords: ["sidebar", "panel", "focus", "侧边栏", "导航", "专注"],
    group: "view",
    icon: PanelLeft,
    available: () => true,
    run: () => ui().toggleSidebar(),
  },
  {
    id: "outline.toggle",
    title: "Toggle outline",
    hint: "⌘\\",
    keywords: ["outline", "toc", "heading", "大纲", "目录"],
    group: "view",
    icon: Heading,
    available: () => hasDoc() && ui().features.outline,
    run: () => ui().toggleOutline(),
  },
  {
    id: "tree.expand",
    title: "Expand all folders",
    keywords: ["expand", "展开"],
    group: "view",
    icon: ChevronsUpDown,
    available: () => true,
    run: () => useWorkspace.getState().expandAll(),
  },
  {
    id: "tree.collapse",
    title: "Collapse all folders",
    keywords: ["collapse", "收起"],
    group: "view",
    icon: ChevronsDownUp,
    available: () => true,
    run: () => useWorkspace.getState().collapseAll(),
  },
  {
    id: "theme.light",
    title: "Light theme",
    keywords: ["theme", "light", "浅色", "亮"],
    group: "view",
    icon: Sun,
    available: () => ui().theme !== "light",
    run: () => ui().setTheme("light"),
  },
  {
    id: "theme.dark",
    title: "Dark theme",
    keywords: ["theme", "dark", "深色", "暗"],
    group: "view",
    icon: Moon,
    available: () => ui().theme !== "dark",
    run: () => ui().setTheme("dark"),
  },
  {
    id: "theme.system",
    title: "Follow system appearance",
    keywords: ["theme", "system", "auto", "跟随", "系统"],
    group: "view",
    icon: Laptop,
    available: () => ui().theme !== "system",
    run: () => ui().setTheme("system"),
  },

  // --------------------------------------------------------------- export
  {
    id: "export.md",
    title: "Export this note as Markdown",
    keywords: ["export", "markdown", "md", "导出"],
    group: "export",
    icon: FileDown,
    available: hasDoc,
    run: () => {
      const id = selectedDocId();
      if (id) void exportDoc(id, "md");
    },
  },
  {
    id: "export.html",
    title: "Export this note as HTML",
    detail: "One web page with its images alongside",
    keywords: ["export", "html", "导出"],
    group: "export",
    icon: FileText,
    available: hasDoc,
    run: () => {
      const id = selectedDocId();
      if (id) void exportDoc(id, "html");
    },
  },
  {
    id: "export.json",
    title: "Export this note as JSON",
    detail: "Raw TipTap data",
    keywords: ["export", "json", "raw", "导出"],
    group: "export",
    icon: Archive,
    available: hasDoc,
    run: () => {
      const id = selectedDocId();
      if (id) void exportDoc(id, "json");
    },
  },
  {
    id: "import.markdown",
    title: "Import a Markdown folder…",
    detail: "Compatible with Obsidian and Notion exports",
    keywords: ["import", "markdown", "obsidian", "notion", "导入"],
    group: "doc",
    icon: Import,
    available: () => true,
    run: () => void importMarkdownFolder(),
  },
  {
    id: "export.backup",
    title: "Back up the whole workspace",
    detail: "Raw JSON copy plus a Markdown mirror",
    keywords: ["backup", "export", "archive", "备份", "导出"],
    group: "export",
    icon: HardDrive,
    available: () => true,
    run: () => void exportWorkspace(),
  },

  // ------------------------------------------------------------- settings
  {
    id: "settings.open",
    title: "Open settings",
    hint: "⌘,",
    keywords: ["settings", "preferences", "设置"],
    group: "settings",
    icon: Settings,
    available: () => true,
    run: () => ui().setSettingsOpen(true),
  },
  {
    id: "settings.language",
    title: "Language",
    detail: "English, 简体中文, 繁體中文, 日本語, Español",
    keywords: ["language", "locale", "english", "chinese", "japanese", "spanish", "语言", "多语言"],
    group: "settings",
    icon: Settings,
    available: () => true,
    run: () => {
      ui().setSettingsSection("general");
      ui().setSettingsOpen(true);
    },
  },
  {
    id: "settings.notion",
    title: "Notion sync settings",
    keywords: ["notion", "sync", "同步"],
    group: "settings",
    icon: NotebookPen,
    available: () => true,
    run: () => {
      ui().setSettingsSection("notion");
      ui().setSettingsOpen(true);
    },
  },
  {
    id: "settings.storage",
    title: "Storage location and backup",
    keywords: ["storage", "icloud", "folder", "存储", "位置", "备份"],
    group: "settings",
    icon: HardDrive,
    available: () => true,
    run: () => {
      ui().setSettingsSection("storage");
      ui().setSettingsOpen(true);
    },
  },
  {
    id: "storage.reveal",
    title: "Show the data folder",
    keywords: ["finder", "open", "reveal", "打开", "目录"],
    group: "settings",
    icon: HardDrive,
    available: () => true,
    run: withErrorHandling(() => api.revealStorageFolder()),
  },
];

export const COMMAND_GROUPS: CommandGroup[] = ["doc", "edit", "view", "export", "settings"];

/** English source labels, translated where the palette renders them. */
export const COMMAND_GROUP_LABELS: Record<CommandGroup, string> = {
  doc: "Document",
  edit: "Edit",
  view: "View",
  export: "Export",
  settings: "Settings",
};

export function availableCommands(): Command[] {
  return COMMANDS.filter((command) => {
    try {
      return command.available();
    } catch {
      return false;
    }
  });
}

/** Fuzzy-ish match: title first, then detail and keywords. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const scored: { command: Command; score: number }[] = [];
  for (const command of commands) {
    const title = t(command.title).toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score = 100;
    else if (title.includes(q)) score = 70;
    else if (t(command.detail ?? "").toLowerCase().includes(q)) score = 40;
    else if (command.keywords?.some((word) => word.toLowerCase().includes(q))) score = 30;
    if (score > 0) scored.push({ command, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.command);
}