import { useState } from "react";
import { Check, Laptop, Loader2, Radio, Unplug, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type RemoteHost } from "@/lib/tauri";
import { useRemote } from "@/store/remote";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { SHARE_PORT_MAX, SHARE_PORT_MIN } from "./constants";
import { SharingPageHeader } from "./parts";

export function SharingClientPage({ onBack }: { onBack: () => void }) {
  const t = useT();
  const status = useRemote((s) => s.status);
  const hosts = useRemote((s) => s.hosts);
  const scanning = useRemote((s) => s.scanning);
  const busy = useRemote((s) => s.busy);
  const scan = useRemote((s) => s.scan);
  const connect = useRemote((s) => s.connect);
  const connectManual = useRemote((s) => s.connectManual);
  const reconnectSaved = useRemote((s) => s.reconnectSaved);
  const disconnect = useRemote((s) => s.disconnect);
  const forget = useRemote((s) => s.forget);

  const [pairingCode, setPairingCode] = useState("");
  const [selected, setSelected] = useState<RemoteHost | null>(null);
  const [manualHost, setManualHost] = useState("");
  const [manualPort, setManualPort] = useState(39262);
  const [manualCode, setManualCode] = useState("");
  const [showManual, setShowManual] = useState(false);

  const connected = !!status?.connected;

  const selectHost = (host: RemoteHost) => {
    setSelected(host);
    setPairingCode("");
    setManualHost(host.address);
    setManualPort(host.port);
  };

  const connectSelected = async () => {
    if (!selected) return;
    const ok = await connect(selected, pairingCode);
    if (ok) setPairingCode("");
  };

  const connectManualAddress = async () => {
    if (!Number.isInteger(manualPort) || manualPort < SHARE_PORT_MIN || manualPort > SHARE_PORT_MAX) {
      useRemote.setState({ error: t("Port must be between 1024 and 65535.") });
      return;
    }
    const ok = await connectManual(manualHost.trim(), manualPort, manualCode);
    if (ok) setManualCode("");
  };

  return (
    <div className="max-w-[560px]">
      <SharingPageHeader
        icon={Radio}
        title={t("Connect to another computer")}
        status={connected ? t("Connected") : undefined}
        onBack={onBack}
      />

      {connected ? (
        <div className="mt-4 rounded-lg border border-brand/40 bg-brand-soft/60 p-3">
          <div className="flex items-center gap-2">
            <Check className="size-4.5 shrink-0 text-brand" />
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
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect()}>
              <Unplug className="size-4" />
              {t("Disconnect")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void forget()}>
              {t("Forget")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
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
              {t("Local network")}
            </div>
            <Button size="sm" variant="outline" disabled={scanning || busy} onClick={() => void scan()}>
              {scanning ? <Loader2 className="size-4 animate-spin" /> : <Wifi className="size-4" />}
              {t("Scan")}
            </Button>
          </div>

          {hosts.length ? (
            <div className="overflow-hidden rounded-md border border-border">
              {hosts.map((host) => (
                <button
                  key={host.hostId}
                  type="button"
                  onClick={() => selectHost(host)}
                  className={cn(
                    "flex w-full items-center gap-2 border-b border-border/60 px-2.5 py-2 text-left last:border-b-0 hover:bg-accent/50",
                    selected?.hostId === host.hostId && "bg-brand-soft/60",
                  )}
                >
                  <Laptop className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11.5px]">{host.hostName}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {host.address}:{host.port} · {host.workspaceName}
                    </div>
                  </div>
                  {selected?.hostId === host.hostId && <Check className="size-4 text-brand" />}
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
                {t("Pairing code")}
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
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t("Connect")}
                </Button>
              </div>
            </div>
          )}

          <button
            type="button"
            aria-expanded={showManual}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setShowManual((value) => !value)}
          >
            {t("Manual connection")}
          </button>

          {showManual && (
            <div className="rounded-md border border-border p-2.5">
              <div className="grid grid-cols-[1fr_96px] gap-2">
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
                    min={SHARE_PORT_MIN}
                    max={SHARE_PORT_MAX}
                    value={manualPort}
                    onChange={(event) => setManualPort(Number(event.target.value))}
                    className="mt-1.5 tabular-nums"
                  />
                </div>
              </div>
              <label htmlFor="manual-code" className="mt-2 block text-[11px] font-medium text-muted-foreground">
                {t("Pairing code")}
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}
