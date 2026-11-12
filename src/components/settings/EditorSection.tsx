import { useEffect, useRef, useState } from "react";
import { Baseline, History, ListTree, Sigma, type LucideIcon } from "lucide-react";
import { api, errorMessage } from "@/lib/tauri";
import { useUi, type FeatureFlags } from "@/store/ui";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n";

/**
 * Retention of the rolling version history.
 *
 * The numbers mirror `HISTORY_LIMIT_MIN / MAX / DEFAULT` in
 * `src-tauri/src/config.rs`; the backend clamps again, so a stale UI can never
 * write an out-of-range value.
 */
const LIMIT_MIN = 5;
const LIMIT_MAX = 20;
const LIMIT_DEFAULT = 10;

const FEATURES: { key: keyof FeatureFlags; label: string; hint: string; icon: LucideIcon }[] = [
  { key: "outline", label: "Outline and contents", hint: "The right-hand outline and the “Table of contents” block", icon: ListTree },
  { key: "history", label: "Version history", hint: "Automatic snapshots and restore", icon: History },
  { key: "bubbleMenu", label: "Formatting toolbar", hint: "Appears when you select text", icon: Baseline },
  { key: "richBlocks", label: "Maths and image controls", hint: "KaTeX rendering, image resizing", icon: Sigma },
];

export function EditorSection() {
  const t = useT();
  const notify = useUi((s) => s.notify);
  const features = useUi((s) => s.features);
  const setFeature = useUi((s) => s.setFeature);
  const [limit, setLimit] = useState(LIMIT_DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getHistoryLimit()
      .then((value) => {
        if (!alive) return;
        setLimit(value);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  /** One save per gesture: dragging the slider must not rewrite every history folder. */
  const persist = (value: number) => {
    setLimit(value);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void api.setHistoryLimit(value).catch((err) => {
        notify(errorMessage(err), { tone: "error", timeout: 7000 });
      });
    }, 320);
  };

  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {t("Features")}
      </div>
      <div className="mt-2 divide-y divide-border/70 rounded-lg border border-border/70">
        {FEATURES.map((item) => (
          <div key={item.key} className="flex items-center gap-2.5 px-3 py-2.5">
            <item.icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.7} />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium leading-tight">{t(item.label)}</div>
              <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                {t(item.hint)}
              </div>
            </div>
            <Switch
              checked={features[item.key]}
              onChange={(value) => setFeature(item.key, value)}
              label={t(item.label)}
            />
          </div>
        ))}
      </div>

      {features.history && (
        <div className="mt-6 border-t border-border/70 pt-4">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              {t("Version history limit")}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium tabular-nums text-brand">
                {t("{count} entries", { count: limit })}
              </span>
              {loaded && limit !== LIMIT_DEFAULT && (
                <button
                  onClick={() => persist(LIMIT_DEFAULT)}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {t("Reset")}
                </button>
              )}
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2.5">
            <span className="w-4 text-right text-[10.5px] tabular-nums text-muted-foreground/70">
              {LIMIT_MIN}
            </span>
            <input
              type="range"
              min={LIMIT_MIN}
              max={LIMIT_MAX}
              step={1}
              value={limit}
              onChange={(e) => persist(Number(e.target.value))}
              aria-label={t("Version history limit")}
              className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted outline-none [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:shadow-sm"
            />
            <span className="w-4 text-[10.5px] tabular-nums text-muted-foreground/70">
              {LIMIT_MAX}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}