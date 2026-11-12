import {
  ChevronsDownUp,
  ChevronsUpDown,
  FolderPlus,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { allFoldersExpanded, useWorkspace } from "@/store/workspace";
import { parentForNewNode } from "@/lib/tree-targets";
import { useUi } from "@/store/ui";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TreeList } from "./TreeList";
import { BuiltinSections } from "./BuiltinSections";
import { TruncatedLabel } from "./TruncatedLabel";
import { SidebarResizer, useSidebarWidth } from "./SidebarControls";
import { useT } from "@/i18n";
import { formatShortcut } from "@/lib/platform";

export function Sidebar() {
  const t = useT();
  // only booleans are subscribed here: the header must not re-render every time
  // the tree changes, and the handlers read the store through `getState()`
  const everythingOpen = useWorkspace((s) => allFoldersExpanded(s.nodes, s.expanded));
  const createDoc = useWorkspace((s) => s.createDoc);
  const createFolder = useWorkspace((s) => s.createFolder);
  const rootPath = useWorkspace((s) => s.rootPath);
  const expandAll = useWorkspace((s) => s.expandAll);
  const collapseAll = useWorkspace((s) => s.collapseAll);
  const setSearchOpen = useUi((s) => s.setSearchOpen);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const { width, preview, commit } = useSidebarWidth();

  const targetParent = () => {
    const { nodes, selectedId } = useWorkspace.getState();
    // a trashed / archived / system-group selection can never host a new node:
    // the backend refuses those parents, so it falls back to the root here
    return parentForNewNode(nodes, selectedId);
  };

  const newDoc = () => {
    void createDoc(targetParent());
  };

  // the header buttons are "global" entries: folders are always created at the
  // first level, never inside whatever happens to be selected
  const newFolder = () => {
    void createFolder(null);
  };

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-r border-border"
      style={{ width, background: "var(--sidebar)" }}
    >
      <div className="h-9 shrink-0" data-tauri-drag-region />

      <div className="flex items-center gap-1 px-3 pb-1.5">
        <span className="mr-1 flex size-[14px] shrink-0 items-center justify-center rounded-[4px] bg-brand">
          <span className="text-[9px] font-bold leading-none text-brand-foreground">N</span>
        </span>
        <span className="flex-1 text-[13.5px] font-semibold tracking-[-0.01em] text-foreground/90">
          Novion
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="iconSm"
              variant="ghost"
              onClick={newDoc}
              aria-label={t("New document")}
              className="hover:bg-sidebar-hover"
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("New document")} {formatShortcut("⌘N")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="iconSm"
              variant="ghost"
              onClick={newFolder}
              aria-label={t("New folder")}
              className="hover:bg-sidebar-hover"
            >
              <FolderPlus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("New folder")} {formatShortcut("⌘⇧N")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="iconSm"
              variant="ghost"
              onClick={() => (everythingOpen ? collapseAll() : expandAll())}
              aria-label={everythingOpen ? t("Collapse all folders") : t("Expand all folders")}
              className="hover:bg-sidebar-hover"
            >
              {everythingOpen ? (
                <ChevronsDownUp className="size-3.5" />
              ) : (
                <ChevronsUpDown className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {everythingOpen ? t("Collapse all folders") : t("Expand all folders")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="iconSm"
              variant="ghost"
              onClick={() => setSidebarOpen(false)}
              aria-label={t("Collapse sidebar")}
              className="hover:bg-sidebar-hover"
            >
              <PanelLeftClose className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("Collapse sidebar")} {formatShortcut("⌘⇧\\")}</TooltipContent>
        </Tooltip>
      </div>

      <div className="px-2 pb-1.5">
        <button
          onClick={() => setSearchOpen(true)}
          className="flex h-7 w-full items-center gap-1.5 rounded-md border border-border/80 bg-background/60 px-2 text-[13.5px] text-muted-foreground transition-colors hover:border-brand/40 hover:bg-background hover:text-foreground/80"
          aria-label={t("Search")}
        >
          <Search className="size-3.5 shrink-0 opacity-80" />
          <span className="flex-1 truncate text-left">{t("Search titles and text")}</span>
          <kbd className="shrink-0 opacity-70">{formatShortcut("⌘K")}</kbd>
        </button>
      </div>

      <TreeList />

      <div className="shrink-0 border-t border-border/70 pt-1">
        <BuiltinSections />
      </div>

      <div className="flex h-9 shrink-0 items-center gap-1 border-t border-border/70 px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="iconSm"
              variant="ghost"
              onClick={() => setSettingsOpen(true)}
              aria-label={t("Settings")}
              className="hover:bg-sidebar-hover"
            >
              <Settings className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("Settings")}</TooltipContent>
        </Tooltip>
        <div className="min-w-0 flex-1 px-1 text-[11.5px] text-muted-foreground/70">
          <TruncatedLabel
            text={rootPath.replace(/^.*[\\/]Documents[\\/]/, "~/Documents/")}
            side="top"
          />
        </div>
      </div>

      <SidebarResizer width={width} onPreview={preview} onCommit={commit} />
    </aside>
  );
}
