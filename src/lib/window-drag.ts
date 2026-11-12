import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

/**
 * Long-press window dragging.
 *
 * The window uses an overlay title bar, so the native drag strip is only a thin
 * sliver at the top. Holding the pointer still on a non-interactive surface for
 * `HOLD_MS` starts moving the window; moving earlier cancels, which keeps text
 * selection and drag-and-drop untouched.
 *
 * The window is moved from JS (`setPosition`) rather than through
 * `startDragging()`: the native call needs a live NSEvent and silently does
 * nothing when fired from a timer.
 */
const HOLD_MS = 300;
const MOVE_TOLERANCE = 5;

const BLOCKED = [
  "input",
  "textarea",
  "select",
  "button",
  "a",
  "label",
  "kbd",
  "img",
  "[contenteditable='true']",
  ".tiptap",
  ".ProseMirror",
  "[draggable='true']",
  "[data-no-window-drag]",
  "[data-tauri-drag-region]",
  "[role='dialog']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='option']",
  "[role='listbox']",
  "[data-radix-popper-content-wrapper]",
].join(",");

function isBlocked(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  return !!el.closest(BLOCKED);
}

export function installLongPressWindowDrag(): () => void {
  // plain browser (vite dev without Tauri) has no window API
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return () => undefined;
  }
  const win = getCurrentWindow();

  let timer: number | null = null;
  let armed = false;
  let dragging = false;

  let holdX = 0;
  let holdY = 0;

  // physical window origin at drag start
  let originX = 0;
  let originY = 0;
  let scale = 1;
  let pointerX = 0;
  let pointerY = 0;
  let targetX = 0;
  let targetY = 0;
  let frame = 0;

  const flush = () => {
    frame = 0;
    void win.setPosition(new PhysicalPosition(Math.round(targetX), Math.round(targetY)));
  };

  const endDrag = () => {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const clearHold = () => {
    armed = false;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const beginDrag = async (x: number, y: number) => {
    try {
      scale = await win.scaleFactor();
      const pos = await win.outerPosition();
      originX = pos.x;
      originY = pos.y;
      pointerX = x;
      pointerY = y;
      targetX = pos.x;
      targetY = pos.y;
      dragging = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      // the pointerdown that armed the drag may have started a text selection
      window.getSelection()?.removeAllRanges();
    } catch {
      dragging = false;
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.defaultPrevented) return;
    if (isBlocked(e.target)) return;
    holdX = e.clientX;
    holdY = e.clientY;
    armed = true;
    timer = window.setTimeout(() => {
      timer = null;
      if (!armed) return;
      armed = false;
      void beginDrag(holdX, holdY);
    }, HOLD_MS);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (dragging) {
      e.preventDefault();
      pointerX = e.clientX;
      pointerY = e.clientY;
      targetX = originX + (pointerX - holdX) * scale;
      targetY = originY + (pointerY - holdY) * scale;
      if (!frame) frame = requestAnimationFrame(flush);
      return;
    }
    if (!armed) return;
    if (
      Math.abs(e.clientX - holdX) > MOVE_TOLERANCE ||
      Math.abs(e.clientY - holdY) > MOVE_TOLERANCE
    ) {
      clearHold();
    }
  };

  const onPointerUp = () => {
    clearHold();
    endDrag();
  };

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerUp, true);
  window.addEventListener("blur", onPointerUp);

  return () => {
    onPointerUp();
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
    window.removeEventListener("blur", onPointerUp);
  };
}
