import type { Editor, Range } from "@tiptap/react";
import type { LucideIcon } from "lucide-react";
import {
  AtSign,
  Bookmark as BookmarkIcon,
  CheckSquare,
  ChevronRight,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image as ImageIcon,
  Info,
  Link2,
  List,
  ListOrdered,
  ListTree,
  Minus,
  Sigma,
  Quote,
  Table as TableIcon,
  Type,
} from "lucide-react";
import { t } from "@/i18n";
import { pickImage } from "./image-insert";

export interface SlashItem {
  id: string;
  /** English source text, translated where the menu renders it */
  title: string;
  description?: string;
  keywords: string[];
  icon: LucideIcon;
  run: (ctx: { editor: Editor; range: Range }) => void;
}

const chain = (editor: Editor, range: Range) =>
  editor.chain().focus().deleteRange(range);

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: "paragraph",
    title: "Text",
    keywords: ["text", "paragraph", "正文", "p"],
    icon: Type,
    run: ({ editor, range }) => chain(editor, range).setParagraph().run(),
  },
  {
    id: "h1",
    title: "Heading 1",
    keywords: ["h1", "heading", "title", "标题"],
    icon: Heading1,
    run: ({ editor, range }) => chain(editor, range).setNode("heading", { level: 1 }).run(),
  },
  {
    id: "h2",
    title: "Heading 2",
    keywords: ["h2", "heading", "subtitle", "标题"],
    icon: Heading2,
    run: ({ editor, range }) => chain(editor, range).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "h3",
    title: "Heading 3",
    keywords: ["h3", "heading", "标题"],
    icon: Heading3,
    run: ({ editor, range }) => chain(editor, range).setNode("heading", { level: 3 }).run(),
  },
  {
    id: "h4",
    title: "Heading 4",
    keywords: ["h4", "heading", "标题"],
    icon: Heading4,
    run: ({ editor, range }) => chain(editor, range).setNode("heading", { level: 4 }).run(),
  },
  {
    id: "h5",
    title: "Heading 5",
    keywords: ["h5", "heading", "标题"],
    icon: Heading5,
    run: ({ editor, range }) => chain(editor, range).setNode("heading", { level: 5 }).run(),
  },
  {
    id: "h6",
    title: "Heading 6",
    keywords: ["h6", "heading", "标题"],
    icon: Heading6,
    run: ({ editor, range }) => chain(editor, range).setNode("heading", { level: 6 }).run(),
  },
  {
    id: "bullet",
    title: "Bulleted list",
    keywords: ["bulleted", "list", "ul", "无序", "列表"],
    icon: List,
    run: ({ editor, range }) => chain(editor, range).toggleBulletList().run(),
  },
  {
    id: "numbered",
    title: "Numbered list",
    keywords: ["numbered", "ordered", "list", "ol", "有序", "编号"],
    icon: ListOrdered,
    run: ({ editor, range }) => chain(editor, range).toggleOrderedList().run(),
  },
  {
    id: "todo",
    title: "Task list",
    keywords: ["todo", "task", "checkbox", "待办", "任务", "清单"],
    icon: CheckSquare,
    run: ({ editor, range }) => chain(editor, range).toggleTaskList().run(),
  },
  {
    id: "code",
    title: "Code block",
    keywords: ["code", "pre", "代码"],
    icon: Code2,
    run: ({ editor, range }) => chain(editor, range).toggleCodeBlock().run(),
  },
  {
    id: "quote",
    title: "Quote",
    keywords: ["quote", "blockquote", "引用"],
    icon: Quote,
    run: ({ editor, range }) => chain(editor, range).toggleBlockquote().run(),
  },
  {
    id: "divider",
    title: "Divider",
    keywords: ["divider", "hr", "line", "分割", "分隔"],
    icon: Minus,
    run: ({ editor, range }) => chain(editor, range).setHorizontalRule().run(),
  },
  {
    id: "image",
    title: "Image",
    keywords: ["image", "img", "photo", "图片", "照片"],
    icon: ImageIcon,
    run: ({ editor, range }) => {
      chain(editor, range).run();
      void pickImage(editor);
    },
  },
  {
    id: "table",
    title: "Table",
    description: "Three columns by three rows",
    keywords: ["table", "grid", "sheet", "表格", "表"],
    icon: TableIcon,
    run: ({ editor, range }) => {
      chain(editor, range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    },
  },
  {
    id: "callout",
    title: "Callout",
    keywords: ["callout", "note", "tip", "warning", "提示", "注意", "强调"],
    icon: Info,
    run: ({ editor, range }) => {
      chain(editor, range)
        .insertContent({
          type: "callout",
          attrs: { kind: "info" },
          content: [{ type: "paragraph" }],
        })
        .run();
    },
  },
  {
    id: "toggle",
    title: "Toggle",
    keywords: ["toggle", "fold", "collapse", "details", "折叠", "收起", "展开"],
    icon: ChevronRight,
    run: ({ editor, range }) => {
      chain(editor, range)
        .insertContent({
          type: "toggle",
          attrs: { open: true },
          content: [
            { type: "paragraph", content: [{ type: "text", text: t("Toggle title") }] },
            { type: "paragraph" },
          ],
        })
        .run();
    },
  },
  {
    id: "doc-link",
    title: "Link to a note",
    description: "You can also type [[",
    keywords: ["link", "wiki", "reference", "链接", "引用", "关联"],
    icon: Link2,
    run: ({ editor, range }) => {
      // leaving the `[[` typed in place lets the suggestion popup take over
      chain(editor, range).insertContent("[[").run();
    },
  },
  {
    id: "mention",
    title: "Mention a note",
    description: "You can also type @",
    keywords: ["mention", "at", "提及", "引用"],
    icon: AtSign,
    run: ({ editor, range }) => {
      chain(editor, range).insertContent("@").run();
    },
  },
  {
    id: "toc",
    title: "Table of contents",
    description: "Built from the headings in this note",
    keywords: ["toc", "outline", "目录", "大纲", "索引"],
    icon: ListTree,
    run: ({ editor, range }) => {
      chain(editor, range).insertContent({ type: "toc" }).run();
    },
  },
  {
    id: "bookmark",
    title: "Link card",
    description: "Save a URL with a title and description",
    keywords: ["bookmark", "embed", "link", "card", "链接", "收藏", "卡片", "嵌入"],
    icon: BookmarkIcon,
    run: ({ editor, range }) => {
      chain(editor, range)
        .insertContent({ type: "bookmark", attrs: { url: "", title: "", description: "" } })
        .run();
    },
  },
  {
    id: "math-inline",
    title: "Inline formula",
    description: "You can also type $formula$",
    keywords: ["math", "formula", "latex", "公式", "数学"],
    icon: Sigma,
    run: ({ editor, range }) => {
      chain(editor, range)
        .insertContent({ type: "inlineMath", attrs: { latex: "x" } })
        .run();
    },
  },
  {
    id: "math-block",
    title: "Formula block",
    description: "A formula on its own line",
    keywords: ["math", "formula", "latex", "block", "公式", "数学"],
    icon: Sigma,
    run: ({ editor, range }) => {
      chain(editor, range)
        .insertContent({ type: "blockMath", attrs: { latex: "E = mc^2" } })
        .run();
    },
  },
];

/**
 * `hidden` drops entries whose feature is switched off in settings. Those node
 * types stay registered in the schema, so existing blocks still render and
 * save — the menu just stops offering new ones.
 */
export function filterSlashItems(query: string, hidden: readonly string[] = []): SlashItem[] {
  const available = hidden.length
    ? SLASH_ITEMS.filter((item) => !hidden.includes(item.id))
    : SLASH_ITEMS;
  const q = query.trim().toLowerCase();
  if (!q) return available;
  return available.filter(
    (item) =>
      t(item.title).toLowerCase().includes(q) ||
      item.keywords.some((k) => k.includes(q)),
  );
}

/** Slash entries disabled by the current feature flags. */
export function hiddenSlashItems(features: {
  outline: boolean;
  richBlocks: boolean;
}): string[] {
  const hidden: string[] = [];
  if (!features.outline) hidden.push("toc");
  if (!features.richBlocks) hidden.push("math-inline", "math-block");
  return hidden;
}