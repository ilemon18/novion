import { useEffect, useLayoutEffect, useRef } from "react";
import { useSlash } from "./slash-store";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

const MENU_W = 292;
const MENU_MAX_H = 300;

export function SlashMenu() {
  const t = useT();
  const open = useSlash((s) => s.open);
  const items = useSlash((s) => s.items);
  const index = useSlash((s) => s.index);
  const label = useSlash((s) => s.label);
  const anchor = useSlash((s) => s.anchor);
  const setIndex = useSlash((s) => s.setIndex);
  const pick = useSlash((s) => s.pick);
  const hide = useSlash((s) => s.hide);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => hide(), [hide]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, index]);

  if (!open) return null;

  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_W - 8));
  const flipUp = anchor.bottom + MENU_MAX_H + 16 > window.innerHeight;
  const top = flipUp
    ? Math.max(8, anchor.top - MENU_MAX_H - 6)
    : Math.min(anchor.bottom + 6, window.innerHeight - MENU_MAX_H - 16);

  return (
    <div
      className="anim-menu fixed z-50 overflow-hidden rounded-lg border border-border bg-popover shadow-[0_12px_36px_-12px_rgba(0,0,0,0.35)]"
      style={{ left, top, width: MENU_W }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="truncate border-b border-border/70 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
        {label || t("Basic blocks")}
      </div>
      <div ref={listRef} className="max-h-[248px] overflow-y-auto p-1">
        {items.length === 0 && (
          <div className="px-2 py-3 text-center text-[12.5px] text-muted-foreground">
            {t("No matching blocks")}
          </div>
        )}
        {items.map((item, i) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              data-index={i}
              type="button"
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(i)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-75",
                i === index ? "bg-accent text-accent-foreground" : "text-foreground",
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <Icon className="size-3.5 opacity-80" strokeWidth={1.75} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-tight">{t(item.title)}</span>
                {item.description && (
                  <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                    {t(item.description)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2 border-t border-border/70 px-2.5 py-1 text-[10.5px] text-muted-foreground">
        <span>↑↓ {t("Select")}</span>
        <span>↵ {t("Confirm")}</span>
        <span>esc {t("Close")}</span>
      </div>
    </div>
  );
}