import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * One `ResizeObserver` for every label on the screen.
 *
 * The sidebar virtualises rows, but up to ~200 of them are mounted at once, and
 * a dedicated observer per row meant 200 live platform objects just to answer
 * "is this text clipped". A single shared observer answering for all of them
 * costs one object and a small map.
 */
const measureByElement = new Map<Element, () => void>();
let sharedObserver: ResizeObserver | null = null;

function observeClipping(el: Element, measure: () => void): () => void {
  if (typeof ResizeObserver === "undefined") return () => undefined;
  if (!sharedObserver) {
    sharedObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        measureByElement.get(entry.target)?.();
      }
    });
  }
  measureByElement.set(el, measure);
  sharedObserver.observe(el);
  return () => {
    measureByElement.delete(el);
    sharedObserver?.unobserve(el);
    if (measureByElement.size === 0) {
      sharedObserver?.disconnect();
      sharedObserver = null;
    }
  };
}

interface Props {
  /** plain text to show (and to repeat in the tooltip) */
  text: string;
  /** rendered when `text` is empty; no tooltip in that case */
  fallback?: ReactNode;
  className?: string;
  /** suppress the tooltip (e.g. while a row is being dragged) */
  disabled?: boolean;
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * A single-line label that ellipsises, and shows the full text in a tooltip
 * *only when it is actually clipped*.
 *
 * Measuring happens whenever the label's box changes: the sidebar virtualises
 * rows and resizes with the window, so "is it truncated" has to be re-answered
 * on width changes, not just when the text changes.
 */
export function TruncatedLabel({
  text,
  fallback,
  className,
  disabled,
  side = "right",
}: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = !!text && el.scrollWidth > el.clientWidth + 1;
      setClipped((prev) => (prev === next ? prev : next));
    };
    measure();
    return observeClipping(el, measure);
  }, [text]);

  // `open` stays controlled at all times so the Tooltip never flips between
  // controlled and uncontrolled mode (that remounts the trigger and drops the
  // observer subscription).
  const canShow = clipped && !disabled;

  return (
    <Tooltip open={canShow && open} onOpenChange={(next) => setOpen(canShow && next)}>
      <TooltipTrigger asChild>
        <span ref={ref} className={cn("block min-w-0 truncate", className)}>
          {text || fallback}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        align="center"
        sideOffset={10}
        className="max-w-[320px] break-words leading-relaxed"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
