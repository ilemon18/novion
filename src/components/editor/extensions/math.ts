import { Node, mergeAttributes } from "@tiptap/react";
import "katex/dist/katex.min.css";
import { t } from "@/i18n";

/**
 * KaTeX is ~500 KB of JavaScript that the overwhelming majority of documents
 * never need. It is loaded the first time a formula is actually rendered, so
 * opening a note without math does not pay for it.
 */
let katexPromise: Promise<typeof import("katex")> | null = null;

function loadKatex(): Promise<typeof import("katex")> {
  katexPromise ??= import("katex");
  return katexPromise;
}

function emptyHtml(): string {
  return `<span class="math-empty">${t("Double-click to edit formula")}</span>`;
}

/**
 * Inline (`$…$`) and block (`$$…$$`) math.
 *
 * The document stores the LaTeX source; KaTeX only paints the node view, so a
 * formula stays editable, searchable and portable. Markdown export uses the
 * same `$` syntax the importer understands.
 */
function createMathNode(name: "inlineMath" | "blockMath") {
  const display = name === "blockMath";
  return Node.create({
    name,
    group: display ? "block" : "inline",
    inline: !display,
    atom: true,
    selectable: true,

    /**
     * With the "heavy blocks" feature off the formula still parses and saves,
     * but nothing calls `loadKatex()`: the node shows its LaTeX source instead
     * of a rendered formula, so KaTeX never enters memory.
     */
    addOptions() {
      return { render: true };
    },

    addAttributes() {
      return {
        latex: {
          default: "",
          parseHTML: (element: HTMLElement) =>
            element.getAttribute("data-latex") ?? element.textContent ?? "",
          renderHTML: (attributes: Record<string, unknown>) => ({
            "data-latex": String(attributes.latex ?? ""),
          }),
        },
      };
    },

    parseHTML() {
      return [{ tag: display ? "div[data-math]" : "span[data-math]" }];
    },

    renderHTML({ HTMLAttributes, node }) {
      return [
        display ? "div" : "span",
        mergeAttributes(HTMLAttributes, { "data-math": "" }),
        String(node.attrs.latex ?? ""),
      ];
    },

    addNodeView() {
      const render = this.options.render;
      return ({ node, editor, getPos }) => {
        let current = node;
        /** latest render request; a stale KaTeX result must not overwrite it */
        let renderToken = 0;

        const dom = document.createElement(display ? "div" : "span");
        dom.className = display ? "math-block" : "math-inline";
        dom.dataset.math = "";

        const view = document.createElement(display ? "div" : "span");
        view.className = "math-view";

        const input = document.createElement("textarea");
        input.className = "math-input";
        input.rows = display ? 3 : 1;
        input.spellcheck = false;
        input.placeholder = display ? t("LaTeX, e.g. \\frac{a}{b}") : "LaTeX";

        dom.append(view, input);

        const paint = () => {
          const token = ++renderToken;
          const latex = String(current.attrs.latex ?? "").trim();
          if (!latex) {
            view.innerHTML = emptyHtml();
            return;
          }
          if (!render) {
            view.textContent = latex;
            return;
          }
          // the previous output stays on screen while the module loads, which
          // keeps later re-renders flicker-free
          if (!view.firstChild) view.textContent = latex;
          void loadKatex()
            .then((module) => {
              if (token !== renderToken || !dom.isConnected) return;
              view.innerHTML = module.default.renderToString(latex, {
                displayMode: display,
                throwOnError: false,
                strict: false,
                output: "html",
              });
            })
            .catch(() => {
              if (token === renderToken) view.textContent = latex;
            });
        };

        const setEditing = (on: boolean) => {
          dom.dataset.editing = on ? "true" : "false";
          if (!on) return;
          input.value = String(current.attrs.latex ?? "");
          window.requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        };

        const commit = () => {
          if (dom.dataset.editing !== "true") return;
          const pos = typeof getPos === "function" ? getPos() : null;
          const latex = input.value;
          dom.dataset.editing = "false";
          if (pos == null) return;
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(pos, undefined, {
              ...current.attrs,
              latex,
            }),
          );
        };

        dom.addEventListener("dblclick", (event) => {
          event.preventDefault();
          setEditing(true);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            dom.dataset.editing = "false";
          }
          event.stopPropagation();
        });
        input.addEventListener("blur", () => commit());
        input.addEventListener("mousedown", (event) => event.stopPropagation());

        paint();
        // a freshly inserted formula opens straight into the editor
        if (!String(current.attrs.latex ?? "").trim()) {
          window.requestAnimationFrame(() => setEditing(true));
        }

        return {
          dom,
          update: (updated) => {
            if (updated.type !== current.type) return false;
            current = updated;
            paint();
            return true;
          },
          stopEvent: (event) => {
            const target = event.target as globalThis.Node | null;
            return !!target && input.contains(target) && dom.dataset.editing === "true";
          },
          destroy: () => {
            // invalidate an in-flight lazy render
            renderToken += 1;
          },
          ignoreMutation: () => true,
        };
      };
    },
  });
}

export const InlineMath = createMathNode("inlineMath");
export const BlockMath = createMathNode("blockMath");