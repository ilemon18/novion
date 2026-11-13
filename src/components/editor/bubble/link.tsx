import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Link as LinkIcon, Unlink } from "lucide-react";
import { useT } from "@/i18n";
import { ToolButton } from "./parts";

/**
 * Link controls.
 *
 * The field swaps in place of the link button instead of opening a panel, so
 * typing a URL never moves the caret out of the selection the link applies to.
 * It keeps its own state: it is the one control here that is not a dropdown.
 */

/** Normalises what people type into the link field into a usable href. */
export function toHref(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value}`;
}

function LinkEditor({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const t = useT();
  const [value, setValue] = useState(
    () => (editor.getAttributes("link").href as string | undefined) ?? "",
  );

  const commit = () => {
    const href = toHref(value);
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    onDone();
  };

  return (
    <span className="flex items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onDone();
          }
        }}
        placeholder={t("Paste a link and press Enter")}
        spellCheck={false}
        className="h-6 w-[168px] rounded border border-border bg-background px-1.5 text-[12px] outline-none focus:border-brand"
      />
      <ToolButton title={t("Apply link")} onClick={commit}>
        <LinkIcon className="size-3.5" />
      </ToolButton>
    </span>
  );
}

export function LinkControls({ editor }: { editor: Editor }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      {open ? (
        <LinkEditor editor={editor} onDone={() => setOpen(false)} />
      ) : (
        <ToolButton title={t("Link")} active={editor.isActive("link")} onClick={() => setOpen(true)}>
          <LinkIcon className="size-3.5" />
        </ToolButton>
      )}
      {editor.isActive("link") && !open && (
        <ToolButton
          title={t("Remove link")}
          onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
        >
          <Unlink className="size-3.5" />
        </ToolButton>
      )}
    </>
  );
}
