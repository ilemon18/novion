import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Copy,
  KeyRound,
  Laptop,
  Loader2,
  Play,
  RefreshCw,
  Share2,
  ShieldCheck,
  Square,
  Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRemote } from "@/store/remote";
import { useUi } from "@/store/ui";
import { formatDateTime, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { SHARE_PORT_MAX, SHARE_PORT_MIN } from "./constants";
import { SharingPageHeader } from "./parts";

export function SharingHostPage({ onBack }: { onBack: () => void }) {
  const t = useT();
  const notify = useUi((s) => s.notify);
  const share = useRemote((s) => s.share);
  const busy = useRemote((s) => s.busy);
  const startShare = useRemote((s) => s.startShare);
  const stopShare = useRemote((s) => s.stopShare);
  const saveShareConfig = useRemote((s) => s.saveShareConfig);
  const newPairingCode = useRemote((s) => s.newPairingCode);
  const revokeDevice = useRemote((s) => s.revokeDevice);

  const [port, setPort] = useState(39262);
  const [deviceName, setDeviceName] = useState("");

  useEffect(() => {
    if (!share) return;
    setPort(share.port);
    setDeviceName(share.deviceName);
  }, [share?.port, share?.deviceName]);

  const running = !!share?.running;
  const nameChanged = deviceName.trim() !== share?.deviceName;
  const portChanged = port !== share?.port;
  const canSave =
    !busy &&
    !running &&
    (nameChanged || portChanged) &&
    deviceName.trim().length > 0;

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(t("Copied"));
    } catch {
      /* clipboard is best effort */
    }
  };

  const save = async () => {
    if (!Number.isInteger(port) || port < SHARE_PORT_MIN || port > SHARE_PORT_MAX) {
      useRemote.setState({ error: t("Port must be between 1024 and 65535.") });
      return;
    }
    if (!deviceName.trim()) return;
    await saveShareConfig(deviceName.trim(), port);
  };

  return (
    <div className="max-w-[560px]">
      <SharingPageHeader
        icon={Share2}
        title={t("Share this computer")}
        status={running ? t("Sharing now") : undefined}
        onBack={onBack}
      />

      <div
        className={cn(
          "mt-4 grid items-end gap-2",
          running ? "grid-cols-[1fr_96px]" : "grid-cols-[1fr_96px_auto]",
        )}
      >
        <div>
          <label htmlFor="share-name" className="text-[11px] font-medium text-muted-foreground">
            {t("Name")}
          </label>
          <Input
            id="share-name"
            value={deviceName}
            disabled={busy || running}
            onChange={(event) => setDeviceName(event.target.value)}
            className="mt-1.5"
          />
        </div>
        <div>
          <label htmlFor="share-port" className="text-[11px] font-medium text-muted-foreground">
            {t("Port")}
          </label>
          <Input
            id="share-port"
            type="number"
            min={SHARE_PORT_MIN}
            max={SHARE_PORT_MAX}
            value={port}
            disabled={busy || running}
            onChange={(event) => setPort(Number(event.target.value))}
            className="mt-1.5 tabular-nums"
          />
        </div>
        {!running && (
          <Button size="sm" variant="outline" disabled={!canSave} onClick={() => void save()}>
            {t("Save")}
          </Button>
        )}
      </div>

      {running && (
        <div className="mt-4 space-y-3 border-t border-border/70 pt-3">
          <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <Wifi className="size-4 shrink-0 text-brand" />
            <span className="min-w-0 break-all font-mono text-[11px] text-foreground/80">
              {(share?.addresses ?? []).map((ip) => `https://${ip}:${share?.port}`).join("  ·  ")}
            </span>
          </div>

          <div className="rounded-md bg-muted/55 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <KeyRound className="size-4" />
                {t("Pairing code")}
              </div>
              <div className="flex gap-1">
                <Button
                  size="iconSm"
                  variant="ghost"
                  aria-label={t("Copy pairing code")}
                  disabled={!share?.pairingCode}
                  onClick={() => share?.pairingCode && void copy(share.pairingCode)}
                >
                  <Copy className="size-4" />
                </Button>
                <Button
                  size="iconSm"
                  variant="ghost"
                  aria-label={t("New pairing code")}
                  onClick={() => void newPairingCode()}
                >
                  <RefreshCw className="size-4" />
                </Button>
              </div>
            </div>
            <div className="mt-1 font-mono text-[18px] tracking-[0.14em] text-foreground">
              {share?.pairingCode ?? "—"}
            </div>
            {share?.pairingExpiresAt ? (
              <div className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                {t("Valid until {time}", {
                  time: formatDateTime(share.pairingExpiresAt, useUi.getState().locale),
                })}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" />
            <span>{t("Certificate fingerprint")}</span>
            <span className="selectable truncate font-mono">{share?.fingerprint}</span>
          </div>

          {share?.discoveryError && (
            <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-[1px] size-4 shrink-0" />
              <span>{t("Automatic discovery is unavailable. Use the manual address instead.")}</span>
            </div>
          )}

          {share?.paired.length ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                {t("Paired computers")}
              </div>
              <div className="overflow-hidden rounded-md border border-border">
                {share.paired.map((device) => (
                  <div
                    key={device.id}
                    className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2 last:border-b-0"
                  >
                    <Laptop className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11.5px]">{device.name}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {device.permission === "readonly" ? t("Read only") : t("Can edit")} ·{" "}
                        {t("Last seen {time}", {
                          time: formatDateTime(device.lastSeenAt, useUi.getState().locale),
                        })}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => void revokeDevice(device.id)}
                    >
                      {t("Revoke")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        {running ? (
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void stopShare()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
            {t("Stop sharing")}
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void startShare()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {t("Start sharing")}
          </Button>
        )}
      </div>
    </div>
  );
}
