/**
 * Shared skin for every menu surface (right-click menu and row dropdown).
 *
 * Both are drawn by different mechanisms — Radix popover vs. a plain fixed
 * positioned box — so the classes live in one place and only the positioning
 * differs. Changing the menu look therefore never leaves the two variants
 * drifted apart.
 */
export const MENU_CONTENT_CLASS =
  "z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)]";

export const MENU_ITEM_CLASS =
  "flex h-7 w-full cursor-default select-none items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:opacity-70";

export const MENU_ITEM_DESTRUCTIVE_CLASS =
  "text-destructive data-[highlighted]:text-destructive hover:text-destructive focus:text-destructive";

export const MENU_SEPARATOR_CLASS = "my-1 h-px bg-border";

export const MENU_LABEL_CLASS =
  "px-2 py-1 text-[11px] font-medium text-muted-foreground";