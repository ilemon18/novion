import { useEffect, useMemo, useState, type RefObject } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import type { OutlineItem } from "./DocEditor";

interface Props {
  items: OutlineItem[];
  editor: TiptapEditor | null;
  /** the `.doc-scroll` element the outline is tracking */
  scrollRef: RefObject<HTMLDivElement>;
  onClose: () => void;
}

/** where a heading jump lands, in pixels below the top of the scroll pane */
const JUMP_OFFSET = 88;
/** a heading counts as "current" once it is this far into the viewport */
const ACTIVE_OFFSET = 96;

interface OutlineNode {
  item: OutlineItem;
  children: OutlineNode[];
}

/**
 * Rebuilds the flat heading list into a tree.
 *
 * Level numbers are not the depth: a document may start at h2 or skip from h1
 * to h4, and skipping a level must not add an empty indent step.
 */
function buildTree(items: OutlineItem[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const item of items) {
    const node: OutlineNode = { item, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].item.level >= item.level) {
      stack.pop();
    }
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

/**
 * Heading outline for the open document.
 *
 * Positions come from `view.coordsAtPos`, so it works no matter how the editor
 * is scrolled and needs no DOM ids or anchors in the document itself.
 */
export function DocOutline({ items, editor, scrollRef, onClose }: Props) {
  const t = useT();
  const [activePos, setActivePos] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const tree = useMemo(() => buildTree(items), [items]);

  // scroll-spy: the last heading above the reading line is the current one
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !editor || items.length === 0) {
      setActivePos(null);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = scroller.getBoundingClientRect();
      const line = box.top + ACTIVE_OFFSET;
      // headings are in document order, so their vertical position is
      // monotonic: a binary search needs O(log n) layout reads per scroll
      // frame instead of one read per heading
      let low = 0;
      let high = items.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        try {
          if (editor.view.coordsAtPos(items[mid].pos).top <= line) low = mid + 1;
          else high = mid;
        } catch {
          break;
        }
      }
      const current = low > 0 ? items[low - 1].pos : null;
      setActivePos((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, items, scrollRef]);

  /**
   * Scrolling into a collapsed branch would leave the panel showing nothing
   * for the section being read, so the ancestors of the current heading open
   * themselves again. Manual collapse of an unrelated branch is left alone.
   */
  useEffect(() => {
    if (activePos == null) return;
    setCollapsed((previous) => {
      if (previous.size === 0) return previous;
      const next = new Set(previous);
      let changed = false;
      const walk = (nodes: OutlineNode[], ancestors: number[]) => {
        for (const node of nodes) {
          if (node.item.pos === activePos) {
            for (const ancestor of ancestors) {
              if (next.delete(ancestor)) changed = true;
            }
          }
          walk(node.children, [...ancestors, node.item.pos]);
        }
      };
      walk(tree, []);
      return changed ? next : previous;
    });
  }, [activePos, tree]);

  const jump = (pos: number) => {
    if (!editor) return;
    const scroller = scrollRef.current;
    let top = 0;
    try {
      top = editor.view.coordsAtPos(pos).top;
    } catch {
      return;
    }
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      scroller.scrollTop += top - box.top - JUMP_OFFSET;
    }
    try {
      editor.chain().focus().setTextSelection(pos + 1).run();
    } catch {
      /* a heading at the very edge of the document — scrolling is enough */
    }
  };

  const toggle = (pos: number) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(pos)) next.delete(pos);
      else next.add(pos);
      return next;
    });
  };

  const renderNodes = (nodes: OutlineNode[], depth: number) =>
    nodes.map((node) => {
      const { item } = node;
      const active = activePos === item.pos;
      const hasChildren = node.children.length > 0;
      const open = !collapsed.has(item.pos);
      return (
        <div key={`${item.pos}-${item.level}`}>
          <div
            className={cn(
              "group flex w-full items-start rounded-md pr-1.5 text-left text-[12px] leading-[1.45] transition-colors duration-75",
              active
                ? "bg-brand-soft text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            style={{ paddingLeft: 4 + depth * 12 }}
          >
            {hasChildren ? (
              <button
                type="button"
                aria-label={open ? t("Collapse") : t("Expand")}
                aria-expanded={open}
                onClick={() => toggle(item.pos)}
                className="mt-[2px] flex size-[15px] shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
              >
                <ChevronRight
                  className={cn("size-3 transition-transform duration-100", open && "rotate-90")}
                />
              </button>
            ) : (
              <span className="size-[15px] shrink-0" aria-hidden="true" />
            )}
            <button
              type="button"
              onClick={() => jump(item.pos)}
              title={item.text || t("Empty heading")}
              className="min-w-0 flex-1 py-[3px] text-left"
            >
              <span className="line-clamp-2 break-words">{item.text || t("Empty heading")}</span>
            </button>
          </div>
          {hasChildren && open && renderNodes(node.children, depth + 1)}
        </div>
      );
    });

  return (
    <aside className="relative z-30 flex w-[204px] shrink-0 flex-col border-l border-border/70">
      <div className="flex h-10 shrink-0 items-center gap-1 pl-3 pr-1.5">
        <span className="flex-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {t("Outline")}
        </span>
        <button
          type="button"
          onClick={onClose}
          title={t("Close outline")}
          aria-label={t("Close outline")}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
        >
          <X className="size-4" strokeWidth={1.9} />
        </button>
      </div>

      <div className="scroller min-h-0 flex-1 overflow-y-auto px-1.5 pb-8">
        {items.length === 0 ? (
          <p className="px-2 py-3 text-[11.5px] leading-relaxed text-muted-foreground/80">
            {t("Use")} <kbd>/</kbd> {t("to add a heading — it shows up here.")}
          </p>
        ) : (
          renderNodes(tree, 0)
        )}
      </div>
    </aside>
  );
}