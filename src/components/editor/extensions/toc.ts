import { Node } from "@tiptap/react";
import { t } from "@/i18n";

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/**
 * Table-of-contents block.
 *
 * The list is rendered from the live document on every change instead of being
 * stored: headings stay the single source of truth, and moving a heading does
 * not leave a stale entry behind. The node itself is an atom with no content,
 * so it costs one line in the JSON.
 */
export const Toc = Node.create({
  name: "toc",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return {
      /**
       * When the outline feature is switched off the block stops following the
       * document (no `update` subscription, no debounce timer). The node itself
       * stays registered and keeps rendering, so existing documents are never
       * stripped of their `toc` nodes on save.
       */
      live: true,
    };
  },

  parseHTML() {
    return [{ tag: "div[data-toc]" }];
  },

  renderHTML() {
    return ["div", { "data-toc": "" }, t("Table of contents")];
  },

  addNodeView() {
    const live = this.options.live;
    return ({ editor }) => {
      const dom = document.createElement("div");
      dom.className = "toc-block";
      dom.contentEditable = "false";

      const title = document.createElement("div");
      title.className = "toc-heading";
      title.textContent = t("Table of contents");

      const list = document.createElement("ol");
      list.className = "toc-list";

      dom.append(title, list);

      /** heading text + level only: positions are resolved at click time */
      let signature = "";
      const rebuild = () => {
        const root = editor.view.dom as HTMLElement;
        const heads = Array.from(root.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
        const next = heads
          .map((head) => `${head.tagName}:${(head.textContent ?? "").trim()}`)
          .join("\n");
        // typing in a paragraph changes the document on every keystroke but
        // never this list; rebuilding it each time was pure DOM churn
        if (next === signature) return;
        signature = next;
        list.replaceChildren();
        if (heads.length === 0) {
          const empty = document.createElement("li");
          empty.className = "toc-empty";
          empty.textContent = t("Add headings to generate a table of contents");
          list.appendChild(empty);
          return;
        }
        for (const head of heads) {
          const level = Number(head.tagName.slice(1)) || 1;
          const item = document.createElement("li");
          item.className = "toc-item";
          item.style.paddingLeft = `${(level - 1) * 12}px`;
          item.textContent = (head.textContent ?? "").trim() || t("Empty heading");
          item.addEventListener("mousedown", (event) => event.preventDefault());
          item.addEventListener("click", (event) => {
            event.preventDefault();
            let pos = 0;
            try {
              pos = editor.view.posAtDOM(head, 0);
            } catch {
              return;
            }
            editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run();
          });
          list.appendChild(item);
        }
      };

      let timer = 0;
      const schedule = () => {
        if (timer) return;
        timer = window.setTimeout(() => {
          timer = 0;
          rebuild();
        }, 120);
      };
      if (live) editor.on("update", schedule);
      rebuild();

      return {
        dom,
        update: () => true,
        // clicks fall through to ProseMirror so the block can be selected and
        // deleted; the entries stop their own mousedown before that happens
        stopEvent: () => false,
        ignoreMutation: () => true,
        destroy: () => {
          if (live) editor.off("update", schedule);
          if (timer) window.clearTimeout(timer);
        },
      };
    };
  },
});