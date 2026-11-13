import { Ban, Baseline, Highlighter } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { Panel, ToolButton, type PanelControlProps } from "./parts";

/**
 * Text and highlight colours.
 *
 * The palette is fixed on purpose: a free colour picker made two documents
 * written months apart look unrelated, and every hue here still reads on both
 * the light and the dark paper.
 */
export const TEXT_COLORS: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Red", value: "#c25a5a" },
  { label: "Orange", value: "#c97b3c" },
  { label: "Yellow", value: "#b8912f" },
  { label: "Green", value: "#3f8f68" },
  { label: "Blue", value: "#4a6fa5" },
  { label: "Purple", value: "#7a56a8" },
  { label: "Gray", value: "#767670" },
];

export const HIGHLIGHT_COLORS: { label: string; value: string | null }[] = [
  { label: "Yellow", value: "#f9e79a" },
  { label: "Green", value: "#bde5c8" },
  { label: "Blue", value: "#c3dcf6" },
  { label: "Pink", value: "#f8c9c9" },
  { label: "Purple", value: "#e3d0f7" },
  { label: "Orange", value: "#f8dcc0" },
  { label: "Clear", value: null },
];

export function TextColorControl({ editor, open, onToggle, onClose }: PanelControlProps) {
  const t = useT();
  return (
    <div className="relative">
      <ToolButton title={t("Text color")} active={editor.isActive("textStyle")} onClick={onToggle}>
        <Baseline className="size-3.5" />
      </ToolButton>
      {open && (
        <Panel width={168}>
          <Swatches
            label="Text color"
            colors={TEXT_COLORS}
            current={(editor.getAttributes("textStyle").color as string) ?? null}
            onPick={(value) => {
              // close first: the transaction below re-renders the bar once,
              // instead of once for the command and once for the panel
              onClose();
              if (value) editor.chain().focus().setColor(value).run();
              else editor.chain().focus().unsetColor().run();
            }}
          />
        </Panel>
      )}
    </div>
  );
}

export function HighlightControl({ editor, open, onToggle, onClose }: PanelControlProps) {
  const t = useT();
  return (
    <div className="relative">
      <ToolButton title={t("Highlight")} active={editor.isActive("highlight")} onClick={onToggle}>
        <Highlighter className="size-3.5" />
      </ToolButton>
      {open && (
        <Panel width={168}>
          <Swatches
            label="Highlight"
            shape="square"
            colors={HIGHLIGHT_COLORS}
            current={(editor.getAttributes("highlight").color as string | undefined) ?? null}
            onPick={(value) => {
              onClose();
              if (value) editor.chain().focus().setHighlight({ color: value }).run();
              else editor.chain().focus().unsetHighlight().run();
            }}
          />
        </Panel>
      )}
    </div>
  );
}

function Swatches({
  label,
  colors,
  current,
  onPick,
  shape = "circle",
}: {
  label: string;
  colors: { label: string; value: string | null }[];
  current: string | null;
  onPick: (value: string | null) => void;
  shape?: "circle" | "square";
}) {
  const t = useT();
  return (
    <div className="p-1.5">
      <div className="px-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
        {t(label)}
      </div>
      <div className="grid grid-cols-4 justify-items-center gap-2">
        {colors.map((color) => {
          const active = (color.value ?? null) === (current ?? null);
          const none = color.value == null;
          return (
            <button
              key={color.label}
              type="button"
              title={t(color.label)}
              aria-label={t(color.label)}
              aria-pressed={active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(color.value)}
              className={cn(
                // a flat 28px block of colour read as a paint chip; the ring
                // and the hairline border give the swatch a defined edge on
                // both the light and the dark panel
                "flex size-7 items-center justify-center border transition-[box-shadow,border-color] duration-75",
                shape === "circle" ? "rounded-full" : "rounded-[7px]",
                none
                  ? "border-border bg-background text-muted-foreground hover:border-foreground/30"
                  : "border-black/10 hover:border-black/20 dark:border-white/20 dark:hover:border-white/35",
                active && "ring-2 ring-brand ring-offset-1 ring-offset-popover",
              )}
              style={color.value ? { background: color.value } : undefined}
            >
              {none && <Ban className="size-3.5" strokeWidth={1.6} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
