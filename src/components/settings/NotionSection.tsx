import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  RefreshCw,
  Unplug,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/tauri";
import { useNotion } from "@/store/notion";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";
import { formatDateTime, useT } from "@/i18n";
import { RemoteSettingsBlocked, useRemoteSettingsBlocked } from "./RemoteSettingsBlocked";

export function NotionSection() {
  const t = useT();
  const remoteBlocked = useRemoteSettingsBlocked();
  const info = useNotion((s) => s.info);
  const loading = useNotion((s) => s.loading);
  const connecting = useNotion((s) => s.connecting);
  const settingParent = useNotion((s) => s.settingParent);
  const syncing = useNotion((s) => s.syncing);
  const progress = useNotion((s) => s.progress);
  const error = useNotion((s) => s.error);
  const lastStats = useNotion((s) => s.lastStats);
  const load = useNotion((s) => s.load);
  const connect = useNotion((s) => s.connect);
  const disconnect = useNotion((s) => s.disconnect);
  const setParent = useNotion((s) => s.setParent);
  const sync = useNotion((s) => s.sync);
  const clearError = useNotion((s) => s.clearError);
  const askConfirm = useUi((s) => s.askConfirm);
  const locale = useUi((s) => s.locale);

  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [target, setTarget] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!info && !loading) void load();
  }, [info, loading, load]);

  if (remoteBlocked) return <RemoteSettingsBlocked />;

  if (!info) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {t("Reading Notion settings…")}
      </div>
    );
  }

  const connected = info.connected;
  const hasParent = !!info.parentPageId;
  const busy = connecting || settingParent || syncing;

  const submitToken = async () => {
    setNotice(null);
    const ok = await connect(token);
    if (ok) setToken("");
  };

  const submitParent = async () => {
    setNotice(null);
    const result = await setParent(target);
    if (!result) return;
    setTarget("");
    if (result.reset) {
      setNotice(
        t(
          "Target switched to “{title}”: the page mapping was cleared and the next sync creates pages under the new target.",
          { title: result.title },
        ),
      );
    }
  };

  const startSync = async () => {
    setNotice(null);
    await sync();
  };

  return (
    <div>
      {/* connection -------------------------------------------------- */}
      {connected ? (
        <div className="rounded-lg border border-brand/50 bg-brand-soft px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex size-4 items-center justify-center rounded-full bg-brand text-brand-foreground">
              <Check className="size-2.5" strokeWidth={3} />
            </span>
            <span className="text-[12.5px] font-medium">{t("Notion connected")}</span>
            <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
              ····{info.tokenTail}
            </span>
          </div>
          <div className="mt-1 pl-6 text-[11px] leading-relaxed text-muted-foreground">
            {info.botName || t("Notion integration")}
            {info.workspaceName
              ? ` · ${t("Workspace {name}", { name: info.workspaceName })}`
              : ""}
            {" · "}
            {t("{count} notes synced", { count: info.syncedDocs })}
            {info.syncedFolders
              ? ` / ${t("{count} folders", { count: info.syncedFolders })}`
              : ""}
            {info.lastSyncAt
              ? ` · ${t("Last synced {time}", {
                  time: formatDateTime(info.lastSyncAt, locale),
                })}`
              : ""}
          </div>
          <div className="mt-2 flex gap-2 pl-6">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                askConfirm({
                  title: t("Disconnect Notion?"),
                  description: t(
                    "This Mac forgets the token and the note → page mapping. Pages already created in Notion are kept, but the next sync creates them again.",
                  ),
                  confirmLabel: t("Disconnect"),
                  destructive: true,
                  onConfirm: () => {
                    void disconnect();
                    setNotice(null);
                  },
                })
              }
            >
              <Unplug className="size-3.5" />
              {t("Disconnect")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                clearError();
                setNotice(t("Disconnect first, then paste the new token."));
              }}
            >
              {t("Replace token")}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <label
            htmlFor="notion-token-input"
            className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground"
          >
            {t("Integration token")}
          </label>
          <div className="mt-2 flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                id="notion-token-input"
                type={showToken ? "text" : "password"}
                value={token}
                spellCheck={false}
                autoComplete="off"
                placeholder="ntn_… / secret_…"
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && token.trim() && !connecting) void submitToken();
                }}
                className="pr-8 font-mono text-[12px]"
              />
              <button
                type="button"
                aria-label={showToken ? t("Hide token") : t("Show token")}
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-1 top-1 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
            <Button
              size="md"
              variant="default"
              disabled={!token.trim() || connecting}
              onClick={() => void submitToken()}
            >
              {connecting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("Verify and save")}
            </Button>
          </div>
        </div>
      )}

      {/* target ------------------------------------------------------ */}
      <div className="mt-5 border-t border-border/70 pt-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {t("Sync target")}
        </div>
        {hasParent ? (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-border px-3 py-2">
            <Link2 className="size-3.5 shrink-0 text-brand" strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium">{info.parentPageTitle}</div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (!info.parentUrl) return;
                void api
                  .openUrl(info.parentUrl)
                  .catch((err) => console.error(errorMessage(err)));
              }}
            >
              <ArrowUpRight className="size-3.5" />
              {t("Open")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setTarget("");
                document.getElementById("notion-target-input")?.focus();
              }}
            >
              {t("Change")}
            </Button>
          </div>
        ) : null}

        <div className="mt-2 flex gap-2">
          <Input
            id="notion-target-input"
            value={target}
            spellCheck={false}
            autoComplete="off"
            aria-label={t("Notion page link")}
            placeholder={t("Notion page link")}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && target.trim() && !settingParent) void submitParent();
            }}
            className="font-mono text-[12px]"
          />
          <Button
            size="md"
            variant="outline"
            disabled={!target.trim() || settingParent || !connected}
            onClick={() => void submitParent()}
          >
            {settingParent ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("Check page")}
          </Button>
        </div>
      </div>

      {/* sync -------------------------------------------------------- */}
      <div className="mt-5 border-t border-border/70 pt-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {t("Sync")}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {t(
            "One-way: Novion overwrites Notion. Archived notes stay in their own folder; notes in Trash are removed from Notion.",
          )}
        </p>

        {syncing ? (
          <div className="mt-3">
            <div className="flex items-center gap-2 text-[12.5px] font-medium">
              <Loader2 className="size-3.5 animate-spin text-brand" />
              {t("Syncing with Notion…")}
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full bg-brand transition-[width] duration-200",
                  (progress?.total ?? 0) === 0 && "w-1/3 animate-pulse",
                )}
                style={
                  (progress?.total ?? 0) > 0
                    ? {
                        width: `${Math.min(
                          100,
                          Math.round(((progress?.done ?? 0) / (progress?.total ?? 1)) * 100),
                        )}%`,
                      }
                    : undefined
                }
              />
            </div>
            <div className="mt-1.5 flex items-baseline gap-2 text-[11px] tabular-nums text-muted-foreground">
              <span>
                {(progress?.done ?? 0)} / {(progress?.total ?? 0) || "?"}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {progress?.current || t("Preparing…")}
              </span>
              <span className="opacity-70">{t("Please keep this window open")}</span>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex justify-end">
            <Button
              size="md"
              variant="default"
              disabled={!connected || !hasParent}
              onClick={() => void startSync()}
            >
              <Upload className="size-3.5" />
              {info.lastSyncAt > 0 ? t("Sync again") : t("Sync to Notion")}
            </Button>
          </div>
        )}

        {notice && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-brand/40 bg-brand-soft px-2 py-1.5 text-[11.5px] leading-relaxed">
            <Check className="mt-[1px] size-3.5 shrink-0 text-brand" />
            <span className="min-w-0 break-words">{notice}</span>
          </div>
        )}

        {error && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-destructive/35 px-2 py-1.5 text-[11.5px] leading-relaxed text-destructive">
            <AlertTriangle className="mt-[1px] size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button
              type="button"
              onClick={clearError}
              className="shrink-0 text-[10.5px] underline-offset-2 hover:underline"
            >
              {t("Got it")}
            </button>
          </div>
        )}

        {lastStats && (
          <div className="mt-3 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-2 text-[12.5px] font-medium">
              <RefreshCw className="size-3.5 text-brand" />
              {t("Sync complete")}
            </div>
            <ul className="mt-1.5 space-y-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
              {lastStats.foldersCreated > 0 && (
                <li>· {t("Created {count} folder pages", { count: lastStats.foldersCreated })}</li>
              )}
              {lastStats.pagesCreated > 0 && (
                <li>· {t("Created {count} note pages", { count: lastStats.pagesCreated })}</li>
              )}
              {lastStats.pagesUpdated > 0 && (
                <li>· {t("Updated {count} note pages", { count: lastStats.pagesUpdated })}</li>
              )}
              {lastStats.pagesRestored > 0 && (
                <li>
                  · {t("Restored {count} note pages from the Notion trash", {
                    count: lastStats.pagesRestored,
                  })}
                </li>
              )}
              {lastStats.pagesTrashed > 0 && (
                <li>
                  · {t("Moved {count} note pages to the Notion trash", {
                    count: lastStats.pagesTrashed,
                  })}
                </li>
              )}
              {lastStats.foldersRestored > 0 && (
                <li>
                  · {t("Restored {count} folder pages from the Notion trash", {
                    count: lastStats.foldersRestored,
                  })}
                </li>
              )}
              {lastStats.foldersTrashed > 0 && (
                <li>
                  · {t("Moved {count} folder pages to the Notion trash", {
                    count: lastStats.foldersTrashed,
                  })}
                </li>
              )}
              {lastStats.pagesVerified > 0 && (
                <li>· {t("Verified {count} unchanged notes", { count: lastStats.pagesVerified })}</li>
              )}
              {lastStats.imagesUploaded > 0 && (
                <li>· {t("Uploaded {count} images", { count: lastStats.imagesUploaded })}</li>
              )}
              {lastStats.imagesFailed > 0 && (
                <li className="text-destructive">
                  ·{" "}
                  {t("{count} images could not be uploaded; a placeholder was inserted instead", {
                    count: lastStats.imagesFailed,
                  })}
                </li>
              )}
              {lastStats.foldersCreated +
                lastStats.pagesCreated +
                lastStats.pagesUpdated +
                lastStats.pagesVerified +
                lastStats.pagesRestored +
                lastStats.pagesTrashed +
                lastStats.foldersRestored +
                lastStats.foldersTrashed ===
                0 && <li>· {t("Nothing needed syncing")}</li>}
            </ul>

            {lastStats.failures.length > 0 && (
              <div className="mt-2 rounded-md border border-destructive/35 px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-destructive">
                  <AlertTriangle className="size-3.5" />
                  {t("{count} items could not be synced", { count: lastStats.failures.length })}
                </div>
                <ul className="mt-1 space-y-1">
                  {lastStats.failures.slice(0, 8).map((failure, index) => (
                    <li key={`${failure.docId}-${index}`} className="text-[11px] leading-relaxed">
                      <span className="font-medium">{failure.title || failure.docId}</span>
                      <span className="text-muted-foreground">: {failure.message}</span>
                    </li>
                  ))}
                  {lastStats.failures.length > 8 && (
                    <li className="text-[11px] text-muted-foreground">
                      …{t("{count} more", { count: lastStats.failures.length - 8 })}
                    </li>
                  )}
                </ul>
              </div>
            )}

            {lastStats.parentUrl && (
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void api.openUrl(lastStats.parentUrl).catch((err) => errorMessage(err))
                  }
                >
                  <ArrowUpRight className="size-3.5" />
                  {t("Open in Notion")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
