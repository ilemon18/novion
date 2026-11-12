import { Check, Monitor, Moon, Sun } from "lucide-react";
import {
  DOC_FONT_STACKS,
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  resolveTheme,
  useUi,
  type DocFontId,
  type PaletteId,
  type ThemeMode,
} from "@/store/ui";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

const MODES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Preview swatches: page / card / accent, per light and dark variant. */
const PALETTES: {
  id: PaletteId;
  label: string;
  light: [string, string, string];
  dark: [string, string, string];
}[] = [
  { id: "paper", label: "Paper", light: ["#f7f6f3", "#ffffff", "#4a6fa5"], dark: ["#1a1a1a", "#212121", "#6b9bd2"] },
  { id: "catppuccin", label: "Catppuccin", light: ["#eff1f5", "#ffffff", "#1d64ef"], dark: ["#1e1e2e", "#24273a", "#89b4fa"] },
  { id: "github", label: "GitHub", light: ["#ffffff", "#ffffff", "#0969da"], dark: ["#22272e", "#2d333b", "#539bf5"] },
  { id: "rose-pine", label: "Rosé Pine", light: ["#faf4ed", "#fffaf3", "#286983"], dark: ["#232136", "#2a273f", "#c4a7e7"] },
  { id: "gruvbox", label: "Gruvbox", light: ["#fbf1c7", "#fffcf2", "#076678"], dark: ["#282828", "#32302f", "#83a598"] },
];

/** Order matches `DOC_FONT_IDS`; labels go through `t()` at render time. */
const DOC_FONTS: { id: DocFontId; label: string }[] = [
  { id: "system", label: "System default" },
  { id: "inter", label: "Inter" },
  { id: "serif", label: "Source Serif" },
  { id: "mono", label: "JetBrains Mono" },
];

export function AppearanceSection() {
  const t = useT();
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const palette = useUi((s) => s.palette);
  const setPalette = useUi((s) => s.setPalette);
  const fontSize = useUi((s) => s.fontSize);
  const setFontSize = useUi((s) => s.setFontSize);
  const docFont = useUi((s) => s.docFont);
  const setDocFont = useUi((s) => s.setDocFont);

  const dark = resolveTheme(theme) === "dark";

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {t("Colour scheme")}
        </div>
        <div className="flex items-center gap-1 rounded-md bg-muted/60 p-0.5">
          {MODES.map((mode) => {
            const active = theme === mode.value;
            return (
              <button
                key={mode.value}
                onClick={() => setTheme(mode.value)}
                aria-pressed={active}
                className={cn(
                  "flex h-6 items-center gap-1 rounded px-2 text-[11.5px] transition-colors",
                  active
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <mode.icon className="size-3" strokeWidth={1.9} />
                {t(mode.label)}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        {PALETTES.map((option) => {
          const active = palette === option.id;
          const swatches = dark ? option.dark : option.light;
          return (
            <button
              key={option.id}
              onClick={() => setPalette(option.id)}
              aria-pressed={active}
              className={cn(
                "rounded-lg border p-2 text-left transition-colors",
                active ? "border-brand/60 bg-brand-soft" : "border-border hover:bg-accent/60",
              )}
            >
              <div className="flex gap-1">
                {swatches.map((color, index) => (
                  <span
                    key={index}
                    className={cn(
                      "h-6 flex-1 rounded border border-black/5",
                      index === 0 && "flex-[2]",
                    )}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <span className="flex-1 text-[12.5px] font-medium">{t(option.label)}</span>
                {active && <Check className="size-3.5 text-brand" />}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-6 border-t border-border/70 pt-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {t("Font")}
          </div>
          {docFont !== "system" && (
            <button
              onClick={() => setDocFont("system")}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t("Reset")}
            </button>
          )}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          {DOC_FONTS.map((option) => {
            const active = docFont === option.id;
            return (
              <button
                key={option.id}
                onClick={() => setDocFont(option.id)}
                aria-pressed={active}
                className={cn(
                  "rounded-lg border p-2 text-left transition-colors",
                  active ? "border-brand/60 bg-brand-soft" : "border-border hover:bg-accent/60",
                )}
              >
                <div className="flex h-8 items-center overflow-hidden">
                  {/* Latin sample plus one CJK glyph, so the fallback pairing is visible */}
                  <span
                    className="truncate text-[17px] leading-none"
                    style={{ fontFamily: DOC_FONT_STACKS[option.id] }}
                  >
                    Aa 文
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-1">
                  <span className="flex-1 truncate text-[12.5px] font-medium">
                    {t(option.label)}
                  </span>
                  {active && <Check className="size-3.5 shrink-0 text-brand" />}
                </div>
              </button>
            );
          })}
        </div>

        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {t("Applies to the whole interface and documents")}
        </p>
      </div>

      <div className="mt-6 border-t border-border/70 pt-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {t("Body text size")}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium tabular-nums text-brand">{fontSize}px</span>
            {fontSize !== FONT_SIZE_DEFAULT && (
              <button
                onClick={() => setFontSize(FONT_SIZE_DEFAULT)}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {t("Reset")}
              </button>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2.5">
          <span className="w-6 text-right text-[10.5px] tabular-nums text-muted-foreground/70">
            {FONT_SIZE_MIN}
          </span>
          <input
            type="range"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            aria-label={t("Body text size")}
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted outline-none [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:shadow-sm"
          />
          <span className="w-6 text-[10.5px] tabular-nums text-muted-foreground/70">
            {FONT_SIZE_MAX}
          </span>
        </div>

        <p
          className="mt-2.5 rounded-md bg-muted/50 px-2.5 py-2 leading-relaxed text-foreground/85"
          style={{ fontSize: `${fontSize}px`, fontFamily: DOC_FONT_STACKS[docFont] }}
        >
          {t("Preview text")}
        </p>
      </div>
    </div>
  );
}