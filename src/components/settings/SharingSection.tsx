import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Laptop,
  Loader2,
  Play,
  Radio,
  RefreshCw,
  Share2,
  ShieldCheck,
  Square,
  Unplug,
  Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type RemoteHost } from "@/lib/tauri";
import { useRemote } from "@/store/remote";
import { useUi } from "@/store/ui";
import { formatDateTime, useT } from "@/i18n";
import { cn } from "@/lib/utils";

const PORT_MIN = 1024;
const PORT_MAX = 65535;

export function SharingSection() {
  const t = useT();
  const notify = useUi((s) => s.notify);
  const status = useRemote((s) => s.status);
  const share = useRemote((s) => s.share);
  const hosts = useRemote((s) => s.hosts);
  const scanning = useRemote((s) => s.scanning);
  const busy = useRemote((s) => s.busy);
  const error = useRemote((s) => s.error);
  const loadShare = useRemote((s) => s.loadShare);
  const scan = useRemote((s) => s.scan);
  const connect = useRemote((s) => s.connect);
  const connectManual = useRemote((s) => s.connectManual);
  const reconnectSaved = useRemote((s) => s.reconnectSaved);
  const disconnect = useRemote((s) => s.disconnect);
  const forget = useRemote((s) => s.forget);
  const startShare = useRemote((s) => s.startShare);
  const stopShare = useRemote((s) => s.stopShare);
  const setSharePort = useRemote((s) => s.setSharePort);
  const setShareName = useRemote((s) => s.setShareName);
  const newPairingCode = useRemote((s) => s.newPairingCode);
  const revokeDevice = useRemote((s) => s.revokeDevice);

  const [port, setPort] = useState(39262);
  const [deviceName, setDeviceName] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [selected, setSelected] = useState<RemoteHost | null>(null);
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState(39262);
  const [manualCode, setManualCode] = useState("");
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    void loadShare();
  }, [loadShare]);

  useEffect(() => {
    if (!share) return;
    setPort(share.port);
    setDeviceName(share.deviceName);
  }, [share?.port, share?.deviceName]);

  useEffect(() => {
    if (!share?.running) return;
    const timer = window.setInterval(() => void loadShare(), 5_000);
    return () => window.clearInterval(timer);
  }, [share?.running, loadShare]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(t("Copied"));
    } catch {
      /* clipboard is best effort */
    }
  };

  const connectSelected = async () => {
    if (!selected) return;
    const ok = await connect(selected, pairingCode);
    if (ok) setPairingCode("");
  };

  const connectManualAddress = async () => {
    if (!Number.isInteger(manualPort) || manualPort < PORT_MIN || manualPort > PORT_MAX) {
      useRemote.setState({ error: t("Port must be between 1024 and 65535.") });
      return;
    }
    const ok = await connectManual(manualHost.trim(), manualPort, manualCode);
    if (ok) setManualCode("");
  };

  const running = !!share?.running;
  const connected = !!status?.connected;

  return (
    <div className="max-w-[560px] space-y-5">
      {/* host --------------------------------------------------------- */}
      <section className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
              <Share2 className="size-4" strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t("Share this workspace")}</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                {t("Let another computer on this network open and edit this Novion workspace.")}
              </div>
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-1 text-[10.5px] font-medium",
              running
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "bg-muted text-muted-foreground",
            )}
            role="status"
          >
            {t(running ? "Sharing" : "Not sharing")}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-[1fr_120px] gap-2">
          <div>
            <label htmlFor="share-name" className="text-[11px] font-medium text-muted-foreground">
              {t("This computer’s name")}
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
              min={PORT_MIN}
              max={PORT_MAX}
              value={port}
              disabled={busy || running}
              onChange={(event) => setPort(Number(event.target.value))}
              className="mt-1.5 tabular-nums"
            />
          </div>
        </div>
        {!running && (
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || deviceName.trim() === share?.deviceName}
              onClick={() => void setShareName(deviceName.trim())}
            >
              {t("Save name")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || port === share?.port}
              onClick={() => void setSharePort(port)}
            >
              {t("Save port")}
            </Button>
          </div>
        )}

        {running && (
          <div className="mt-3 space-y-3 border-t border-border/70 pt-3">
            <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <Wifi className="size-3.5 text-brand" />
              <span className="min-w-0 break-all font-mono text-[11px] text-foreground/80">
                {(share?.addresses ?? []).map((ip) => `https://${ip}:${share?.port}`).join("  ·  ")}
              </span>
            </div>

            <div className="rounded-md bg-muted/55 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <KeyRound className="size-3.5" />
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
                    <Copy className="size-3.5" />
                  </Button>
                  <Button
                    size="iconSm"
                    variant="ghost"
                    aria-label={t("New pairing code")}
                    onClick={() => void newPairingCode()}
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-1 font-mono text-[18px] tracking-[0.14em] text-foreground">
                {share?.pairingCode ?? "—"}
              </div>
              <div className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                {share?.pairingExpiresAt
                  ? t("Valid until {time}", {
                      time: formatDateTime(share.pairingExpiresAt, useUi.getState().locale),
                    })
                  : t("Create a code when the other computer is ready to connect.")}
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
              <ShieldCheck className="size-3.5" />
              <span>{t("Certificate fingerprint")}</span>
              <span className="selectable truncate font-mono">{share?.fingerprint}</span>
            </div>

            {share?.discoveryError && (
              <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-[1px] size-3.5 shrink-0" />
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
                      <Laptop className="size-3.5 shrink-0 text-muted-foreground" />
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

        <div className="mt-3 flex gap-2">
          {running ? (
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void stopShare()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
              {t("Stop sharing")}
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => void startShare()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {t("Start sharing")}
            </Button>
          )}
        </div>
      </section>

      {/* client ------------------------------------------------------- */}
      <section className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand">
              <Radio className="size-4" strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t("Connect to another computer")}</div>
              <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                {t("Work directly in a Novion workspace hosted on another computer.")}
              </div>
            </div>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-1 text-[10.5px] font-medium",
              connected
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "bg-muted text-muted-foreground",
            )}
            role="status"
          >
            {t(connected ? "Connected" : "Local workspace")}
          </span>
        </div>

        {connected ? (
          <div className="mt-3 rounded-md border border-brand/40 bg-brand-soft/60 p-3">
            <div className="flex items-center gap-2">
              <Check className="size-4 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium">{status?.hostName}</div>
                <div className="truncate text-[10.5px] text-muted-foreground">
                  {status?.workspaceName}
                  {status?.latencyMs != null ? ` · ${status.latencyMs} ms` : ""}
                </div>
              </div>
            </div>
            <div className="mt-2 break-all font-mono text-[10.5px] text-muted-foreground">
              {status?.rootPath}
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect()}>
                <Unplug className="size-3.5" />
                {t("Disconnect")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void forget()}>
                {t("Forget this computer")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {status?.saved && (
              <div className="flex items-center gap-2 rounded-md bg-muted/55 px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] font-medium">{status.saved.hostName}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {status.saved.host}:{status.saved.port}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void reconnectSaved()}
                >
                  {t("Reconnect")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void forget()}>
                  {t("Forget")}
                </Button>
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-medium text-muted-foreground">
                {t("Computers on this network")}
              </div>
              <Button size="sm" variant="outline" disabled={scanning || busy} onClick={() => void scan()}>
                {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <Wifi className="size-3.5" />}
                {t("Scan")}
              </Button>
            </div>

            {hosts.length ? (
              <div className="overflow-hidden rounded-md border border-border">
                {hosts.map((host) => (
                  <button
                    key={host.hostId}
                    type="button"
                    onClick={() => {
                      setSelected(host);
                      setManualHost(host.address);
                      setManualPort(host.port);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 border-b border-border/60 px-2.5 py-2 text-left last:border-b-0 hover:bg-accent/50",
                      selected?.hostId === host.hostId && "bg-brand-soft/60",
                    )}
                  >
                    <Laptop className="size-3.5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11.5px]">{host.hostName}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {host.address}:{host.port} · {host.workspaceName}
                      </div>
                    </div>
                    {selected?.hostId === host.hostId && <Check className="size-3.5 text-brand" />}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
                {t("No sharing host found yet.")}
              </div>
            )}

            {selected && (
              <div className="rounded-md border border-border p-2.5">
                <label htmlFor="pair-code" className="text-[11px] font-medium text-muted-foreground">
                  {t("Pairing code shown on the host")}
                </label>
                <div className="mt-1.5 flex gap-2">
                  <Input
                    id="pair-code"
                    value={pairingCode}
                    onChange={(event) => setPairingCode(event.target.value.toUpperCase())}
                    placeholder="ABCD-EFGH"
                    className="font-mono tracking-[0.08em]"
                  />
                  <Button size="sm" disabled={busy || !pairingCode.trim()} onClick={() => void connectSelected()}>
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {t("Connect")}
                  </Button>
                </div>
              </div>
            )}

            <button
              type="button"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setShowManual((value) => !value)}
            >
              {t("Connect by address instead")}
            </button>

            {showManual && (
              <div className="rounded-md border border-border p-2.5">
                <div className="grid grid-cols-[1fr_110px] gap-2">
                  <div>
                    <label htmlFor="manual-host" className="text-[11px] font-medium text-muted-foreground">
                      {t("Host address")}
                    </label>
                    <Input
                      id="manual-host"
                      value={manualHost}
                      placeholder="192.168.1.20"
                      onChange={(event) => setManualHost(event.target.value)}
                      className="mt-1.5 font-mono text-[11px]"
                    />
                  </div>
                  <div>
                    <label htmlFor="manual-port" className="text-[11px] font-medium text-muted-foreground">
                      {t("Port")}
                    </label>
                    <Input
                      id="manual-port"
                      type="number"
                      min={PORT_MIN}
                      max={PORT_MAX}
                      value={manualPort}
                      onChange={(event) => setManualPort(Number(event.target.value))}
                      className="mt-1.5 tabular-nums"
                    />
                  </div>
                </div>
                <label htmlFor="manual-code" className="mt-2 block text-[11px] font-medium text-muted-foreground">
                  {t("Pairing code shown on the host")}
                </label>
                <div className="mt-1.5 flex gap-2">
                  <Input
                    id="manual-code"
                    value={manualCode}
                    onChange={(event) => setManualCode(event.target.value.toUpperCase())}
                    placeholder="ABCD-EFGH"
                    className="font-mono tracking-[0.08em]"
                  />
                  <Button
                    size="sm"
                    disabled={busy || !manualHost.trim() || !manualCode.trim()}
                    onClick={() => void connectManualAddress()}
                  >
                    {t("Connect")}
                  </Button>
                </div>
                <div className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
                  {t("The first manual connection trusts the host certificate after pairing.")}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/35 px-2 py-1.5 text-[11.5px] leading-relaxed text-destructive">
          <AlertTriangle className="mt-[1px] size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}
    </div>
  );
}
