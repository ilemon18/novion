import { cn } from "@/lib/utils";

export function Separator({
  className,
  vertical,
}: {
  className?: string;
  vertical?: boolean;
}) {
  return (
    <div
      role="separator"
      className={cn("bg-border", vertical ? "mx-1 h-4 w-px" : "my-1 h-px w-full", className)}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}