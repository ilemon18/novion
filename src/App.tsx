import { lazy, Suspense, useEffect, useRef } from "react";
import { CheckCircle2, Info, PanelLeft, TriangleAlert, X } from "lucide-react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SearchDialog } from "@/components/SearchDialog";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/primitives";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/store/workspace";
import { useStorage } from "@/store/storage";
import { startUpdateWatcher } from "@/store/update";
import { importDroppedMarkdown } from "@/lib/import-actions";
import { applyTheme, useUi } from "@/store/ui";
import { installLongPressWindowDrag } from "@/lib/window-drag";
import { formatShortcut, isWindows } from "@/lib/platform";
import { isTypingTarget, matchBinding } from "@/lib/keybindings";
import { api } from "@/lib/tauri";
import { t, useT } from "@/i18n";

// the editor (tiptap) is a separate chunk; the shell paints first
const DocView = lazy(() => import("@/components/editor/DocView"));
// the command palette and its icon set only load the first time ⌘⇧P is used
const CommandPalette = lazy(() =>
  import("@/components/CommandPalette").then((module) => ({ default: module.CommandPalette })),
);

export default function App() {
  useT();
  const init = useWorkspace((s) => s.init);
  const ready = useWorkspace((s) => s.ready);
  // the id of the open document, or null: a scalar selector, so switching
  // between two documents does not re-render the shell for unrelated changes
  const selectedDocId = useWorkspace((s) =>
    s.selectedId && s.nodes[s.selectedId]?.kind === "doc" ? s.selectedId : null,
  );
  const error = useWorkspace((s) => s.error);
  const setError = useWorkspace((s) => s.setError);
  const createDoc = useWorkspace((s) => s.createDoc);
  const theme = useUi((s) => s.theme);
  const palette = useUi((s) => s.palette);
  const historyEnabled = useUi((s) => s.features.history);
  const notice = useUi((s) => s.notice);
  const dismissNotice = useUi((s) => s.dismissNotice);
  const commandOpen = useUi((s) => s.commandOpen);
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const rootPath = useWorkspace((s) => s.rootPath);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void init();
    // one silent GitHub check per launch: the header button only appears when
    // there really is a newer release
    startUpdateWatcher();
  }, [init]);

  useEffect(() => {
    applyTheme(theme, palette);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system", palette);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme, palette]);

  // the UI owns this preference: mirror it into the backend at boot and on every
// toggle, so saves stop (or resume) writing snapshots immediately
  useEffect(() => {
    let alive = true;
    void api
      .getHistoryEnabled()
      .then((current) => {
        if (!alive || current === historyEnabled) return;
        return api.setHistoryEnabled(historyEnabled);
      })
      .catch(() => {
        // an older backend without the flag: saves keep their old behaviour
      });
    return () => {
      alive = false;
    };
  }, [historyEnabled]);

  // Long-press dragging only exists to compensate for the macOS overlay title
  // bar; Windows and Linux draw a real title bar, so installing it there would
  // just fight the window manager.
  useEffect(() => {
    if (isWindows) return;
    const uninstall = installLongPressWindowDrag();
    return uninstall;
  }, []);

  // warm the storage probe once at boot: the settings dialog then opens with
  // zero IPC / state churn during its entrance animation
  useEffect(() => {
    void useStorage.getState().load();
  }, []);

  // every application shortcut comes from one registry (see lib/keybindings.ts)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const binding = matchBinding(event);
      if (!binding) return;
      // a shortcut that has nothing to act on must not swallow the keystroke
      if (binding.available && !binding.available()) return;
      // inside the editor / a text field the native behaviour wins
      if (binding.skipWhileTyping && isTypingTarget()) return;
      event.preventDefault();
      binding.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * Another device (through iCloud) can add, rename or remove notes while this
   * window is open. The tree is re-read when `workspace.json` changes; the
   * store's diffing makes an unchanged read a no-op, so our own writes never
   * cause a re-render loop here.
   */
  useEffect(() => {
    let alive = true;
    let stamp = 0;
    const tick = async () => {
      try {
        const next = await api.workspaceStamp();
        if (!alive) return;
        if (stamp === 0) {
          stamp = next;
          return;
        }
        if (next === stamp) return;
        stamp = next;
        const ws = await api.ensure();
        if (alive) useWorkspace.getState().apply(ws);
      } catch {
        /* a transient read failure just waits for the next tick */
      }
    };
    const timer = window.setInterval(() => void tick(), 9000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  /**
   * Dropping `.md` files anywhere imports them; images keep going to the
   * editor's own drop handler. Capture phase + stopPropagation, so a note
   * dropped on the sidebar does not also start a tree drag.
   */
  useEffect(() => {
    const isMarkdown = (name: string) => /\.(md|markdown)$/i.test(name);

    const onDragOver = (event: DragEvent) => {
      const items = Array.from(event.dataTransfer?.items ?? []);
      if (!items.some((item) => item.kind === "file")) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };

    const onDrop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const markdown = files.filter((file) => isMarkdown(file.name));
      if (!markdown.length) return; // images: leave them to the editor
      event.preventDefault();
      event.stopPropagation();
      void importDroppedMarkdown(markdown);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop, true);
    };
  }, []);

  // a boolean selector: the shell only re-renders when the answer flips, not
  // on every workspace write
  const hasDocs = useWorkspace((s) => Object.keys(s.nodes).length > 0);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <div className="flex h-full w-full overflow-hidden bg-background">
        {sidebarOpen && <Sidebar />}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* With the rail collapsed there has to be a way back in that does not
              depend on knowing the shortcut. It sits in the title-bar strip so
              it never covers the top of the document — and to the *right* of the
              macOS traffic lights: the overlay title bar puts them at the very
              leading edge, where the button used to end up underneath the native
              close/zoom controls (invisible, and clicking it closed the window). */}
          {!sidebarOpen && (
            <div
              className={cn("absolute top-[7px] z-30", isWindows ? "left-2" : "left-[84px]")}
              data-no-window-drag
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="iconSm"
                    variant="ghost"
                    onClick={toggleSidebar}
                    aria-label={t("Expand sidebar")}
                    className="rounded-md text-muted-foreground/75 hover:bg-accent hover:text-foreground"
                  >
                    <PanelLeft className="size-4" strokeWidth={1.7} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("Expand sidebar")} {formatShortcut("⌘⇧\\")}</TooltipContent>
              </Tooltip>
            </div>
          )}
          {!ready ? (
            <div className={cn("mx-auto w-full max-w-[860px] space-y-3 px-8", isWindows ? "pt-3" : "pt-[52px]")}>
              <Skeleton className="h-8 w-56" />
              <Skeleton className="h-4 w-[70%]" />
              <Skeleton className="h-4 w-[55%]" />
            </div>
          ) : selectedDocId ? (
            <Suspense
              fallback={
                <div className={cn("mx-auto w-full max-w-[860px] space-y-3 px-8", isWindows ? "pt-3" : "pt-[52px]")}>
                  <Skeleton className="h-8 w-56" />
                  <Skeleton className="h-4 w-[70%]" />
                </div>
              }
            >
              <DocView key={`${selectedDocId}:${rootPath}`} docId={selectedDocId} />
            </Suspense>
          ) : (
            <EmptyState
              hasDocs={hasDocs}
              onCreate={() => {
                void createDoc(null);
              }}
            />
          )}
        </main>

        <ConfirmDialog />
        <SearchDialog />
        {commandOpen && (
          <Suspense fallback={null}>
            <CommandPalette />
          </Suspense>
        )}
        <SettingsDialog />

        {/* All transient messages share one top-centred stack: a notice and an
            error can then never overlap, every row is vertically centred, and
            nothing covers the bottom of the document while it is being read.
            The stack sits above the dialog layer (portalled, z-50) on purpose:
            a message about what just happened has to stay readable while the
            settings drawer is open, so it gets its own layer at z-[60]. */}
        {(notice || error) && (
          <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4">
            {notice && (
              <div
                key={notice.id}
                className={cn(
                  "anim-fade pointer-events-auto flex max-w-[min(560px,90vw)] items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-[12.5px] shadow-lg",
                  notice.tone === "error" && "border-destructive/35",
                  notice.tone === "success" && "border-success/35",
                  notice.tone === "info" && "border-border",
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {notice.tone === "error" ? (
                    <TriangleAlert className="size-3.5 text-destructive" />
                  ) : notice.tone === "success" ? (
                    <CheckCircle2 className="size-3.5 text-success" />
                  ) : (
                    <Info className="size-3.5 text-brand" />
                  )}
                </span>
                <span className="min-w-0 flex-1 break-words leading-snug">{notice.text}</span>
                {notice.actionLabel && notice.action && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => {
                      notice.action?.();
                      dismissNotice();
                    }}
                  >
                    {notice.actionLabel}
                  </Button>
                )}
                <Button
                  size="iconSm"
                  variant="ghost"
                  onClick={dismissNotice}
                  aria-label={t("Dismiss")}
                  className="-mr-1 shrink-0"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}

            {error && (
              <div className="anim-fade pointer-events-auto flex max-w-[min(560px,90vw)] items-center gap-2 rounded-lg border border-destructive/35 bg-popover px-3 py-2 text-[12.5px] shadow-lg">
                <span className="flex size-4 shrink-0 items-center justify-center text-destructive">
                  <TriangleAlert className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1 break-words leading-snug">{error}</span>
                <Button
                  size="iconSm"
                  variant="ghost"
                  onClick={() => setError(null)}
                  aria-label={t("Dismiss")}
                  className="-mr-1 shrink-0"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Window drag strip under the macOS overlay title bar. Kept at z-20 so
            the outline panel (z-30) can sit above it: its header lives in this
            strip and its close button has to stay clickable. Windows draws its
            own title bar, so the strip would only cover content there. */}
        {!isWindows && (
          <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-20 h-7" />
        )}
      </div>
    </TooltipProvider>
  );
}