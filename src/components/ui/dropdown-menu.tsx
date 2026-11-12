import * as React from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import {
  MENU_CONTENT_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_DESTRUCTIVE_CLASS,
  MENU_LABEL_CLASS,
  MENU_SEPARATOR_CLASS,
} from "./menu-styles";

/**
 * Radix menus default to `modal` (focus trap + scroll lock + `aria-hidden` on
 * the rest of the document). These row menus need none of that, and the modal
 * bookkeeping is what makes them stutter open, so the default is off.
 */
export function DropdownMenu({
  modal = false,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Root>) {
  return <DropdownPrimitive.Root modal={modal} {...props} />;
}

export const DropdownMenuTrigger = DropdownPrimitive.Trigger;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(({ className, sideOffset = 4, align = "end", ...props }, ref) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn("anim-menu", MENU_CONTENT_CLASS, className)}
      {...props}
    />
  </DropdownPrimitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <DropdownPrimitive.Item
    ref={ref}
    className={cn(
      MENU_ITEM_CLASS,
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
      destructive && MENU_ITEM_DESTRUCTIVE_CLASS,
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <DropdownPrimitive.Separator className={cn(MENU_SEPARATOR_CLASS, className)} />;
}

export function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(MENU_LABEL_CLASS, className)} {...props} />;
}