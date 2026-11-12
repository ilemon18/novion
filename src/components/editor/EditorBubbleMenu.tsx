import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Ban,
  Baseline,
  Bold,
  ChevronDown,
  Code as CodeIcon,
  Eraser,
  Highlighter,
  Italic,
  Link as LinkIcon,
  Strikethrough,
  Subscript,
  Superscript,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
  Underline as UnderlineIcon,
  Unlink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatShortcut } from "@/lib/platform";
import { useT } from "@/i18n";

/**
 * Floating formatting bar.
 *
 * The editor runs with `shouldRerenderOnTransaction: false`, so the bar keeps
 * its own subscription. Bumping state on *every* transaction re-rendered the
 * whole bar (~20 buttons) while typing, and that showed up as a hitch the
 * moment a panel had to open on top of it. The subscription below therefore
 * compares a cheap fingerprint of what the bar actually draws and only
 * re-renders when one of those values changed.
 */
function barSignature(editor: Editor): string {
  const mark = (name: string) => (editor.isActive(name) ? 1 : 0);
  const color = (name: string) =>
    (editor.getAttributes(name).color as string | undefined) ?? "";
  return [
    mark("bold"),
    mark("italic"),
    mark("underline"),
    mark("strike"),
    mark("code"),
    mark("superscript"),
    mark("subscript"),
    mark("link"),
    mark("textStyle"),
    mark("highlight"),
    color("textStyle"),
    color("highlight"),
    currentBlock(editor),
    // the table controls depend on the cell the caret sits in; inside a table
    // the caret position is part of what the bar shows
    editor.isActive("table") ? `t${editor.state.selection.from}` : "t0",
  ].join("|");
}

function useBarSignature(editor: Editor): void {
  const known = useRef(barSignature(editor));
  const [, bump] = useState(0);
  useEffect(() => {
    const update = () => {
      // nothing is drawn without a selection (the table toolbar is the one
      // exception), so typing in a plain paragraph costs no fingerprint work
      if (editor.state.selection.empty && !editor.isActive("table")) return;
      const next = barSignature(editor);
      if (next === known.current) return;
      known.current = next;
      bump((value) => value + 1);
    };
    editor.on("transaction", update);
    editor.on("selectionUpdate", update);
    return () => {
      editor.off("transaction", update);
      editor.off("selectionUpdate", update);
    };
  }, [editor]);
}

const TEXT_COLORS: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Red", value: "#c25a5a" },
  { label: "Orange", value: "#c97b3c" },
  { label: "Yellow", value: "#b8912f" },
  { label: "Green", value: "#3f8f68" },
  { label: "Blue", value: "#4a6fa5" },
  { label: "Purple", value: "#7a56a8" },
  { label: "Gray", value: "#767670" },
];

const HIGHLIGHT_COLORS: { label: string; value: string | null }[] = [
  { label: "Yellow", value: "#f9e79a" },
  { label: "Green", value: "#bde5c8" },
  { label: "Blue", value: "#c3dcf6" },
  { label: "Pink", value: "#f8c9c9" },
  { label: "Purple", value: "#e3d0f7" },
  { label: "Orange", value: "#f8dcc0" },
  { label: "Clear", value: null },
];

const TRANSFORMS: { id: string; label: string; run: (editor: Editor) => void }[] = [
  { id: "p", label: "Text", run: (editor) => editor.chain().focus().setParagraph().run() },
  { id: "h1", label: "Heading 1", run: (editor) => editor.chain().focus().setNode("heading", { level: 1 }).run() },
  { id: "h2", label: "Heading 2", run: (editor) => editor.chain().focus().setNode("heading", { level: 2 }).run() },
  { id: "h3", label: "Heading 3", run: (editor) => editor.chain().focus().setNode("heading", { level: 3 }).run() },
  { id: "h4", label: "Heading 4", run: (editor) => editor.chain().focus().setNode("heading", { level: 4 }).run() },
  { id: "quote", label: "Quote", run: (editor) => editor.chain().focus().toggleBlockquote().run() },
  { id: "code", label: "Code block", run: (editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: "bullet", label: "Bulleted list", run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: "numbered", label: "Numbered list", run: (editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: "todo", label: "To-do", run: (editor) => editor.chain().focus().toggleTaskList().run() },
];

function currentBlock(editor: Editor): string {
  for (const level of [1, 2, 3, 4]) {
    if (editor.isActive("heading", { level })) return `h${level}`;
  }
  if (editor.isActive("blockquote")) return "quote";
  if (editor.isActive("codeBlock")) return "code";
  if (editor.isActive("bulletList")) return "bullet";
  if (editor.isActive("orderedList")) return "numbered";
  if (editor.isActive("taskList")) return "todo";
  return "p";
}

const BLOCK_LABEL: Record<string, string> = Object.fromEntries(
  TRANSFORMS.map((item) => [item.id, item.label]),
);

interface ToolButtonProps {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}

function ToolButton({ active, disabled, title, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-75",
        "hover:bg-accent hover:text-foreground",
        active && "bg-brand-soft text-brand",
        disabled && "pointer-events-none opacity-35",
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-border" />;
}

/**
 * A menu that lives *inside* the bubble.
 *
 * Radix's dropdown portals render at `document.body`, which makes the editor
 * blur and the bubble menu hide itself while the menu is still open. Keeping
 * the panel in the bubble's own DOM keeps focus inside the popper, which is
 * exactly the case the bubble-menu plugin treats as "still editing".
 */
function Panel({
  children,
  align = "start",
  width = 176,
}: {
  children: ReactNode;
  align?: "start" | "end";
  width?: number;
}) {
  return (
    <div
      className="absolute top-[calc(100%+6px)] z-50 rounded-lg border border-border bg-popover p-1 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)]"
      style={align === "start" ? { left: 0, width } : { right: 0, width }}
    >
      {children}
    </div>
  );
}

function PanelItem({
  onClick,
  disabled,
  destructive,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-foreground transition-colors",
        "hover:bg-accent disabled:pointer-events-none disabled:opacity-40",
        destructive && "text-destructive hover:bg-destructive/10",
      )}
    >
      {children}
    </button>
  );
}

function PanelLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1 text-[10.5px] font-medium text-muted-foreground">
      {children}
    </div>
  );
}

/** Normalises what people type into the link field into a usable href. */
function toHref(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value}`;
}

function LinkEditor({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const t = useT();
  const [value, setValue] = useState(
    () => (editor.getAttributes("link").href as string | undefined) ?? "",
  );

  const commit = () => {
    const href = toHref(value);
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    onDone();
  };

  return (
    <span className="flex items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          }
        }}
        placeholder={t("Paste a link and press Enter")}
        spellCheck={false}
        className="h-6 w-[168px] rounded border border-border bg-background px-1.5 text-[12px] outline-none focus:border-brand"
      />
      <ToolButton title={t("Apply link")} onClick={commit}>
        <LinkIcon className="size-3.5" />
      </ToolButton>
    </span>
  );
}

interface ContentProps {
  editor: Editor;
}

const BubbleContent = memo(function BubbleContent({ editor }: ContentProps) {
  const t = useT();
  useBarSignature(editor);
  const [linkOpen, setLinkOpen] = useState(false);
  const [panel, setPanel] = useState<"block" | "more" | "table" | "text" | "mark" | null>(
    null,
  );

  // moving the caret closes whatever popover was open
  useEffect(() => {
    const close = () => setPanel(null);
    editor.on("selectionUpdate", close);
    return () => {
      editor.off("selectionUpdate", close);
    };
  }, [editor]);

  const inTable = editor.isActive("table");
  const block = currentBlock(editor);
  const closeAfter = (action: () => void) => () => {
    action();
    setPanel(null);
  };

  return (
    <div
      className="novion-bubble flex flex-wrap items-center gap-0.5 px-1 py-0.5"
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select")) return;
        event.preventDefault();
      }}
    >
      <div className="relative">
        <button
          type="button"
          onClick={() => setPanel(panel === "block" ? null : "block")}
          className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t(BLOCK_LABEL[block] ?? "Text")}
          <ChevronDown className="size-3 opacity-60" />
        </button>
        {panel === "block" && (
          <Panel width={148}>
            <PanelLabel>{t("Turn into")}</PanelLabel>
            {TRANSFORMS.map((item) => (
              <PanelItem
                key={item.id}
                onClick={closeAfter(() => item.run(editor))}
              >
                <span className={cn(item.id !== "p" && "font-semibold")}>
                  {t(item.label)}
                </span>
              </PanelItem>
            ))}
          </Panel>
        )}
      </div>

      <Sep />

      <ToolButton
        title={formatShortcut(t("Bold ⌘B"))}
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className="size-3.5" />
      </ToolButton>
      <ToolButton
        title={formatShortcut(t("Italic ⌘I"))}
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-3.5" />
      </ToolButton>
      <ToolButton
        title={formatShortcut(t("Underline ⌘U"))}
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon className="size-3.5" />
      </ToolButton>
      <ToolButton
        title={t("Strikethrough")}
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="size-3.5" />
      </ToolButton>
      <ToolButton
        title={t("Inline code")}
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <CodeIcon className="size-3.5" />
      </ToolButton>

      <Sep />

      <div className="relative">
        <ToolButton
          title={t("Text color")}
          active={editor.isActive("textStyle")}
          onClick={() => setPanel(panel === "text" ? null : "text")}
        >
          <Baseline className="size-3.5" />
        </ToolButton>
        {panel === "text" && (
          <Panel width={168}>
            <Swatches
              label="Text color"
              colors={TEXT_COLORS}
              current={(editor.getAttributes("textStyle").color as string) ?? null}
              onPick={(value) => {
                // close first: the transaction below re-renders the bar once,
                // instead of once for the command and once for the panel
                setPanel(null);
                if (value) editor.chain().focus().setColor(value).run();
                else editor.chain().focus().unsetColor().run();
              }}
            />
          </Panel>
        )}
      </div>

      <div className="relative">
        <ToolButton
          title={t("Highlight")}
          active={editor.isActive("highlight")}
          onClick={() => setPanel(panel === "mark" ? null : "mark")}
        >
          <Highlighter className="size-3.5" />
        </ToolButton>
        {panel === "mark" && (
          <Panel width={168}>
            <Swatches
              label="Highlight"
              shape="square"
              colors={HIGHLIGHT_COLORS}
              current={
                (editor.getAttributes("highlight").color as string | undefined) ?? null
              }
              onPick={(value) => {
                setPanel(null);
                if (value) editor.chain().focus().setHighlight({ color: value }).run();
                else editor.chain().focus().unsetHighlight().run();
              }}
            />
          </Panel>
        )}
      </div>

      <Sep />

      {linkOpen ? (
        <LinkEditor editor={editor} onDone={() => setLinkOpen(false)} />
      ) : (
        <ToolButton
          title={t("Link")}
          active={editor.isActive("link")}
          onClick={() => setLinkOpen(true)}
        >
          <LinkIcon className="size-3.5" />
        </ToolButton>
      )}
      {editor.isActive("link") && !linkOpen && (
        <ToolButton
          title={t("Remove link")}
          onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
        >
          <Unlink className="size-3.5" />
        </ToolButton>
      )}

      <div className="relative">
        <button
          type="button"
          title={t("More formatting")}
          aria-label={t("More formatting")}
          onClick={() => setPanel(panel === "more" ? null : "more")}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className="size-3.5" />
        </button>
        {panel === "more" && (
          <Panel align="end" width={150}>
            <PanelItem onClick={closeAfter(() => editor.chain().focus().toggleSuperscript().run())}>
              <Superscript className="size-3.5" />
              {t("Superscript")}
            </PanelItem>
            <PanelItem onClick={closeAfter(() => editor.chain().focus().toggleSubscript().run())}>
              <Subscript className="size-3.5" />
              {t("Subscript")}
            </PanelItem>
            <div className="my-1 h-px bg-border" />
            <PanelItem onClick={closeAfter(() => editor.chain().focus().unsetAllMarks().run())}>
              <Eraser className="size-3.5" />
              {t("Clear formatting")}
            </PanelItem>
          </Panel>
        )}
      </div>

      {inTable && (
        <div className="relative">
          <button
            type="button"
            title={t("Table actions")}
            aria-label={t("Table actions")}
            onClick={() => setPanel(panel === "table" ? null : "table")}
            className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <TableCellsMerge className="size-3.5" />
            {t("Table")}
            <ChevronDown className="size-3 opacity-60" />
          </button>
          {panel === "table" && (
            <Panel align="end" width={176}>
              <PanelItem
                disabled={!editor.can().addRowBefore()}
                onClick={closeAfter(() => editor.chain().focus().addRowBefore().run())}
              >
                <ArrowUpToLine className="size-3.5" />
                {t("Insert row above")}
              </PanelItem>
              <PanelItem
                disabled={!editor.can().addRowAfter()}
                onClick={closeAfter(() => editor.chain().focus().addRowAfter().run())}
              >
                <ArrowDownToLine className="size-3.5" />
                {t("Insert row below")}
              </PanelItem>
              <PanelItem
                disabled={!editor.can().addColumnBefore()}
                onClick={closeAfter(() => editor.chain().focus().addColumnBefore().run())}
              >
                <ArrowLeftToLine className="size-3.5" />
                {t("Insert column left")}
              </PanelItem>
              <PanelItem
                disabled={!editor.can().addColumnAfter()}
                onClick={closeAfter(() => editor.chain().focus().addColumnAfter().run())}
              >
                <ArrowRightToLine className="size-3.5" />
                {t("Insert column right")}
              </PanelItem>
              <div className="my-1 h-px bg-border" />
              <PanelItem
                disabled={!editor.can().mergeCells()}
                onClick={closeAfter(() => editor.chain().focus().mergeCells().run())}
              >
                <TableCellsMerge className="size-3.5" />
                {t("Merge cells")}
              </PanelItem>
              <PanelItem
                disabled={!editor.can().splitCell()}
                onClick={closeAfter(() => editor.chain().focus().splitCell().run())}
              >
                <TableCellsSplit className="size-3.5" />
                {t("Split cell")}
              </PanelItem>
              <PanelItem onClick={closeAfter(() => editor.chain().focus().toggleHeaderRow().run())}>
                {t("Toggle header row")}
              </PanelItem>
              <div className="my-1 h-px bg-border" />
              <PanelItem onClick={closeAfter(() => editor.chain().focus().deleteRow().run())}>
                <Trash2 className="size-3.5" />
                {t("Delete row")}
              </PanelItem>
              <PanelItem onClick={closeAfter(() => editor.chain().focus().deleteColumn().run())}>
                <Trash2 className="size-3.5" />
                {t("Delete column")}
              </PanelItem>
              <PanelItem
                destructive
                onClick={closeAfter(() => editor.chain().focus().deleteTable().run())}
              >
                <Trash2 className="size-3.5" />
                {t("Delete table")}
              </PanelItem>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
});

function Swatches({
  label,
  colors,
  current,
  onPick,
  shape = "circle",
}: {
  label: string;
  colors: { label: string; value: string | null }[];
  current: string | null;
  onPick: (value: string | null) => void;
  shape?: "circle" | "square";
}) {
  const t = useT();
  return (
    <div className="p-1.5">
      <div className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
        {t(label)}
      </div>
      <div className="grid grid-cols-4 justify-items-center gap-2">
        {colors.map((color) => {
          const active = (color.value ?? null) === (current ?? null);
          const none = color.value == null;
          return (
            <button
              key={color.label}
              type="button"
              title={t(color.label)}
              aria-label={t(color.label)}
              aria-pressed={active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(color.value)}
              className={cn(
                // a flat 28px block of colour read as a paint chip; the ring
                // and the hairline border give the swatch a defined edge on
                // both the light and the dark panel
                "flex size-7 items-center justify-center border transition-[box-shadow,border-color] duration-75",
                shape === "circle" ? "rounded-full" : "rounded-[7px]",
                none
                  ? "border-border bg-background text-muted-foreground hover:border-foreground/30"
                  : "border-black/10 hover:border-black/20 dark:border-white/20 dark:hover:border-white/35",
                active && "ring-2 ring-brand ring-offset-1 ring-offset-popover",
              )}
              style={color.value ? { background: color.value } : undefined}
            >
              {none && <Ban className="size-3.5" strokeWidth={1.6} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Same rules the TipTap bubble-menu plugin used. */
function shouldShowBar(editor: Editor): boolean {
  // the table toolbar only exists here, so a caret in a cell still needs the
  // bar even without a text selection
  if (editor.isActive("table")) return true;
  const { selection } = editor.state;
  if (selection.empty) return false;
  // images, bookmarks, the TOC and formulas are atoms with their own controls;
  // a second floating bar on top of them is just noise
  if (selection instanceof NodeSelection && selection.node.type.isAtom) return false;
  return true;
}

/**
 * Floating formatting bar.
 *
 * Deliberately *not* `@tiptap/react`'s `BubbleMenu`: that component hands its
 * React-rendered root to tippy, which moves the node into a popper on `body`.
 * React still believes the node lives under the editor, so unmounting anything
 * (a doc switch, a settings toggle) makes it call `removeChild` on a node that
 * is no longer there and WebKit throws "The object can not be found here".
 *
 * Here the bar is a plain portal to `body` that we position ourselves from the
 * current selection, so nothing inside the editor tree is relocated.
 */
export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const barRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (editor.isDestroyed) return;
    let frame = 0;
    let lastKey = "";

    /** `force` re-reads the viewport position for the same selection (scroll). */
    const measure = (force: boolean) => {
      if (editor.isDestroyed || !shouldShowBar(editor)) {
        lastKey = "";
        setAnchor(null);
        return;
      }
      const { from, to } = editor.state.selection;
      const key = `${from}:${to}:${editor.isActive("table") ? 1 : 0}`;
      if (!force && key === lastKey) return;
      lastKey = key;
      try {
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        setAnchor({
          top: Math.min(start.top, end.top),
          left: (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2,
        });
      } catch {
        // a selection can point at a node the view no longer renders
        setAnchor(null);
      }
    };

    // coalesced to one measurement per frame: typing moves the caret on every
    // keystroke, and `coordsAtPos` forces layout
    const schedule = (force = false) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure(force);
      });
    };
    const onTransaction = () => schedule(false);
    const onViewport = () => schedule(true);
    const onBlur = ({ event }: { event: FocusEvent }) => {
      const next = (event?.relatedTarget as Node | null) ?? null;
      if (next && barRef.current?.contains(next)) return;
      if (next === editor.view.dom) return;
      setAnchor(null);
      lastKey = "";
    };

    measure(false);
    editor.on("transaction", onTransaction);
    editor.on("selectionUpdate", onTransaction);
    editor.on("focus", onViewport);
    editor.on("blur", onBlur);
    window.addEventListener("resize", onViewport);
    document.addEventListener("scroll", onViewport, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      editor.off("transaction", onTransaction);
      editor.off("selectionUpdate", onTransaction);
      editor.off("focus", onViewport);
      editor.off("blur", onBlur);
      window.removeEventListener("resize", onViewport);
      document.removeEventListener("scroll", onViewport, true);
    };
  }, [editor]);

  // the bar is kept mounted (hidden) while there is no selection: mounting and
  // unmounting it on every caret move made Radix panels flicker
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === size.width && rect.height === size.height) return;
    setSize({ width: rect.width, height: rect.height });
  });

  const margin = 8;
  const half = size.width / 2;
  const left = anchor && half
    ? Math.min(Math.max(anchor.left, half + margin), window.innerWidth - half - margin)
    : 0;
  const top = anchor ? Math.max(anchor.top - 10, margin + size.height) : 0;

  return createPortal(
    <div
      ref={barRef}
      className="fixed z-40 -translate-x-1/2 -translate-y-full"
      style={{
        top,
        left,
        visibility: anchor ? "visible" : "hidden",
        pointerEvents: anchor ? undefined : "none",
      }}
    >
      <BubbleContent editor={editor} />
    </div>,
    document.body,
  );
}