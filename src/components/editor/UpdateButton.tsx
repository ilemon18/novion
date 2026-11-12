import { useEffect, useRef, useState } from "react";
import { Download, RotateCw, TriangleAlert } from "lucide-react";
import { useUpdate } from "@/store/update";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

/**
 * "有更新" entry point, drawn just left of the save indicator.
 *
 * The download progress is shown as a ring around the label itself, so the
 * button never changes size: the same box goes 0% → 100% while downloading and
 * turns into "restart" once the file is complete.
 */
export function UpdateButton() {
  const t = useT();
  const status = useUpdate((s) => s.status);
  const manual = useUpdate((s) => s.manual);
  const info = useUpdate((s) => s.info);
  const percent = useUpdate((s) => s.percent);
  const error = useUpdate((s) => s.error);
  const check = useUpdate((s) => s.check);
  const download = useUpdate((s) => s.download);
  const install = useUpdate((s) => s.install);

  const ringRef = useRef<HTMLSpanElement>(null);
  const [ring, setRing] = useState<{ w: number; h: number } | null>(null);

  // the label changes ("更新" → "42%" → "重启更新"): the ring must follow it
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
    status === "error" ||
    (status === "checking" && manual);
  if (!visible) return null;

  const label =
    status === "downloading"
      ? `${percent}%`
      : status === "ready"
        ? t("Restart to update")
        : status === "checking"
          ? t("Checking…")
          : status === "error"
            ? t("Retry")
            : t("Update");

  const progress =
    status === "downloading" ? Math.max(2, Math.min(100, percent)) : status === "ready" ? 100 : 0;

  const tone =
    status === "error"
      ? "text-destructive"
      : status === "ready"
        ? "text-brand"
        : status === "available"
          ? "text-brand"
          : "text-muted-foreground";

  const tip =
    status === "downloading"
      ? t("Downloading {percent}%", { percent })
      : status === "ready"
        ? t("Click to restart and install")
        : status === "error"
          ? error ?? t("Update failed")
          : status === "checking"
            ? t("Checking for updates…")
            : t("Update available · {version}", {
                version: info ? `${info.latest} · ${formatSize(info.assetSize)}` : "",
              });

  const onClick = () => {
    if (status === "available") void download();
    else if (status === "ready") void install();
    else if (status === "error") {
      if (info?.available) void download();
      else void check(true);
    }
  };

  const Icon = status === "ready" ? RotateCw : status === "error" ? TriangleAlert : Download;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-no-window-drag
          onClick={onClick}
          aria-label={tip}
          className={cn(
            "pointer-events-auto flex select-none items-center gap-1.5 rounded-full text-[11.5px] tabular-nums outline-none transition-colors",
            tone,
            status === "downloading" && "cursor-default",
          )}
        >
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              status === "checking" && "animate-pulse",
              status === "ready" && "animate-pulse",
            )}
            strokeWidth={2}
          />
          <span ref={ringRef} className="relative inline-flex items-center px-[5px] py-[2px] leading-none">
            <span className="font-medium">{label}</span>
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
                  strokeDashoffset={100 - progress}
                  className="transition-[stroke-dashoffset] duration-200 ease-linear"
                />
              </svg>
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[280px]">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}