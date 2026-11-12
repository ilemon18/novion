import { cn } from "@/lib/utils";

/** Minimal accessible on/off control (no extra dependency). */
export function Switch({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** accessible name; the visible label lives next to the switch */
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        checked ? "bg-brand" : "bg-muted-foreground/30",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] size-[14px] rounded-full bg-white shadow-sm transition-[left]",
          checked ? "left-[14px]" : "left-[2px]",
        )}
      />
    </button>
  );
}