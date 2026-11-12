import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Square icon button for the document header.
 *
 * 28×28 with a 16px glyph: small enough to stay out of the way, large enough to
 * hit without aiming. Call sites wrap it in `<Tooltip>` themselves, because a
 * tooltip that is nested around a dropdown trigger has to be controlled (see
 * `DocMenu`) and hiding that inside this component would be worse.
 */
export function docActionClass(active?: boolean) {
  return cn(
    "flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors duration-100",
    "focus-visible:ring-2 focus-visible:ring-ring/40",
    active
      ? "bg-accent text-brand"
      : "text-muted-foreground/60 hover:bg-accent hover:text-brand",
  );
}

export const DocActionButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { active?: boolean }
>(function DocActionButton({ active, className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(docActionClass(active), className)}
      {...props}
    />
  );
});
