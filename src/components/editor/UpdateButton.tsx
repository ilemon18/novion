import { useEffect, useMemo, useRef, useState } from "react";
import { useUpdate } from "@/store/update";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { runUpdateAction, updateAction, updateTip, type UpdateView } from "@/lib/update-view";
import { useT } from "@/i18n";

/**
 * "有更新" entry point, drawn just left of the save indicator.
 *
 * One button, one action: clicking it downloads, the label becomes the
 * percentage with a ring that fills as the file arrives, and once the file is
 * complete the same button turns into "重启更新" and installs on click. What the
 * label says comes from `lib/update-view.ts`, shared with the button in
 * Settings → About, so the two can never offer different steps.
 *
 * Note the z-index of the parent: this sits in the macOS overlay-title-bar
 * strip, where `App.tsx` paints a `z-20` native drag region. At `z-10` the whole
 * button was covered by that strip and every click started dragging the window
 * instead — which is why it "did nothing".
 */
export function UpdateButton() {
  const t = useT();
  const status = useUpdate((s) => s.status);
  const manual = useUpdate((s) => s.manual);
  const info = useUpdate((s) => s.info);
  const percent = useUpdate((s) => s.percent);
  const error = useUpdate((s) => s.error);
  const installedTo = useUpdate((s) => s.installedTo);

  const ringRef = useRef<HTMLSpanElement>(null);
  const [ring, setRing] = useState<{ w: number; h: number } | null>(null);

  const view: UpdateView = useMemo(
    () => ({ status, info, percent, error, installedTo, version: null }),
    [status, info, percent, error, installedTo],
  );
  const action = updateAction(view, t);
  const tip = updateTip(view, t);
  const busy = action.kind === "wait";

  /**
   * A screen reader hears the label, not the ring. Announcing every progress
   * event would be a flood, so the download is rounded down to whole tens: ten
   * announcements for the whole file instead of hundreds.
   */
  const announcement =
    status === "downloading"
      ? t("Downloading {percent}%", {
          percent: Math.min(100, Math.max(10, Math.floor(percent / 10) * 10)),
        })
      : action.label;

  // the label changes ("下载更新" → "42%" → "重启更新"): the ring must follow it
  useEffect(() => {
    const element = ringRef.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return;
      setRing((prev) =>
        prev && Math.abs(prev.w - box.width) < 0.5 && Math.abs(prev.h - box.height) < 0.5
          ? prev
          : { w: box.width, h: box.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [status]);

  const visible =
    status === "available" ||
    status === "downloading" ||
    status === "ready" ||
    status === "installing" ||
    status === "error" ||
    (status === "checking" && manual);
  if (!visible) return null;

  const Icon = action.icon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-no-window-drag
          onClick={() => runUpdateAction(action.kind)}
          // `aria-disabled` rather than `disabled`: a disabled button swallows
          // pointer events, and the tooltip ("下载中 42%") is exactly what a
          // busy state has to keep saying
          aria-disabled={busy}
          aria-label={tip}
          aria-busy={busy}
          className={cn(
            "pointer-events-auto flex cursor-pointer select-none items-center gap-2 rounded-full py-1 pl-2 pr-2.5 text-[11.5px] tabular-nums outline-none transition-colors",
            "hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/40 active:bg-accent",
            action.tone === "danger" && "text-destructive",
            action.tone === "brand" && "text-brand",
            action.tone === "muted" && "text-muted-foreground",
            status === "ready" && "bg-brand/10 hover:bg-brand/15",
            busy && "cursor-default hover:bg-transparent",
          )}
        >
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              action.motion === "spin" && "animate-spin",
              action.motion === "pulse" && "animate-pulse",
            )}
            strokeWidth={2}
          />
          <span
            ref={ringRef}
            className="relative inline-flex items-center px-[7px] py-[3px] leading-none"
          >
            <span className="font-medium">{action.label}</span>
            {ring && (
              <svg
                aria-hidden
                width={ring.w}
                height={ring.h}
                viewBox={`0 0 ${ring.w} ${ring.h}`}
                className={cn(
                  "pointer-events-none absolute inset-0 overflow-visible",
                  status === "checking" && "animate-pulse",
                )}
              >
                {/* track: the full "circle" the progress fills in */}
                <rect
                  x={0.75}
                  y={0.75}
                  width={Math.max(0, ring.w - 1.5)}
                  height={Math.max(0, ring.h - 1.5)}
                  rx={(ring.h - 1.5) / 2}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={0.22}
                  strokeWidth={1.5}
                />
                <rect
                  x={0.75}
                  y={0.75}
                  width={Math.max(0, ring.w - 1.5)}
                  height={Math.max(0, ring.h - 1.5)}
                  rx={(ring.h - 1.5) / 2}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  pathLength={100}
                  strokeDasharray={100}
                  strokeDashoffset={100 - action.percent}
                  className="transition-[stroke-dashoffset] duration-200 ease-linear"
                />
              </svg>
            )}
          </span>
          <span role="status" aria-live="polite" className="sr-only">
            {announcement}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[280px]">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}
