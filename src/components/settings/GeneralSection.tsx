import { Check, Languages } from "lucide-react";
import { LOCALE_LABELS, LOCALES, useT } from "@/i18n";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";

/**
 * Application-level preferences. Today that is the interface language; the
 * section exists so future global switches do not need a new sidebar entry.
 */
export function GeneralSection() {
  const t = useT();
  const locale = useUi((s) => s.locale);
  const setLocale = useUi((s) => s.setLocale);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {t("Language")}
        </div>
        <Languages className="size-3.5 text-muted-foreground" strokeWidth={1.8} />
      </div>

      <div className="mt-2 overflow-hidden rounded-lg border border-border">
        {LOCALES.map((option) => {
          const active = locale === option;
          return (
            <button
              key={option}
              onClick={() => setLocale(option)}
              aria-pressed={active}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors",
                active ? "bg-brand-soft text-foreground" : "hover:bg-accent/60",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{LOCALE_LABELS[option]}</span>
              <span className="shrink-0 font-mono text-[10.5px] uppercase text-muted-foreground">
                {option}
              </span>
              {active && <Check className="size-3.5 shrink-0 text-brand" />}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {t("The interface switches immediately. Your notes are never translated.")}
      </p>
    </div>
  );
}