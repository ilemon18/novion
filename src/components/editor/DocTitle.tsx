import { useLayoutEffect, useRef, type RefObject } from "react";
import { useImeSafeInput } from "@/lib/use-ime-safe-input";
import { useT } from "@/i18n";

interface Props {
  value: string;
  /** Called while typing (already composition-safe). */
  onChange: (value: string) => void;
  /** Called once on Enter/blur — flush the rename immediately. */
  onCommit?: (value: string) => void;
  /** Enter with no IME composition: the only path that leaves the title. */
  onEnter?: () => void;
  onBlur?: () => void;
  inputRef?: RefObject<HTMLTextAreaElement>;
}

/**
 * Document title.
 *
 * A textarea (not an input) so a long title wraps onto several lines instead of
 * scrolling sideways out of view; it grows with its content and never shows a
 * scrollbar. Enter still means "jump into the body" — `useImeSafeInput`
 * prevents the default, so no newline is ever inserted.
 *
 * Deliberately *not* a controlled input: writing the store value back on every
 * keystroke breaks IME composition in WKWebView (the field commits and drops
 * focus mid-sentence). The draft lives in `useImeSafeInput`; the parent only
 * pushes a new value in when the field is not focused.
 */
export function DocTitle({ value, onChange, onCommit, onEnter, onBlur, inputRef }: Props) {
  const t = useT();
  const field = useImeSafeInput({
    initialValue: value,
    onChange: (next) => onChange(next),
    onCommit: (next) => {
      onChange(next);
      onCommit?.(next);
    },
  });

  // store -> input, but never while the user owns the field
  useLayoutEffect(() => {
    const el = inputRef?.current;
    if (el && document.activeElement === el) return;
    field.reset(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // keep the box exactly as tall as its wrapped content
  const fitRef = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    const el = inputRef?.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fitRef.current = fit;
    fit();
    // re-fit when the column width changes (window resize, sidebar drag, font
    // size setting). Guarded on width so setting the height cannot re-trigger
    // the observer into a loop — and the observer is created once per element
    // instead of once per keystroke.
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [inputRef]);

  // the draft grows or shrinks: refit without touching the observer
  useLayoutEffect(() => {
    fitRef.current();
  }, [field.draft, value]);

  return (
    <textarea
      ref={inputRef}
      value={field.draft}
      rows={1}
      wrap="soft"
      onChange={field.handleChange}
      onCompositionStart={field.handleCompositionStart}
      onCompositionEnd={field.handleCompositionEnd}
      onBlur={() => {
        field.handleBlur();
        onBlur?.();
      }}
      onKeyDown={(e) => {
        field.handleKeyDown(e);
        // handleKeyDown only prevents the default for a real Enter (never while
        // the IME is composing), so this is the single "jump to body" path
        if (e.key === "Enter" && e.defaultPrevented) onEnter?.();
      }}
      placeholder={t("Untitled")}
      spellCheck={false}
      className="block w-full resize-none overflow-hidden whitespace-pre-wrap break-words selectable bg-transparent text-[length:var(--doc-title-size)] font-semibold leading-[1.22] tracking-[-0.022em] text-foreground outline-none [font-family:var(--font-doc)] placeholder:text-muted-foreground/40"
    />
  );
}
