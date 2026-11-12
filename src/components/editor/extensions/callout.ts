import { Node, mergeAttributes } from "@tiptap/react";
import { t } from "@/i18n";

export type CalloutKind = "info" | "tip" | "warning" | "danger";

/**
 * A tinted, bordered aside — the block people reach for to mark "note to self"
 * or "this will break".
 *
 * Stored as a plain `callout` node with a `kind` attribute, so it survives
 * Markdown export (`> [!NOTE]`, the Obsidian form), the Notion mirror and the
 * HTML/PDF render without any extra mapping.
 */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: "info" as CalloutKind,
        parseHTML: (element: HTMLElement) =>
          (element.getAttribute("data-kind") as CalloutKind | null) ?? "info",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-kind": (attributes.kind as string) ?? "info",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-callout": "", class: "callout-block" }),
      0,
    ];
  },

  /**
   * The kind is part of the block, so switching it has to live on the block:
   * a small chip in the top-right corner cycles note → tip → warning → danger.
   * It only appears on hover so it never competes with the text.
   */
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "callout-block";
      dom.setAttribute("data-callout", "");
      dom.dataset.kind = String(current.attrs.kind ?? "info");

      const switcher = document.createElement("button");
      switcher.type = "button";
      switcher.className = "callout-kind";
      switcher.contentEditable = "false";
      switcher.setAttribute("aria-label", t("Switch callout type"));
      switcher.textContent = kindLabel(String(current.attrs.kind ?? "info"));
      switcher.addEventListener("mousedown", (event) => event.preventDefault());
      switcher.addEventListener("click", (event) => {
        event.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        const order = ["info", "tip", "warning", "danger"];
        const at = order.indexOf(String(current.attrs.kind ?? "info"));
        const next = order[(at + 1) % order.length];
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, kind: next }),
        );
      });

      const content = document.createElement("div");
      content.className = "callout-content";
      dom.append(switcher, content);

      return {
        dom,
        contentDOM: content,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          const kind = String(updated.attrs.kind ?? "info");
          dom.dataset.kind = kind;
          switcher.textContent = kindLabel(kind);
          return true;
        },
        ignoreMutation: (mutation) =>
          mutation.type === "selection"
            ? false
            : !content.contains(mutation.target as globalThis.Node),
      };
    };
  },
});

const KIND_LABEL: Record<string, string> = {
  info: "Note",
  tip: "Tip",
  warning: "Caution",
  danger: "Warning",
};

function kindLabel(kind: string): string {
  return t(KIND_LABEL[kind] ?? KIND_LABEL.info);
}
