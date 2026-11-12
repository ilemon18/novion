/**
 * Locale identity, kept free of any store import so `store/ui.ts` can depend on
 * it without creating an import cycle with the translation layer.
 */
export type Locale = "en" | "zh-CN" | "zh-TW" | "ja" | "es";

export const LOCALES: Locale[] = ["en", "zh-CN", "zh-TW", "ja", "es"];

/** Names shown in the picker, always in the language they name. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  es: "Español",
};

export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as string[]).includes(value);
}

/** Keeps `document.documentElement.lang` (screen readers, hyphenation) in sync. */
export function applyLocale(locale: Locale) {
  document.documentElement.lang = locale;
}