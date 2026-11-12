import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
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
import {
  api,
  errorMessage,
  type NotionConflictAction,
  type NotionConflictPolicy,
  type NotionSyncConflict,
  type NotionSyncDirection,
  type NotionSyncMode,
} from "@/lib/tauri";
import { useNotion } from "@/store/notion";
import { useUi } from "@/store/ui";
import { useWorkspace } from "@/store/workspace";
import { cn } from "@/lib/utils";
import { formatDateTime, useT } from "@/i18n";

const MODES: { value: NotionSyncMode; label: string; hint: string }[] = [
  {
    value: "new_only",
    label: "New pages only",
    hint: "Notes that already have a page are skipped; edits on Notion are left alone.",
  },
  {
    value: "overwrite",
    label: "Rewrite changed bodies",
    hint: "Bodies of notes changed locally are rewritten in Notion; unchanged ones are skipped.",
  },
];

const DIRECTIONS: { value: NotionSyncDirection; label: string; hint: string }[] = [
  {
    value: "push",
    label: "To Notion",
    hint: "Only send local changes. Everything on Notion stays as it is.",
  },
  {
    value: "pull",
    label: "From Notion",
    hint: "Only bring Notion changes back, including pages created there.",
  },
  {
    value: "both",
    label: "Two-way",
    hint: "Send local changes and bring Notion changes back.",
  },
];

const POLICIES: { value: NotionConflictPolicy; label: string; hint: string }[] = [
  {
    value: "ask",
    label: "Ask me",
    hint: "List the notes changed on both sides and let you decide.",
  },
  {
    value: "local",
    label: "Keep local",
    hint: "When both sides changed, the local body wins.",
  },
  {
    value: "remote",
    label: "Keep Notion",
    hint: "When both sides changed, the Notion body wins.",
  },
];

export function NotionSection() {
  const t = useT();
  const info = useNotion((s) => s.info);
  const loading = useNotion((s) => s.loading);
  const connecting = useNotion((s) => s.connecting);
  const resolving = useNotion((s) => s.resolving);
  const syncing = useNotion((s) => s.syncing);
  const progress = useNotion((s) => s.progress);
  const error = useNotion((s) => s.error);
  const lastStats = useNotion((s) => s.lastStats);
  const load = useNotion((s) => s.load);
  const connect = useNotion((s) => s.connect);
  const disconnect = useNotion((s) => s.disconnect);
  const setParent = useNotion((s) => s.setParent);
  const sync = useNotion((s) => s.sync);
  const resolveConflicts = useNotion((s) => s.resolveConflicts);
  const clearError = useNotion((s) => s.clearError);
  const askConfirm = useUi((s) => s.askConfirm);
  const locale = useUi((s) => s.locale);

  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<NotionSyncMode>("new_only");
  const [direction, setDirection] = useState<NotionSyncDirection>("both");
  const [policy, setPolicy] = useState<NotionConflictPolicy>("ask");
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<NotionSyncConflict[]>([]);

  useEffect(() => {
    if (!info && !loading) void load();
  }, [info, loading, load]);

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
  const busy = connecting || resolving || syncing;
  const pulls = direction === "pull" || direction === "both";
  const pushes = direction === "push" || direction === "both";

  const refreshWorkspace = async () => {
    try {
      const ws = await api.ensure();
      useWorkspace.getState().apply(ws);
    } catch {
      /* the tree refreshes on its own polling if this fails */
    }
  };

  const submitToken = async () => {
    setNotice(null);
    const ok = await connect(token);
    if (ok) {
      setToken("");
    }
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
    setConflicts([]);
    const stats = await sync(mode, includeCompleted, direction, policy);
    if (!stats) return;
    if (stats.conflicts.length > 0) setConflicts(stats.conflicts);
    await refreshWorkspace();
  };

  const resolveAll = async (action: NotionConflictAction) => {
    if (!conflicts.length) return;
    const resolutions = conflicts.map((conflict) => ({ docId: conflict.docId, action }));
    setConflicts([]);
    await resolveConflicts(resolutions);
    await refreshWorkspace();
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
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {t("Connect")}
          </div>
          <div className="mt-2 flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                type={showToken ? "text" : "password"}
                value={token}
                spellCheck={false}
                autoComplete="off"
                placeholder={t("Paste the integration token (ntn_… or secret_…)")}
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
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "Create an internal integration in Notion and copy its token, then share the target page with it.",
            )}
          </p>
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
              <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                {info.parentPageId}
              </div>
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
            placeholder={t("Paste a Notion page link, e.g. https://www.notion.so/xxx-1a2b…")}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && target.trim() && !resolving) void submitParent();
            }}
            className="font-mono text-[12px]"
          />
          <Button
            size="md"
            variant="outline"
            disabled={!target.trim() || resolving || !connected}
            onClick={() => void submitParent()}
          >
            {resolving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("Check page")}
          </Button>
        </div>
        {connected && (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t("Notes become child pages here; folders become one level of child pages.")}
          </p>
        )}
      </div>

      {/* sync -------------------------------------------------------- */}
      <div className="mt-5 border-t border-border/70 pt-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {t("Sync")}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <input
              type="checkbox"
              checked={includeCompleted}
              onChange={(e) => setIncludeCompleted(e.target.checked)}
              disabled={syncing}
              className="size-3.5 accent-[var(--brand-strong)]"
            />
            {t("Include archived")}
          </label>
        </div>

        {/* direction */}
        <div className="mt-2 space-y-2">
          {DIRECTIONS.map((option) => {
            const active = direction === option.value;
            return (
              <button
                key={option.value}
                onClick={() => setDirection(option.value)}
                disabled={syncing}
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                  active ? "border-brand/60 bg-brand-soft" : "border-border hover:bg-accent/60",
                )}
              >
                <span
                  className={cn(
                    "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                    active ? "border-brand bg-brand text-brand-foreground" : "border-input",
                  )}
                >
                  {active && <Check className="size-2.5" strokeWidth={3} />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium">{t(option.label)}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                    {t(option.hint)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {pushes && (
          <div className="mt-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              {t("When pushing")}
            </div>
            <div className="mt-1.5 space-y-1.5">
              {MODES.map((option) => {
                const active = mode === option.value;
                return (
                  <button
                    key={option.value}
                    onClick={() => setMode(option.value)}
                    disabled={syncing}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                      active ? "border-brand/60 bg-brand-soft" : "border-border hover:bg-accent/60",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                        active ? "border-brand bg-brand text-brand-foreground" : "border-input",
                      )}
                    >
                      {active && <Check className="size-2.5" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium">{t(option.label)}</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                        {t(option.hint)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {direction === "both" && (
          <div className="mt-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              {t("When both sides changed")}
            </div>
            <div className="mt-1.5 space-y-1.5">
              {POLICIES.map((option) => {
                const active = policy === option.value;
                return (
                  <button
                    key={option.value}
                    onClick={() => setPolicy(option.value)}
                    disabled={syncing}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                      active ? "border-brand/60 bg-brand-soft" : "border-border hover:bg-accent/60",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                        active ? "border-brand bg-brand text-brand-foreground" : "border-input",
                      )}
                    >
                      {active && <Check className="size-2.5" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium">{t(option.label)}</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                        {t(option.hint)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

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
              {pulls ? <ArrowDownToLine className="size-3.5" /> : <Upload className="size-3.5" />}
              {direction === "pull"
                ? t("Pull from Notion")
                : info.syncedDocs > 0
                  ? t("Sync again")
                  : t("Sync to Notion")}
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

        {/* conflicts -------------------------------------------------- */}
        {conflicts.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[12px] font-medium">
              <AlertTriangle className="size-3.5 text-amber-600" />
              {t("{count} notes changed on both sides", { count: conflicts.length })}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("Nothing was overwritten. Pick what to keep for each note.")}
            </p>
            <ul className="mt-2 space-y-1.5">
              {conflicts.map((conflict) => (
                <li
                  key={conflict.docId}
                  className="rounded-md border border-border/70 bg-background px-2 py-1.5"
                >
                  <div className="truncate text-[11.5px] font-medium">
                    {conflict.title || t("Untitled")}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(
                      [
                        ["local", t("Keep local")],
                        ["remote", t("Keep Notion")],
                        ["both", t("Keep both")],
                      ] as [NotionConflictAction, string][]
                    ).map(([action, label]) => (
                      <Button
                        key={action}
                        size="sm"
                        variant="outline"
                        disabled={syncing}
                        onClick={() =>
                          void resolveConflicts([{ docId: conflict.docId, action }]).then(
                            async () => {
                              setConflicts((current) =>
                                current.filter((item) => item.docId !== conflict.docId),
                              );
                              await refreshWorkspace();
                            },
                          )
                        }
                      >
                        {label}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void api.openUrl(conflict.url).catch(() => undefined)}
                    >
                      <ArrowUpRight className="size-3" />
                      {t("Open")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => void resolveAll("local")}>
                {t("Keep local for all")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void resolveAll("remote")}>
                {t("Keep Notion for all")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void resolveAll("both")}>
                {t("Keep both for all")}
              </Button>
            </div>
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
                <li>· {t("Rewrote {count} note bodies", { count: lastStats.pagesUpdated })}</li>
              )}
              {lastStats.pagesPulled > 0 && (
                <li>· {t("Pulled {count} notes from Notion", { count: lastStats.pagesPulled })}</li>
              )}
              {lastStats.pagesImported > 0 && (
                <li>
                  · {t("Imported {count} new pages from Notion", { count: lastStats.pagesImported })}
                </li>
              )}
              {lastStats.pagesSkipped > 0 && (
                <li>· {t("Skipped {count} unchanged notes", { count: lastStats.pagesSkipped })}</li>
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
                lastStats.pagesPulled +
                lastStats.pagesImported +
                lastStats.pagesSkipped ===
                0 &&
                lastStats.conflicts.length === 0 && <li>· {t("Nothing needed syncing")}</li>}
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

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        {t(
          "Two-way sync is manual: nothing leaves this computer until you press Sync. Conflicting notes are never overwritten without your choice.",
        )}
      </p>
    </div>
  );
}