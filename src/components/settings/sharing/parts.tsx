import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";

export function SharingStatusPill({ children }: { children: ReactNode }) {
  return (
    <span
      className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-1 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-300"
      role="status"
    >
      {children}
    </span>
  );
}

export function SharingPageHeader({
  icon: Icon,
  title,
  status,
  onBack,
}: {
  icon: LucideIcon;
  title: string;
  status?: string;
  onBack: () => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <Button size="iconSm" variant="ghost" aria-label={t("Back")} onClick={onBack}>
        <ChevronLeft className="size-4.5" />
      </Button>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
        <Icon className="size-4" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</div>
      {status ? <SharingStatusPill>{status}</SharingStatusPill> : null}
    </div>
  );
}

export function SharingError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-4 flex items-start gap-1.5 rounded-md border border-destructive/35 px-2 py-1.5 text-[11.5px] leading-relaxed text-destructive">
      <AlertTriangle className="mt-[1px] size-4 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}
