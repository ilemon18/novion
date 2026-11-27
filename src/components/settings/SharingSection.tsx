import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, ChevronRight, Laptop, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRemote } from "@/store/remote";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { SharingError, SharingStatusPill } from "./sharing/parts";
import { SharingHostPage } from "./sharing/SharingHostPage";
import { SharingClientPage } from "./sharing/SharingClientPage";
import { sharingModeState } from "./sharing/mode";

type SharingView = "choose" | "host" | "client";

function SharingModeRow({
  icon: Icon,
  title,
  status,
  blocked,
  reason,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  status?: string;
  blocked: boolean;
  reason: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={blocked}
      onClick={onClick}
      className={cn(
        "relative flex w-full items-center gap-3 border-b border-border/60 px-3 py-3 text-left outline-none transition-colors last:border-b-0 focus-visible:ring-2 focus-visible:ring-ring/40",
        status ? "bg-brand-soft" : "hover:bg-accent/60",
        blocked && "cursor-not-allowed bg-muted/30 opacity-60 hover:bg-muted/30",
      )}
    >
      {status ? (
        <span className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-brand" />
      ) : null}
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          status ? "bg-card text-brand" : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-4.5" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{title}</span>
        {blocked ? (
          <span className="mt-0.5 block text-[10.5px] text-muted-foreground">{reason}</span>
        ) : null}
      </span>
      {status ? <SharingStatusPill>{status}</SharingStatusPill> : null}
      {blocked ? null : <ChevronRight className="size-4.5 shrink-0 text-muted-foreground" />}
    </button>
  );
}

export function SharingSection() {
  const t = useT();
  const status = useRemote((s) => s.status);
  const share = useRemote((s) => s.share);
  const busy = useRemote((s) => s.busy);
  const error = useRemote((s) => s.error);
  const loadShare = useRemote((s) => s.loadShare);
  const stopShare = useRemote((s) => s.stopShare);
  const clearError = useRemote((s) => s.clearError);

  const [view, setView] = useState<SharingView>("choose");

  useEffect(() => {
    void loadShare();
  }, [loadShare]);

  useEffect(() => {
    if (!share?.running) return;
    const timer = window.setInterval(() => void loadShare(), 5_000);
    return () => window.clearInterval(timer);
  }, [share?.running, loadShare]);

  const go = (next: SharingView) => {
    clearError();
    setView(next);
  };

  const sharing = !!share?.running;
  const connected = !!status?.connected;
  const { hostBlocked, clientBlocked, conflict } = sharingModeState(sharing, connected);

  useEffect(() => {
    if ((view === "host" && hostBlocked) || (view === "client" && clientBlocked)) {
      clearError();
      setView("choose");
    }
  }, [clearError, clientBlocked, hostBlocked, view]);

  if (view === "host") {
    return (
      <div className="max-w-[560px]">
        <SharingHostPage onBack={() => go("choose")} />
        <SharingError message={error} />
      </div>
    );
  }

  if (view === "client") {
    return (
      <div className="max-w-[560px]">
        <SharingClientPage onBack={() => go("choose")} />
        <SharingError message={error} />
      </div>
    );
  }

  return (
    <div className="max-w-[560px] space-y-3">
      {conflict && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{t("Can't share and connect at the same time.")}</span>
          <Button
            size="sm"
            variant="outline"
            className="border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
            disabled={busy}
            onClick={() => void stopShare()}
          >
            {t("Stop sharing")}
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <SharingModeRow
          icon={Share2}
          title={t("Share this computer")}
          status={sharing ? t("Sharing now") : undefined}
          blocked={hostBlocked}
          reason={t("Disconnect first")}
          onClick={() => go("host")}
        />
        <SharingModeRow
          icon={Laptop}
          title={t("Connect to another computer")}
          status={connected ? t("Connected") : undefined}
          blocked={clientBlocked}
          reason={t("Stop sharing first")}
          onClick={() => go("client")}
        />
      </div>

      <SharingError message={error} />
    </div>
  );
}
