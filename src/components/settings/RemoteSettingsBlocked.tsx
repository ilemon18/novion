import { Wifi } from "lucide-react";
import { useRemote } from "@/store/remote";
import { useT } from "@/i18n";

export function RemoteSettingsBlocked() {
  const t = useT();
  const connected = useRemote((s) => !!s.status?.connected);
  if (!connected) return null;
  return (
    <div className="flex max-w-[520px] items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
      <Wifi className="mt-0.5 size-3.5 shrink-0 text-brand" />
      <span>{t("These settings apply to the local workspace. Disconnect from the remote host first.")}</span>
    </div>
  );
}

export function useRemoteSettingsBlocked(): boolean {
  return useRemote((s) => !!s.status?.connected);
}
