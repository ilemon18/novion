/**
 * Minimal, dependency-free i18n.
 *
 * The catalogue is keyed by the English source text. A missing key falls back
 * to the key itself, so shipping an untranslated string is never a crash — it
 * only shows English. `scripts/check-i18n.mjs` keeps the catalogue complete.
 */
import { useUi } from "@/store/ui";
import { MESSAGES } from "./messages";
import type { Locale } from "./locale";

export {
  LOCALES,
  LOCALE_LABELS,
  DEFAULT_LOCALE,
  isLocale,
  applyLocale,
  type Locale,
} from "./locale";

/** Short tags for compact pickers. */
export const LOCALE_SHORT: Record<Locale, string> = {
  en: "EN",
  "zh-CN": "简",
  "zh-TW": "繁",
  ja: "日",
  es: "ES",
};

const COLUMN: Record<Exclude<Locale, "en">, 0 | 1 | 2 | 3> = {
  "zh-CN": 0,
  "zh-TW": 1,
  ja: 2,
  es: 3,
};

type Vars = Record<string, string | number>;

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Translates `msgid` into the active locale.
 *
 * Safe to call outside React (stores, editor extensions, IPC helpers): it reads
 * the live store value instead of a captured one.
 */
export function t(msgid: string, vars?: Vars): string {
  const locale = useUi.getState().locale;
  if (locale === "en") return interpolate(msgid, vars);
  const row = MESSAGES[msgid];
  if (!row) return interpolate(msgid, vars);
  return interpolate(row[COLUMN[locale]], vars);
}

/** Component hook: re-renders the caller whenever the language changes. */
export function useT(): typeof t {
  useUi((s) => s.locale);
  return t;
}

/** Locale-aware date formatting for "last synced at" style labels. */
export function formatDateTime(ms: number, locale: Locale): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    const date = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`;
  }
}