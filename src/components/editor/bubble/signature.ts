import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { currentBlock } from "./blocks";

/**
 * What the bar draws, as a cheap string.
 *
 * The editor runs with `shouldRerenderOnTransaction: false`, so the bar keeps
 * its own subscription. Bumping state on *every* transaction re-rendered the
 * whole bar (~20 buttons) while typing, and that showed up as a hitch the
 * moment a panel had to open on top of it. The subscription below therefore
 * compares this fingerprint and only re-renders when one of those values
 * changed.
 */
export function barSignature(editor: Editor): string {
  const mark = (name: string) => (editor.isActive(name) ? 1 : 0);
  const color = (name: string) =>
    (editor.getAttributes(name).color as string | undefined) ?? "";
  return [
    mark("bold"),
    mark("italic"),
    mark("underline"),
    mark("strike"),
    mark("code"),
    mark("superscript"),
    mark("subscript"),
    mark("link"),
    mark("textStyle"),
    mark("highlight"),
    color("textStyle"),
    color("highlight"),
    currentBlock(editor),
    // the table controls depend on the cell the caret sits in; inside a table
    // the caret position is part of what the bar shows
    editor.isActive("table") ? `t${editor.state.selection.from}` : "t0",
  ].join("|");
}

export function useBarSignature(editor: Editor): void {
  const known = useRef(barSignature(editor));
  const [, bump] = useState(0);
  useEffect(() => {
    const update = () => {
      // nothing is drawn without a selection (the table toolbar is the one
      // exception), so typing in a plain paragraph costs no fingerprint work
      if (editor.state.selection.empty && !editor.isActive("table")) return;
      const next = barSignature(editor);
      if (next === known.current) return;
      known.current = next;
      bump((value) => value + 1);
    };
    editor.on("transaction", update);
    editor.on("selectionUpdate", update);
    return () => {
      editor.off("transaction", update);
      editor.off("selectionUpdate", update);
    };
  }, [editor]);
}
