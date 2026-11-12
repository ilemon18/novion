import { useMemo, useRef, useState, useCallback } from "react";
import {
  CheckCircle2,
  ChevronRight,
  FileText,
  Folder,
  MoreHorizontal,
  RotateCcw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  COMPLETED_ID,
  TRASH_ID,
  sectionTree,
  useWorkspace,
  type FlatRow,
  type TreeNode,
} from "@/store/workspace";
import { useT } from "@/i18n";
import { useUi } from "@/store/ui";
import { useAutoHideScrollbar } from "@/lib/use-auto-hide-scrollbar";
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
import { NodeContextMenu } from "./NodeContextMenu";
import type { NodeAction } from "./node-actions";

const ROW_H = 30;

interface Section {
  key: "completed" | "trash";
  id: string;
  label: string;
  icon: typeof CheckCircle2;
  empty: string;
}

const SECTIONS: Section[] = [
  { key: "completed", id: COMPLETED_ID, label: "Archived", icon: CheckCircle2, empty: "No archived notes yet" },
  { key: "trash", id: TRASH_ID, label: "Trash", icon: Trash2, empty: "Trash is empty" },
];

export function BuiltinSections() {
  const t = useT();
  const nodes = useWorkspace((s) => s.nodes);
  const children = useWorkspace((s) => s.children);
  const selectedId = useWorkspace((s) => s.selectedId);
  const select = useWorkspace((s) => s.select);
  const restore = useWorkspace((s) => s.restore);
  const purge = useWorkspace((s) => s.purge);
  const emptyTrash = useWorkspace((s) => s.emptyTrash);
  const setCompleted = useWorkspace((s) => s.setCompleted);
  const askConfirm = useUi((s) => s.askConfirm);

  const [open, setOpen] = useState<Record<string, boolean>>({ completed: false, trash: false });
  const toggle = (key: string) => setOpen((s) => ({ ...s, [key]: !s[key] }));

  /** right-click target, drawn by the shared `NodeContextMenu` */
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number; trash: boolean } | null>(
    null,
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  const listRef = useRef<HTMLDivElement>(null);
  useAutoHideScrollbar(listRef);

  // Deliberately no "reveal the matching section" effect: archiving a note or
  // moving it to the trash must not pop a section open underneath the user.
  // The sections open on an explicit click only.

  // one walk per section feeds both the rows and the counter badge
  const sections = useMemo(() => {
    const map: Record<string, { rows: FlatRow[]; docs: number }> = {};
    for (const section of SECTIONS) {
      map[section.key] = sectionTree(nodes, children, section.id);
    }
    return map;
  }, [children, nodes]);

  const askPurge = (node: TreeNode) => {
    askConfirm({
      title: t("Delete permanently?"),
      description:
        node.kind === "doc"
          ? t("“{name}” will be deleted permanently. This cannot be undone.", {
              name: node.name || t("Untitled"),
            })
          : t("“{name}” and everything inside it will be deleted permanently. This cannot be undone.", {
              name: node.name || t("Untitled"),
            }),
      confirmLabel: t("Delete permanently"),
      destructive: true,
      onConfirm: () => void purge(node.id),
    });
  };

  const askEmptyTrash = () => {
    askConfirm({
      title: t("Empty the Trash?"),
      description: t("Everything in the Trash will be deleted permanently. This cannot be undone."),
      confirmLabel: t("Empty Trash"),
      destructive: true,
      onConfirm: () => void emptyTrash(),
    });
  };

  /**
   * Same list for the row dropdown and the right-click menu; both refer to the
   * section the row belongs to, which decides restore vs. unarchive.
   */
  const sectionActions = (node: TreeNode, trash: boolean, defer: (run: () => void) => void) => {
    if (trash) {
      return [
        {
          label: t("Restore"),
          icon: RotateCcw,
          run: () => defer(() => void restore(node.id)),
        },
        {
          label: t("Delete permanently"),
          icon: Trash2,
          destructive: true,
          separatorBefore: true,
          run: () => defer(() => askPurge(node)),
        },
      ] satisfies NodeAction[];
    }
    return [
      {
        label: t("Unarchive"),
        icon: Undo2,
        run: () => defer(() => void setCompleted(node.id, false)),
      },
    ] satisfies NodeAction[];
  };

  const menuActions = useMemo(
    () =>
      menu
        ? sectionActions(menu.node, menu.trash, (run) => {
            setMenu(null);
            window.setTimeout(run, 0);
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu],
  );

  /**
   * One delegated handler instead of a Radix root per row: the menu is created
   * from the pointer coordinates of this very event, so it cannot flash at the
   * top-left corner before jumping into place.
   */
  const onContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-section-row]");
    if (!row) return;
    const id = row.getAttribute("data-section-row");
    const node = id ? useWorkspace.getState().nodes[id] : undefined;
    if (!node) return;
    event.preventDefault();
    setMenu({ node, x: event.clientX, y: event.clientY, trash: row.dataset.section === "trash" });
  }, []);

  return (
    <div
      ref={listRef}
      className="scroller scroll-pane auto-hide-scrollbar max-h-[46vh] overflow-y-auto px-2 pb-1"
      onContextMenu={onContextMenu}
    >
      {SECTIONS.map((section) => {
        const { rows, docs } = sections[section.key] ?? { rows: [], docs: 0 };
        const isOpen = !!open[section.key];
        const Icon = section.icon;
        const isTrash = section.key === "trash";

        return (
          <div key={section.key}>
            <div
              data-no-window-drag
              className="group flex items-center rounded-md pr-1 text-[14px] text-foreground/85 hover:bg-sidebar-hover"
              style={{ height: ROW_H }}
            >
              <button
                onClick={() => toggle(section.key)}
                className="flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-left outline-none"
                aria-expanded={isOpen}
              >
                <ChevronRight
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
                    isOpen && "rotate-90",
                  )}
                />
                <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
                <span className="min-w-0 flex-1 truncate">{t(section.label)}</span>
              </button>

              {/* fixed-width counter + action slot: numbers stay right aligned
                  whether or not the clear button is visible */}
              <span className="w-7 shrink-0 text-right text-[12px] tabular-nums leading-none text-muted-foreground/70">
                {docs > 0 ? docs : ""}
              </span>
              <span className="flex w-6 shrink-0 items-center justify-end">
                {isTrash && docs > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="iconSm"
                        variant="ghost"
                        className="opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                        aria-label={t("Trash actions")}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem destructive onSelect={askEmptyTrash}>
                        <X /> {t("Empty Trash")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
            </div>

            {isOpen && (
              <div>
                {rows.length === 0 ? (
                  <div className="px-3 py-2 text-[13px] text-muted-foreground/70">
                    {t(section.empty)}
                  </div>
                ) : (
                  rows.map((row) => {
                    const selected = row.id === selectedId;
                    const isFolder = row.node.kind === "folder";
                    // one action list for the row dropdown and the right-click menu
                    const actions = sectionActions(row.node, isTrash, (run) =>
                      window.setTimeout(run, 0),
                    );
                    return (
                      <div
                        key={row.id}
                        data-no-window-drag
                        data-section-row={row.id}
                        data-section={section.key}
                        onClick={() => {
                          if (!isFolder) select(row.id);
                        }}
                        style={{ height: ROW_H, paddingLeft: 20 + row.depth * 13 }}
                        className={cn(
                          "group relative flex cursor-default items-center gap-1.5 rounded-md pr-1 text-[14px] transition-colors duration-75",
                          selected
                            ? "bg-brand-soft text-foreground"
                            : "text-foreground/80 hover:bg-sidebar-hover",
                        )}
                      >
                        {selected && (
                          <span className="pointer-events-none absolute inset-y-[6px] left-0 w-[2px] rounded-full bg-brand" />
                        )}
                        {isFolder ? (
                          <Folder
                            className="size-3.5 shrink-0 text-muted-foreground"
                            strokeWidth={1.8}
                          />
                        ) : (
                          <FileText
                            className="size-3.5 shrink-0 text-muted-foreground/80"
                            strokeWidth={1.8}
                          />
                        )}
                        <TruncatedLabel
                          text={row.node.name}
                          className="flex-1"
                          fallback={
                            <span className="text-muted-foreground/70">{t("Untitled")}</span>
                          }
                        />
                        <DropdownMenu>
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
                          <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
                            {actions.map((action) => (
                              <div key={action.label}>
                                {action.separatorBefore && <DropdownMenuSeparator />}
                                <DropdownMenuItem
                                  destructive={action.destructive}
                                  onSelect={action.run}
                                >
                                  <action.icon /> {action.label}
                                </DropdownMenuItem>
                              </div>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
      <NodeContextMenu menu={menu} actions={menuActions} onClose={closeMenu} />
    </div>
  );
}
