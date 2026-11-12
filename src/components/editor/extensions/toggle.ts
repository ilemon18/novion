import { Node, mergeAttributes } from "@tiptap/react";
import { t } from "@/i18n";

/**
 * Collapsible block.
 *
 * The first child block is the summary; everything after it is the collapsible
 * body. Collapsing is a CSS-only `display: none` on the body blocks, so the
 * document model stays a plain `block+` container (no node-view state to
 * serialize) and the text keeps being searchable and exportable.
 *
 * The caret is rendered by a small node view: it needs a click target that does
 * not move the caret into the text.
 */
export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-open") !== "false",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-open": attributes.open === false ? "false" : "true",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-toggle]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-toggle": "", class: "toggle-block" }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "toggle-block";
      dom.setAttribute("data-toggle", "");
      dom.dataset.open = current.attrs.open === false ? "false" : "true";

      const caret = document.createElement("button");
      caret.type = "button";
      caret.className = "toggle-caret";
      caret.contentEditable = "false";
      caret.setAttribute("aria-label", t("Expand or collapse"));
      caret.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      // a mousedown here must not start a text selection inside the block
      caret.addEventListener("mousedown", (event) => event.preventDefault());
      caret.addEventListener("click", (event) => {
        event.preventDefault();
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        const next = current.attrs.open === false;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            open: next,
          }),
        );
      });

      const content = document.createElement("div");
      content.className = "toggle-content";

      dom.append(caret, content);

      return {
        dom,
        contentDOM: content,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          dom.dataset.open = updated.attrs.open === false ? "false" : "true";
          return true;
        },
        // the caret lives outside contentDOM, so clicks on it are not text input
        ignoreMutation: (mutation) =>
          mutation.type === "selection"
            ? false
            : !content.contains(mutation.target as globalThis.Node),
      };
    };
  },
});
