import { memo, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  Bold,
  ChevronDown,
  Code as CodeIcon,
  Eraser,
  Italic,
  Strikethrough,
  Subscript,
  Superscript,
  Underline as UnderlineIcon,
} from "lucide-react";
import { formatShortcut } from "@/lib/platform";
import { useT } from "@/i18n";
import { BlockPicker } from "./blocks";
import { HighlightControl, TextColorControl } from "./colors";
import { LinkControls } from "./link";
import { Panel, PanelItem, Sep, ToolButton } from "./parts";
import { useBarSignature } from "./signature";
import { TableActions } from "./table";

/** Only one dropdown is drawn at a time; opening one closes the others. */
type PanelId = "block" | "more" | "table" | "text" | "mark";

interface ContentProps {
  editor: Editor;
}

/**
 * The bar itself: block type, the five marks, colours, links, the overflow
 * menu and — while the caret sits in one — the table menu.
 */
export const BubbleContent = memo(function BubbleContent({ editor }: ContentProps) {
  const t = useT();
  useBarSignature(editor);
  const [panel, setPanel] = useState<PanelId | null>(null);

  // moving the caret closes whatever popover was open
  useEffect(() => {
    const close = () => setPanel(null);
    editor.on("selectionUpdate", close);
    return () => {
      editor.off("selectionUpdate", close);
    };
  }, [editor]);

  // one shape for every dropdown: which panel is open is the bar's state, not
  // the control's, so two of them can never be drawn at once
  const forPanel = (id: PanelId) => ({
    editor,
    open: panel === id,
    onToggle: () => setPanel(panel === id ? null : id),
    onClose: () => setPanel(null),
  });

  const inTable = editor.isActive("table");

  return (
    <div
      className="novion-bubble flex flex-wrap items-center gap-0.5 px-1 py-0.5"
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select")) return;
        event.preventDefault();
      }}
    >
      <BlockPicker {...forPanel("block")} />

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

      <TextColorControl {...forPanel("text")} />
      <HighlightControl {...forPanel("mark")} />

      <Sep />

      <LinkControls editor={editor} />

      <MoreMenu {...forPanel("more")} />

      {inTable && <TableActions {...forPanel("table")} />}
    </div>
  );
});

/** Superscript, subscript and "clear formatting" — the rarely used marks. */
function MoreMenu({ editor, open, onToggle, onClose }: {
  editor: Editor;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const run = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div className="relative">
      <button
        type="button"
        title={t("More formatting")}
        aria-label={t("More formatting")}
        onClick={onToggle}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ChevronDown className="size-3.5" />
      </button>
      {open && (
        <Panel align="end" width={150}>
          <PanelItem onClick={() => run(() => editor.chain().focus().toggleSuperscript().run())}>
            <Superscript className="size-3.5" />
            {t("Superscript")}
          </PanelItem>
          <PanelItem onClick={() => run(() => editor.chain().focus().toggleSubscript().run())}>
            <Subscript className="size-3.5" />
            {t("Subscript")}
          </PanelItem>
          <div className="my-1 h-px bg-border" />
          <PanelItem onClick={() => run(() => editor.chain().focus().unsetAllMarks().run())}>
            <Eraser className="size-3.5" />
            {t("Clear formatting")}
          </PanelItem>
        </Panel>
      )}
    </div>
  );
}
