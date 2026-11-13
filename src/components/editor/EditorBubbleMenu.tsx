import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { BubbleContent } from "./bubble/body";

/**
 * Floating formatting bar.
 *
 * Deliberately *not* `@tiptap/react`'s `BubbleMenu`: that component hands its
 * React-rendered root to tippy, which moves the node into a popper on `body`.
 * React still believes the node lives under the editor, so unmounting anything
 * (a doc switch, a settings toggle) makes it call `removeChild` on a node that
 * is no longer there and WebKit throws "The object can not be found here".
 *
 * Here the bar is a plain portal to `body` that we position ourselves from the
 * current selection, so nothing inside the editor tree is relocated.
 *
 * The controls themselves live in `./bubble/`: one file per group of them
 * (`blocks`, `colors`, `link`, `table`), the shared primitives in `parts.tsx`
 * and the re-render fingerprint in `signature.ts`. This file only decides
 * *where* the bar goes.
 */

/** Same rules the TipTap bubble-menu plugin used. */
function shouldShowBar(editor: Editor): boolean {
  // the table toolbar only exists here, so a caret in a cell still needs the
  // bar even without a text selection
  if (editor.isActive("table")) return true;
  const { selection } = editor.state;
  if (selection.empty) return false;
  // images, bookmarks, the TOC and formulas are atoms with their own controls;
  // a second floating bar on top of them is just noise
  if (selection instanceof NodeSelection && selection.node.type.isAtom) return false;
  return true;
}

export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const barRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (editor.isDestroyed) return;
    let frame = 0;
    let lastKey = "";

    /** `force` re-reads the viewport position for the same selection (scroll). */
    const measure = (force: boolean) => {
      if (editor.isDestroyed || !shouldShowBar(editor)) {
        lastKey = "";
        setAnchor(null);
        return;
      }
      const { from, to } = editor.state.selection;
      const key = `${from}:${to}:${editor.isActive("table") ? 1 : 0}`;
      if (!force && key === lastKey) return;
      lastKey = key;
      try {
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        setAnchor({
          top: Math.min(start.top, end.top),
          left: (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2,
        });
      } catch {
        // a selection can point at a node the view no longer renders
        setAnchor(null);
      }
    };

    // coalesced to one measurement per frame: typing moves the caret on every
    // keystroke, and `coordsAtPos` forces layout
    const schedule = (force = false) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure(force);
      });
    };
    const onTransaction = () => schedule(false);
    const onViewport = () => schedule(true);
    const onBlur = ({ event }: { event: FocusEvent }) => {
      const next = (event?.relatedTarget as Node | null) ?? null;
      if (next && barRef.current?.contains(next)) return;
      if (next === editor.view.dom) return;
      setAnchor(null);
      lastKey = "";
    };

    measure(false);
    editor.on("transaction", onTransaction);
    editor.on("selectionUpdate", onTransaction);
    editor.on("focus", onViewport);
    editor.on("blur", onBlur);
    window.addEventListener("resize", onViewport);
    document.addEventListener("scroll", onViewport, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      editor.off("transaction", onTransaction);
      editor.off("selectionUpdate", onTransaction);
      editor.off("focus", onViewport);
      editor.off("blur", onBlur);
      window.removeEventListener("resize", onViewport);
      document.removeEventListener("scroll", onViewport, true);
    };
  }, [editor]);

  // the bar is kept mounted (hidden) while there is no selection: mounting and
  // unmounting it on every caret move made Radix panels flicker
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === size.width && rect.height === size.height) return;
    setSize({ width: rect.width, height: rect.height });
  });

  const margin = 8;
  const half = size.width / 2;
  const left = anchor && half
    ? Math.min(Math.max(anchor.left, half + margin), window.innerWidth - half - margin)
    : 0;
  const top = anchor ? Math.max(anchor.top - 10, margin + size.height) : 0;

  return createPortal(
    <div
      ref={barRef}
      className="fixed z-40 -translate-x-1/2 -translate-y-full"
      style={{
        top,
        left,
        visibility: anchor ? "visible" : "hidden",
        pointerEvents: anchor ? undefined : "none",
      }}
    >
      <BubbleContent editor={editor} />
    </div>,
    document.body,
  );
}
