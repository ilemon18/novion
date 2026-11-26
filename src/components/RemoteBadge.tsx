import { Wifi } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useRemote } from "@/store/remote";
import { useUi } from "@/store/ui";
import { useT } from "@/i18n";

/**
 * The "Connected to …" entry point for a remote workspace.
 *
 * It is rendered by the shell when no document is open, and by DocView's
 * right-hand status strip when one is. Keeping it in one component means the
 * two placements cannot drift apart.
 */
export function RemoteBadge() {
  const t = useT();
  const status = useRemote((s) => s.status);

  if (!status?.connected) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-no-window-drag
          onClick={() => {
            useUi.getState().setSettingsSection("sharing");
            useUi.getState().setSettingsOpen(true);
          }}
          className={cn(
            "pointer-events-auto flex h-7 max-w-[160px] min-[1000px]:max-w-[240px] items-center gap-1.5 rounded-md border px-2 text-[11px]",
            status.error
              ? "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-brand/30 bg-brand-soft text-brand",
          )}
        >
          <Wifi className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{status.hostName}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {status.error
          ? t("Remote connection needs attention")
          : t("Connected to {name}", { name: status.hostName ?? "" })}
      </TooltipContent>
    </Tooltip>
  );
}
