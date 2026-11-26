import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, Eye, EyeOff, Loader2, Play, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage, type McpStatus } from "@/lib/tauri";
import { useT } from "@/i18n";
import { RemoteSettingsBlocked, useRemoteSettingsBlocked } from "./RemoteSettingsBlocked";
import { useUi } from "@/store/ui";

const PORT_MIN = 1024;
const PORT_MAX = 65535;

export function McpSection() {
  const t = useT();
  const remoteBlocked = useRemoteSettingsBlocked();
  const notify = useUi((s) => s.notify);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [port, setPort] = useState(39261);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.mcpGetStatus();
      setStatus(next);
      setPort(next.port);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<McpStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setStatus(next);
      setPort(next.port);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const savePort = () => {
    if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
      setError(t("Port must be between 1024 and 65535."));
      return;
    }
    void run(() => api.mcpSetPort(port));
  };

  const copyConnection = async () => {
    if (!status) return;
    try {
      await navigator.clipboard.writeText(
        status.requireToken
          ? `${status.endpoint}\nAuthorization: Bearer ${status.token}`
          : status.endpoint,
      );
      notify(t("Copied"));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (remoteBlocked) return <RemoteSettingsBlocked />;

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {t("Loading MCP settings…")}
      </div>
    );
  }

  return (
    <div className="max-w-[520px]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium">{t("Local MCP server")}</div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
            {t("Server starts only when you press Start.")}
          </div>
        </div>
        <div
          className={`shrink-0 rounded-full px-2 py-1 text-[10.5px] font-medium ${
            status?.running
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "bg-muted text-muted-foreground"
          }`}
          role="status"
        >
          {t(status?.running ? "MCP server is running" : "MCP server is stopped")}
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-border p-3">
        <label htmlFor="mcp-port" className="text-[11px] font-medium text-muted-foreground">
          {t("Port")}
        </label>
        <div className="mt-1.5 flex gap-2">
          <Input
            id="mcp-port"
            type="number"
            min={PORT_MIN}
            max={PORT_MAX}
            step={1}
            value={port}
            disabled={busy || status?.running}
            onChange={(event) => setPort(Number(event.target.value))}
            className="max-w-[150px] tabular-nums"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || status?.running || port === status?.port}
            onClick={savePort}
          >
            {t("Save port")}
          </Button>
        </div>

        <div className="mt-3 text-[11px] font-medium text-muted-foreground">{t("Endpoint")}</div>
        <div className="selectable mt-1 break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] text-foreground/80">
          {status?.endpoint ?? `http://127.0.0.1:${port}/mcp`}
        </div>

        <div className="mt-4 flex items-start justify-between gap-3 border-t border-border/70 pt-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-muted-foreground">
              {t("Require access token")}
            </div>
            <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {status?.requireToken
                ? t("Use this endpoint with the bearer token in an MCP client.")
                : t("Optional. Enable this when other apps on this computer should not access your notes.")}
            </div>
          </div>
          <div className={busy || !status ? "pointer-events-none opacity-60" : undefined}>
            <Switch
              checked={status?.requireToken ?? false}
              onChange={(required) => void run(() => api.mcpSetRequireToken(required))}
              label={t("Require access token")}
            />
          </div>
        </div>

        {status && !status.requireToken ? (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-[1px] size-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              {t("Token authentication is off. While the server is running, any app on this computer can access notes through it.")}
            </span>
          </div>
        ) : null}

        {status?.requireToken ? (
          <div className="mt-3">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="mcp-token" className="text-[11px] font-medium text-muted-foreground">
                {t("Access token")}
              </label>
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setShowToken((value) => !value)}
                aria-label={t(showToken ? "Hide token" : "Show token")}
              >
                {showToken ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                {t(showToken ? "Hide token" : "Show token")}
              </button>
            </div>
            <Input
              id="mcp-token"
              value={status.token}
              type={showToken ? "text" : "password"}
              readOnly
              className="mt-1.5 font-mono text-[11px]"
            />
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          {status?.requireToken ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || status.running}
              onClick={() => void run(api.mcpRotateToken)}
            >
              <RotateCcw className="size-3.5" />
              {t("Rotate token")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={!status} onClick={() => void copyConnection()}>
            <Copy className="size-3.5" />
            {t("Copy connection details")}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        {status?.running ? (
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(api.mcpStop)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
            {t("Stop server")}
          </Button>
        ) : (
          <Button size="sm" disabled={busy || !status} onClick={() => void run(api.mcpStart)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            {t("Start server")}
          </Button>
        )}
      </div>

      {error ? (
        <div className="mt-3 flex items-start gap-1.5 rounded-md border border-destructive/35 px-2 py-1.5 text-[11.5px] leading-relaxed text-destructive">
          <AlertTriangle className="mt-[1px] size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}
    </div>
  );
}
