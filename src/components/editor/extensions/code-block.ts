import CodeBlock from "@tiptap/extension-code-block";
import { LANGUAGES, resolveLanguage } from "@/lib/highlight/languages";
import { t } from "@/i18n";

/**
 * Code block with a language picker.
 *
 * The tokenizer already understands a `language` attribute, but nothing ever
 * wrote it — every block fell back to auto-detection. The node view puts a
 * picker in the block's top-right corner; the attribute is the only thing that
 * changes, so the stored document stays a normal `codeBlock` node and the
 * existing Markdown / HTML export keeps working.
 */
export const CodeBlockView = CodeBlock.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;

      const dom = document.createElement("div");
      dom.className = "code-node";

      const select = document.createElement("select");
      select.className = "code-language";
      select.contentEditable = "false";
      select.setAttribute("aria-label", t("Code language"));

      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = t("Auto-detect");
      select.appendChild(auto);

      for (const language of LANGUAGES) {
        if (!language.id) continue;
        const option = document.createElement("option");
        option.value = language.id;
        option.textContent = language.id;
        select.appendChild(option);
      }

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      pre.appendChild(code);

      const commit = (value: string) => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            language: value || null,
          }),
        );
      };

      select.addEventListener("mousedown", (event) => event.stopPropagation());
      select.addEventListener("change", () => commit(select.value));

      const sync = () => {
        const raw = (current.attrs.language as string | null | undefined) ?? "";
        const resolved = resolveLanguage(raw)?.id ?? "";
        // an alias ("ts", "jsx") is not one of the option values; keep the raw
        // entry visible instead of silently showing "自动识别"
        if (resolved) {
          select.value = resolved;
        } else if (raw) {
          const custom = document.createElement("option");
          custom.value = raw;
          custom.textContent = raw;
          select.appendChild(custom);
          select.value = raw;
        } else {
          select.value = "";
        }
      };
      sync();

      dom.append(select, pre);

      return {
        dom,
        contentDOM: code,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          sync();
          return true;
        },
        stopEvent: (event) => {
          const target = event.target as globalThis.Node | null;
          return !!target && select.contains(target);
        },
        ignoreMutation: (mutation) =>
          mutation.type === "selection"
            ? false
            : !code.contains(mutation.target as globalThis.Node),
      };
    };
  },
});