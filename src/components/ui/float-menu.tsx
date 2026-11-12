import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DESTRUCTIVE_CLASS,
  MENU_SEPARATOR_CLASS,
} from "./menu-styles";

/**
 * A context menu drawn at pointer coordinates, without a popper.
 *
 * Radix's `ContextMenu` stores the click point and the open flag separately, so
 * the first frame of the portal can still be laid out against the initial
 * `{x: 0, y: 0}` anchor and only then jump to the real position — visible as a
 * menu flashing in the top-left corner. (It gets worse when the trigger row is
 * re-rendered by a tree update while the menu opens.)
 *
 * This component removes the timing question entirely:
 * - the anchor is the pointer position captured in the very `contextmenu` event;
 * - the box is measured and clamped inside a layout effect, which runs before
 *   the browser paints, so the first painted frame is already correct;
 * - it stays hidden until that measurement happened, so even a slow layout pass
 *   can never show it at the wrong place.
 */
export interface FloatMenuProps {
  open: boolean;
  /** viewport coordinates of the request (e.clientX / e.clientY) */
  x: number;
  y: number;
  onClose: () => void;
  /** accessible name, e.g. the row name */
  label?: string;
  className?: string;
  children: React.ReactNode;
}

const EDGE = 8;

export function FloatMenu({ open, x, y, onClose, label, className, children }: FloatMenuProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const restoreFocus = React.useRef<HTMLElement | null>(null);

  // a new request always starts un-positioned, even if the previous menu was
  // already measured
  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    restoreFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPos(null);
  }, [open, x, y]);

  // measure + clamp before paint, then focus the box so the keyboard can drive it
  React.useLayoutEffect(() => {
    if (!open || pos) return;
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
    const maxTop = Math.max(EDGE, window.innerHeight - height - EDGE);
    setPos({
      left: Math.min(Math.max(EDGE, x), maxLeft),
      top: Math.min(Math.max(EDGE, y), maxTop),
    });
    el.focus({ preventScroll: true });
  }, [open, pos, x, y]);

  // closing restores the caret the user had before the right-click
  React.useEffect(() => {
    if (open || !restoreFocus.current) return;
    const previous = restoreFocus.current;
    restoreFocus.current = null;
    if (previous.isConnected) previous.focus({ preventScroll: true });
  }, [open]);

  React.useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const items = menuItems(ref.current);
      if (!items.length) return;
      const active = document.activeElement;
      const index = items.findIndex((item) => item === active);
      const focus = (next: number) => {
        event.preventDefault();
        items[(next + items.length) % items.length].focus();
      };
      if (event.key === "ArrowDown") focus(index < 0 ? 0 : index + 1);
      else if (event.key === "ArrowUp") focus(index < 0 ? items.length - 1 : index - 1);
      else if (event.key === "Home") focus(0);
      else if (event.key === "End") focus(items.length - 1);
      else if ((event.key === "Enter" || event.key === " ") && index >= 0) {
        event.preventDefault();
        items[index].click();
      }
    };
    // a scrolling or resizing window invalidates the stored coordinates
    const onDismiss = () => onClose();

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-no-window-drag
      onBlur={(event) => {
        // tabbing out of the menu is a dismissal, like clicking elsewhere
        if (!ref.current?.contains(event.relatedTarget as Node | null)) onClose();
      }}
      className={cn("anim-menu fixed outline-none", MENU_CONTENT_CLASS, className)}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // the first frame has no reliable position yet; never paint it at 0,0
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function menuItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    (item) => !item.hasAttribute("data-disabled"),
  );
}

export function FloatMenuItem({
  icon: Icon,
  destructive,
  onSelect,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  destructive?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={onSelect}
      className={cn(MENU_ITEM_CLASS, destructive && MENU_ITEM_DESTRUCTIVE_CLASS)}
    >
      {Icon ? <Icon /> : null}
      {children}
    </button>
  );
}

export function FloatMenuSeparator() {
  return <div role="separator" className={MENU_SEPARATOR_CLASS} />;
}