import type { ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { cn } from "@/lib/utils";

/**
 * Shared pieces of the floating bar.
 *
 * Every control in the bar is built from these, so the 28px hit area, the
 * hairline separators and the in-bubble dropdown all stay identical without
 * copying class strings around.
 */

interface ToolButtonProps {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}

export function ToolButton({ active, disabled, title, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-75",
        "hover:bg-accent hover:text-foreground",
        active && "bg-brand-soft text-brand",
        disabled && "pointer-events-none opacity-35",
      )}
    >
      {children}
    </button>
  );
}

export function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-border" />;
}

/**
 * A menu that lives *inside* the bubble.
 *
 * Radix's dropdown portals render at `document.body`, which makes the editor
 * blur and the bubble menu hide itself while the menu is still open. Keeping
 * the panel in the bubble's own DOM keeps focus inside the popper, which is
 * exactly the case the bubble-menu plugin treats as "still editing".
 */
export function Panel({
  children,
  align = "start",
  width = 176,
}: {
  children: ReactNode;
  align?: "start" | "end";
  width?: number;
}) {
  return (
    <div
      className="absolute top-[calc(100%+6px)] z-50 rounded-lg border border-border bg-popover p-1 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35)]"
      style={align === "start" ? { left: 0, width } : { right: 0, width }}
    >
      {children}
    </div>
  );
}

export function PanelItem({
  onClick,
  disabled,
  destructive,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-foreground transition-colors",
        "hover:bg-accent disabled:pointer-events-none disabled:opacity-40",
        destructive && "text-destructive hover:bg-destructive/10",
      )}
    >
      {children}
    </button>
  );
}

export function PanelLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1 text-[10.5px] font-medium text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * Props shared by every dropdown control in the bar.
 *
 * The bar keeps a single `panel` state instead of one per control: opening the
 * colour swatches has to close the block menu, otherwise two panels would be
 * drawn at once.
 */
export interface PanelControlProps {
  editor: Editor;
  /** true when *this* control's panel is the one currently drawn */
  open: boolean;
  /** opens this panel, or closes it when it is already open */
  onToggle: () => void;
  /** closes whichever panel is open */
  onClose: () => void;
}
