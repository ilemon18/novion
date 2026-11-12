import { useEffect, type RefObject } from "react";

/** Class the CSS keys off (`index.css` → `.auto-hide-scrollbar`). */
const SCROLLING_CLASS = "is-scrolling";
/** How long the thumb stays visible after the last scroll event. */
const IDLE_MS = 900;

/**
 * Marks a scroll container as "in use" while it scrolls.
 *
 * The sidebar hides its scrollbar until the pane is actually being read, which
 * `:hover` alone cannot cover: a trackpad flick with the pointer parked outside
 * the pane would leave the thumb invisible. This adds a short-lived class, so
 * the thumb fades out again as soon as scrolling settles.
 */
export function useAutoHideScrollbar(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let timer: number | null = null;
    const onScroll = () => {
      el.classList.add(SCROLLING_CLASS);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        el.classList.remove(SCROLLING_CLASS);
      }, IDLE_MS);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer !== null) window.clearTimeout(timer);
      el.classList.remove(SCROLLING_CLASS);
    };
  }, [ref]);
}
