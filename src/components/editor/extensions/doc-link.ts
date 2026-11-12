import { Extension, type Editor, type Range } from "@tiptap/react";
import { useWorkspace } from "@/store/workspace";
import { useSlash } from "../slash-store";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import type { SlashItem } from "../slash-items";
import { FileText } from "lucide-react";
import { t } from "@/i18n";

/**
 * `[[` document links.
 *
 * Internal links are stored as a normal link mark with the URL
 * `novion://doc/<id>`, which means: one representation for click behaviour,
 * export (`[[name]]`), Notion, backlinks and search. Typing `[[` opens the same
 * suggestion menu the `/` command uses, filled with documents instead of blocks.
 */
export const DOC_LINK_PREFIX = "novion://doc/";

export function isDocLink(href: string | null | undefined): boolean {
  return !!href && href.startsWith(DOC_LINK_PREFIX);
}

export function docIdFromHref(href: string): string | null {
  if (!href.startsWith(DOC_LINK_PREFIX)) return null;
  const id = href.slice(DOC_LINK_PREFIX.length).trim();
  return id || null;
}

/** Documents matching `query`, as suggestion rows. */
export function docLinkItems(query: string): SlashItem[] {
  const { nodes } = useWorkspace.getState();
  const q = query.trim().toLowerCase();
  const rows: SlashItem[] = [];

  for (const node of Object.values(nodes)) {
    if (node.kind !== "doc" || node.builtin) continue;
    if (node.trashedAt) continue;
    const name = node.name || "Untitled";
    if (q && !name.toLowerCase().includes(q)) continue;
    // the folder chain disambiguates documents with the same title
    const crumbs: string[] = [];
    let cur = node.parentId ? nodes[node.parentId] : undefined;
    let guard = 0;
    while (cur && !cur.builtin && guard++ < 32) {
      crumbs.unshift(cur.name || "Untitled");
      cur = cur.parentId ? nodes[cur.parentId] : undefined;
    }
    const docId = node.id;
    rows.push({
      id: `link-${docId}`,
      title: name,
      description: crumbs.length ? crumbs.join(" / ") : t("Link to this document"),
      keywords: [name],
      icon: FileText,
      run: ({ editor, range }: { editor: Editor; range: Range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent([
            {
              type: "text",
              text: name,
              marks: [{ type: "link", attrs: { href: `${DOC_LINK_PREFIX}${docId}` } }],
            },
            { type: "text", text: " " },
          ])
          .run();
      },
    });
    if (rows.length >= 12) break;
  }
  return rows;
}

type Props = {
  range: unknown;
  query: string;
  items: SlashItem[];
  command: (item: SlashItem) => void;
  editor: unknown;
  clientRect?: (() => DOMRect | null) | null;
  decorationNode?: unknown;
};

function anchorOf(props: Props) {
  const rect = props.clientRect?.();
  if (!rect) return { left: 240, top: 120, bottom: 140 };
  return { left: rect.left, top: rect.top, bottom: rect.bottom };
}

/**
 * One document picker, two triggers.
 *
 * `[[` and `@` differ only in the trigger character and the header label, and
 * the suggestion plugin needs a distinct key per instance — ProseMirror throws
 * on two different plugins sharing one key.
 */
function docPicker(options: {
  name: string;
  key: string;
  char: string;
  label: string;
  allowedPrefixes?: string[] | null;
}) {
  return Extension.create({
    name: options.name,

    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          pluginKey: new PluginKey(options.key),
          editor: this.editor,
          char: options.char,
          startOfLine: false,
          allowSpaces: true,
          // `[[` is usually typed straight after a word, unlike `/`
          allowedPrefixes: options.allowedPrefixes ?? null,
          items: ({ query }) => docLinkItems(query),
          command: ({ editor, range, props }) => {
            (props as SlashItem).run({
              editor: editor as never,
              range: range as never,
            });
          },
          render: () => ({
            onStart: (props) => {
              const p = props as unknown as Props;
              useSlash
                .getState()
                .show(p.items, anchorOf(p), (item) => p.command(item), t(options.label));
            },
            onUpdate: (props) => {
              const p = props as unknown as Props;
              useSlash
                .getState()
                .show(p.items, anchorOf(p), (item) => p.command(item), t(options.label));
            },
            onKeyDown: ({ event }) => {
              const store = useSlash.getState();
              if (!store.open) return false;
              const count = store.items.length;
              if (event.key === "ArrowDown") {
                if (count) store.setIndex((store.index + 1) % count);
                return true;
              }
              if (event.key === "ArrowUp") {
                if (count) store.setIndex((store.index - 1 + count) % count);
                return true;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                if (count) store.pick();
                return true;
              }
              if (event.key === "Escape") {
                store.hide();
                return true;
              }
              return false;
            },
            onExit: () => useSlash.getState().hide(),
          }),
        }),
      ];
    },
  });
}

/** `[[` → document picker. */
export const DocLinkSuggestion = docPicker({
  name: "docLinkSuggestion",
  key: "novionDocLink",
  char: "[[",
  label: "Link to document",
});

/** `@` → the same picker, for a quick mention inline. */
export const MentionSuggestion = docPicker({
  name: "mentionSuggestion",
  key: "novionMention",
  char: "@",
  label: "Mention a document",
  // an email address must not open the picker; line starts still match
  allowedPrefixes: [" "],
});
