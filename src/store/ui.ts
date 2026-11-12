import { create } from "zustand";
import { applyLocale, isLocale, type Locale } from "@/i18n/locale";

export type ThemeMode = "system" | "light" | "dark";
export type SettingsSection =
  | "general"
  | "editor"
  | "appearance"
  | "storage"
  | "notion"
  | "about";

/** Colour scheme layered on top of the light/dark mode. */
export type PaletteId = "paper" | "catppuccin" | "github" | "rose-pine" | "gruvbox";

export const PALETTE_IDS: PaletteId[] = [
  "paper",
  "catppuccin",
  "github",
  "rose-pine",
  "gruvbox",
];

/** Built-in typefaces; the whole interface and the document both use them. */
export type DocFontId = "system" | "inter" | "serif" | "mono";

export const DOC_FONT_IDS: DocFontId[] = ["system", "inter", "serif", "mono"];

/**
 * Latin faces ship with the app (`src/assets/fonts`, OFL). Each stack ends in
 * the platform CJK faces so Chinese/Japanese/Korean text keeps a sensible
 * companion instead of falling back to an arbitrary default.
 */
export const DOC_FONT_STACKS: Record<DocFontId, string> = {
  // Each stack keeps the macOS faces first and names the Windows equivalents
  // after them, so switching platforms does not silently fall back to Arial.
  system:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif',
  inter:
    '"Inter Variable", -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif',
  serif:
    '"Source Serif 4 Variable", "Source Serif 4", Georgia, "Songti SC", "Noto Serif CJK SC", SimSun, serif',
  mono:
    '"JetBrains Mono Variable", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Cascadia Mono", "PingFang SC", monospace',
};

const THEME_KEY = "novion:theme";
const LOCALE_KEY = "novion:locale";
const PALETTE_KEY = "novion:palette";
const FEATURES_KEY = "novion:features";
const WIDTH_KEY = "novion:sidebar-width";
const SIDEBAR_OPEN_KEY = "novion:sidebar-open";
const SETTINGS_SECTION_KEY = "novion:settings-section";
const FONT_SIZE_KEY = "novion:doc-font-size";
const FONT_SIZE_VERSION_KEY = "novion:doc-font-size-v";
const DOC_FONT_KEY = "novion:doc-font";
const OUTLINE_KEY = "novion:outline-open";
const FONT_SIZE_VERSION = 3;

export const FONT_SIZE_MIN = 13;
export const FONT_SIZE_MAX = 20;
export const FONT_SIZE_DEFAULT = 15;
/** the default shipped before v3; see the migration note in `readFontSize` */
const FONT_SIZE_PREVIOUS_DEFAULT = 14;

function readTheme(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

/**
 * English is the shipped default. A stored choice always wins; anything
 * unrecognised (older profile, hand-edited storage) falls back to English.
 */
function readLocale(): Locale {
  const v = localStorage.getItem(LOCALE_KEY);
  return isLocale(v) ? v : "en";
}

function readPalette(): PaletteId {
  const v = localStorage.getItem(PALETTE_KEY);
  return PALETTE_IDS.includes(v as PaletteId) ? (v as PaletteId) : "paper";
}

function readDocFont(): DocFontId {
  const v = localStorage.getItem(DOC_FONT_KEY);
  return DOC_FONT_IDS.includes(v as DocFontId) ? (v as DocFontId) : "system";
}

/**
 * Optional features a user can switch off to cut resident work (outline tree,
 * version-history snapshots, the formatting bubble, KaTeX / image controls).
 *
 * Every default is `true`, so a profile without the key behaves exactly as
 * before. The *schemas* of toc / math / image stay registered even when a flag
 * is off — dropping a node type would make TipTap discard those nodes on the
 * next save.
 */
export interface FeatureFlags {
  outline: boolean;
  history: boolean;
  bubbleMenu: boolean;
  richBlocks: boolean;
}

export const FEATURE_DEFAULTS: FeatureFlags = {
  outline: true,
  history: true,
  bubbleMenu: true,
  richBlocks: true,
};

function readFeatures(): FeatureFlags {
  try {
    const raw = localStorage.getItem(FEATURES_KEY);
    if (!raw) return FEATURE_DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return FEATURE_DEFAULTS;
    const stored = parsed as Partial<Record<keyof FeatureFlags, unknown>>;
    const next = { ...FEATURE_DEFAULTS };
    for (const key of Object.keys(FEATURE_DEFAULTS) as (keyof FeatureFlags)[]) {
      if (typeof stored[key] === "boolean") next[key] = stored[key] as boolean;
    }
    return next;
  } catch {
    return FEATURE_DEFAULTS;
  }
}

function readWidth(): number {
  const v = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(v) && v >= 180 && v <= 420 ? v : 248;
}

/** Hidden only when the user explicitly collapsed it once. */
function readSidebarOpen(): boolean {
  return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0";
}

const clampFontSize = (v: number) =>
  Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(v)));

function readFontSize(): number {
  const raw = localStorage.getItem(FONT_SIZE_KEY);
  // NOTE: `Number(null)` is 0 (finite!), which used to clamp a fresh profile
  // down to 13px instead of using the default — treat "no key" as unset.
  const stored = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);

  let value = Number.isFinite(stored) ? stored : FONT_SIZE_DEFAULT;

  if (localStorage.getItem(FONT_SIZE_VERSION_KEY) !== String(FONT_SIZE_VERSION)) {
    // v2 normalised every profile onto the then-default (14px) and *wrote that
    // number back*, so a stored 14 is indistinguishable from "never touched".
    // Moving the default to 15px therefore migrates 14 → 15 once; values the
    // user picked by hand (13, 16–20) are kept.
    if (!Number.isFinite(stored) || stored === FONT_SIZE_PREVIOUS_DEFAULT) {
      value = FONT_SIZE_DEFAULT;
    }
    localStorage.setItem(FONT_SIZE_VERSION_KEY, String(FONT_SIZE_VERSION));
  }

  const size = clampFontSize(value);
  localStorage.setItem(FONT_SIZE_KEY, String(size));
  return size;
}

function readSettingsSection(): SettingsSection {
  const v = localStorage.getItem(SETTINGS_SECTION_KEY);
  return v === "general" ||
    v === "editor" ||
    v === "appearance" ||
    v === "storage" ||
    v === "notion" ||
    v === "about"
    ? v
    : "general";
}

export interface ConfirmState {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm?: () => void;
}

export type NoticeTone = "info" | "success" | "error";

export interface Notice {
  id: number;
  text: string;
  tone: NoticeTone;
  /** optional single action, e.g. "在 Finder 中显示" */
  actionLabel?: string;
  action?: () => void;
}

export interface NoticeOptions {
  tone?: NoticeTone;
  /** milliseconds; 0 keeps it until dismissed */
  timeout?: number;
  actionLabel?: string;
  action?: () => void;
}

let noticeSeq = 0;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export interface UiState {
  theme: ThemeMode;
  /** UI language; English unless the user picked something else */
  locale: Locale;
  palette: PaletteId;
  /** optional features the user can switch off (see `FeatureFlags`) */
  features: FeatureFlags;
  /** bumps on every feature toggle, so the editor can remount with new options */
  featuresRev: number;
  /** document body size in px (13–20) */
  fontSize: number;
  /**
   * face for the whole interface (sidebar, menus, settings) and the document
   * title + body; every surface but code blocks follows the choice
   */
  docFont: DocFontId;
  sidebarWidth: number;
  /** false = the left rail is collapsed and the content gets the full width */
  sidebarOpen: boolean;
  confirm: ConfirmState;
  searchOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** ⌘⇧P action palette */
  commandOpen: boolean;
  /** right-hand heading outline of the open document */
  outlineOpen: boolean;
  /** in-document find bar (⌘F) */
  findOpen: boolean;
  /** prefilled query for the find bar, set when a global search hit is opened */
  findSeed: string | null;
  /** document whose version history dialog is open */
  historyDocId: string | null;
  notice: Notice | null;
  setTheme: (t: ThemeMode) => void;
  setLocale: (locale: Locale) => void;
  setPalette: (p: PaletteId) => void;
  setFeature: <K extends keyof FeatureFlags>(key: K, value: FeatureFlags[K]) => void;
  setFontSize: (px: number) => void;
  setDocFont: (font: DocFontId) => void;
  setSidebarWidth: (w: number) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  askConfirm: (state: Omit<ConfirmState, "open">) => void;
  closeConfirm: () => void;
  setSearchOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setCommandOpen: (open: boolean) => void;
  setOutlineOpen: (open: boolean) => void;
  toggleOutline: () => void;
  setFindOpen: (open: boolean) => void;
  setFindSeed: (seed: string | null) => void;
  openHistory: (docId: string) => void;
  closeHistory: () => void;
  notify: (text: string, options?: NoticeOptions) => void;
  dismissNotice: () => void;
}

export const useUi = create<UiState>((set, get) => ({
  theme: readTheme(),
  locale: readLocale(),
  palette: readPalette(),
  features: readFeatures(),
  featuresRev: 0,
  fontSize: readFontSize(),
  docFont: readDocFont(),
  sidebarWidth: readWidth(),
  sidebarOpen: readSidebarOpen(),
  confirm: { open: false, title: "" },
  searchOpen: false,
  settingsOpen: false,
  settingsSection: readSettingsSection(),
  commandOpen: false,
  outlineOpen: localStorage.getItem(OUTLINE_KEY) === "1",
  findOpen: false,
  findSeed: null,
  historyDocId: null,
  notice: null,

  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },

  setLocale: (locale) => {
    localStorage.setItem(LOCALE_KEY, locale);
    applyLocale(locale);
    set({ locale });
  },

  setPalette: (palette) => {
    localStorage.setItem(PALETTE_KEY, palette);
    set({ palette });
  },

  setFeature: (key, value) => {
    const features = { ...get().features, [key]: value };
    localStorage.setItem(FEATURES_KEY, JSON.stringify(features));
    set((state) => ({ features, featuresRev: state.featuresRev + 1 }));
  },

  setFontSize: (px) => {
    const size = clampFontSize(px);
    localStorage.setItem(FONT_SIZE_KEY, String(size));
    localStorage.setItem(FONT_SIZE_VERSION_KEY, String(FONT_SIZE_VERSION));
    applyFontSize(size);
    set({ fontSize: size });
  },

  setDocFont: (docFont) => {
    localStorage.setItem(DOC_FONT_KEY, docFont);
    applyDocFont(docFont);
    set({ docFont });
  },

  setSidebarWidth: (w) => {
    const width = Math.min(420, Math.max(180, Math.round(w)));
    localStorage.setItem(WIDTH_KEY, String(width));
    set({ sidebarWidth: width });
  },

  setSidebarOpen: (sidebarOpen) => {
    localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? "1" : "0");
    set({ sidebarOpen });
  },

  toggleSidebar: () => {
    const next = !get().sidebarOpen;
    localStorage.setItem(SIDEBAR_OPEN_KEY, next ? "1" : "0");
    set({ sidebarOpen: next });
  },

  askConfirm: (state) => set({ confirm: { ...state, open: true } }),

  closeConfirm: () => set({ confirm: { ...get().confirm, open: false } }),

  setSearchOpen: (searchOpen) => set({ searchOpen }),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  setSettingsSection: (settingsSection) => {
    localStorage.setItem(SETTINGS_SECTION_KEY, settingsSection);
    set({ settingsSection });
  },

  setCommandOpen: (commandOpen) => set({ commandOpen }),

  setOutlineOpen: (outlineOpen) => {
    localStorage.setItem(OUTLINE_KEY, outlineOpen ? "1" : "0");
    set({ outlineOpen });
  },

  setFindOpen: (findOpen) => set({ findOpen }),

  setFindSeed: (findSeed) => set({ findSeed }),

  toggleOutline: () => {
    const next = !get().outlineOpen;
    localStorage.setItem(OUTLINE_KEY, next ? "1" : "0");
    set({ outlineOpen: next });
  },

  openHistory: (historyDocId) => set({ historyDocId }),

  closeHistory: () => set({ historyDocId: null }),

  notify: (text, options) => {
    noticeSeq += 1;
    const notice: Notice = {
      id: noticeSeq,
      text,
      tone: options?.tone ?? "info",
      actionLabel: options?.actionLabel,
      action: options?.action,
    };
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    set({ notice });
    const timeout = options?.timeout ?? 4500;
    if (timeout > 0) {
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        // a newer notice must not be removed by an older timer
        if (get().notice?.id === notice.id) set({ notice: null });
      }, timeout);
    }
  },

  dismissNotice: () => {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    set({ notice: null });
  },
}));

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Document body typography is driven by two CSS variables on <html>. */
export function applyFontSize(px: number) {
  const root = document.documentElement;
  root.style.setProperty("--doc-font-size", `${px}px`);
  root.style.setProperty("--doc-title-size", `${Math.round(px * 2)}px`);
}

/**
 * Writes the whole stack, so switching fonts never leaves a stale tail.
 *
 * Two variables come out of one choice: `--font-doc` is read by the editor and
 * the document title, `--font-ui` is the shell's face (`--font-sans` resolves
 * to it), so the sidebar, search, menus and dialogs switch together with the
 * paper instead of keeping the system font.
 */
export function applyDocFont(font: DocFontId) {
  const stack = DOC_FONT_STACKS[font];
  const { style } = document.documentElement;
  style.setProperty("--font-doc", stack);
  style.setProperty("--font-ui", stack);
}

export function applyTheme(mode: ThemeMode, palette: PaletteId = "paper") {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  // `data-palette` is always written, including "paper": a stale attribute from
  // a hot reload must never outlive the choice it came from
  root.dataset.palette = palette;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}