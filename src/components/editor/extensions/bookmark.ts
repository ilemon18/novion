import { Node, mergeAttributes } from "@tiptap/react";
import { t } from "@/i18n";

/** `https://example.com/a/b` → `example.com`, for the card's source chip. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.replace(/^[a-z]+:\/\//i, "").split("/")[0] || url;
  }
}

/**
 * Link card / embed placeholder.
 *
 * No network request is made: the app never talks to the web from the webview.
 * The card stores the URL plus the title and description the paste provided,
 * which is enough to make a saved link readable, and clicking it hands the URL
 * to the system browser through the editor's existing link handling.
 */
export const Bookmark = Node.create({
  name: "bookmark",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-url") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-url": String(attributes.url ?? ""),
        }),
      },
      title: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-title") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-title": String(attributes.title ?? ""),
        }),
      },
      description: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-description") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-description": String(attributes.description ?? ""),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-bookmark]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-bookmark": "" })];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;

      const dom = document.createElement("div");
      dom.className = "bookmark-block";
      dom.setAttribute("data-bookmark", "");
      dom.contentEditable = "false";

      const anchor = document.createElement("a");
      anchor.className = "bookmark-link";
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";

      const text = document.createElement("div");
      text.className = "bookmark-text";

      const heading = document.createElement("div");
      heading.className = "bookmark-title";

      const description = document.createElement("div");
      description.className = "bookmark-description";

      const host = document.createElement("div");
      host.className = "bookmark-host";

      text.append(heading, description, host);
      anchor.appendChild(text);
      dom.appendChild(anchor);

      // clicking the card opens the link, and the editor swallows the caret
      // there, so removing the block needs its own target
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "bookmark-remove";
      remove.textContent = "×";
      remove.title = t("Remove link card");
      remove.addEventListener("mousedown", (event) => event.preventDefault());
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        editor.view.dispatch(
          editor.view.state.tr.delete(pos, pos + current.nodeSize),
        );
      });
      dom.appendChild(remove);

      const form = document.createElement("div");
      form.className = "bookmark-form";

      const input = document.createElement("input");
      input.type = "url";
      input.placeholder = t("Paste a link and press Enter");
      input.spellcheck = false;
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.textContent = t("Add");
      form.append(input, confirm);
      dom.appendChild(form);

      const commit = (url: string) => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            url,
            title: String(current.attrs.title ?? "") || hostOf(url),
          }),
        );
      };

      const submit = () => {
        const value = input.value.trim();
        if (!value) return;
        commit(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
        event.stopPropagation();
      });
      confirm.addEventListener("mousedown", (event) => event.preventDefault());
      confirm.addEventListener("click", submit);

      const sync = () => {
        const url = String(current.attrs.url ?? "");
        const title = String(current.attrs.title ?? "") || (url ? hostOf(url) : "");
        const note = String(current.attrs.description ?? "");
        anchor.href = url || "#";
        anchor.setAttribute("data-empty", url ? "false" : "true");
        heading.textContent = title || t("Untitled link");
        description.textContent = note;
        description.dataset.open = note ? "true" : "false";
        host.textContent = url ? hostOf(url) : "";
        form.dataset.open = url ? "false" : "true";
      };
      sync();

      return {
        dom,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          sync();
          return true;
        },
        // the inner form is real DOM input, not editable prose
        stopEvent: (event) => {
          const target = event.target as globalThis.Node | null;
          return !!target && (form.contains(target) || remove.contains(target));
        },
        ignoreMutation: () => true,
      };
    };
  },
});