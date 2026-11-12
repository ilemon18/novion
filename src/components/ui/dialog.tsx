import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** vertical placement of the panel inside the viewport */
  align?: "center" | "top";
}

/**
 * Dialog shell.
 *
 * Centering is done by a flex wrapper, NOT with `-translate-x-1/2 -translate-y-1/2`
 * (Tailwind v4 puts those on the individual `translate` property, which any
 * entrance animation would then overwrite — that is what made panels fly in from
 * the bottom-right corner).
 *
 * The panel has no entrance animation on purpose: it simply appears. Only the
 * dimmer behind it fades, which is cheap and never reads as movement.
 */
export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, align = "center", ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/* no backdrop-blur: re-blurring a full-screen backdrop while the panel
        animates is what made opening dialogs feel sluggish */}
    <DialogPrimitive.Overlay className="anim-fade fixed inset-0 z-50 bg-black/30" />
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex justify-center px-4",
        align === "top" ? "items-start pt-[11vh]" : "items-center py-6",
      )}
    >
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "pointer-events-auto relative w-[min(420px,calc(100vw-32px))] max-h-[calc(100vh-3rem)] overflow-auto rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-[0_16px_48px_-12px_rgba(0,0,0,0.28)] outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </div>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-[15px] font-semibold tracking-[-0.01em]", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("mt-1.5 text-[13px] leading-relaxed text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-5 flex justify-end gap-2", className)} {...props} />;
}
