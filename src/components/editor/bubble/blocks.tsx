import type { Editor } from "@tiptap/react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { Panel, PanelItem, PanelLabel, type PanelControlProps } from "./parts";

/**
 * "Turn into" — the block type dropdown on the left of the bar.
 *
 * The table doubles as the source of `BLOCK_LABEL` (what the button says for
 * the caret's current block) and of the signature the bar re-renders on, so a
 * new block type is added in exactly one place.
 */
export const TRANSFORMS: { id: string; label: string; run: (editor: Editor) => void }[] = [
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

export const BLOCK_LABEL: Record<string, string> = Object.fromEntries(
  TRANSFORMS.map((item) => [item.id, item.label]),
);

export function currentBlock(editor: Editor): string {
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

export function BlockPicker({ editor, open, onToggle, onClose }: PanelControlProps) {
  const t = useT();
  const block = currentBlock(editor);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {t(BLOCK_LABEL[block] ?? "Text")}
        <ChevronDown className="size-3 opacity-60" />
      </button>
      {open && (
        <Panel width={148}>
          <PanelLabel>{t("Turn into")}</PanelLabel>
          {TRANSFORMS.map((item) => (
            <PanelItem
              key={item.id}
              onClick={() => {
                item.run(editor);
                onClose();
              }}
            >
              <span className={cn(item.id !== "p" && "font-semibold")}>
                {t(item.label)}
              </span>
            </PanelItem>
          ))}
        </Panel>
      )}
    </div>
  );
}
