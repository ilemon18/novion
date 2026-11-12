import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, GitCompare, History, Loader2, RotateCcw } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  api,
  errorMessage,
  type DocVersionBody,
  type DocVersionMeta,
} from "@/lib/tauri";
import { saveQueue } from "@/lib/save-scheduler";
import { diffLines } from "@/lib/diff";
import { docLines } from "@/lib/doc-text";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { t as translate, useT } from "@/i18n";

interface Props {
  docId: string;
  /** called after a restore so the view can reload the editor */
  onRestored: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

function clock(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function relative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return translate("Just now");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return translate("{count} min ago", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate("{count} hr ago", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return translate("{count} days ago", { count: days });
  return clock(ts).slice(0, 10);
}

type View = "content" | "diff";

/**
 * Rolling version history of one document.
 *
 * Restoring flushes and cancels pending autosave first, so the editor that is
 * about to be remounted cannot write its stale body back over the restored one.
 * The diff pane compares the selected snapshot against the body currently on
 * disk, which is what "what did I change since then?" actually means.
 */
export function VersionHistoryDialog({ docId, onRestored }: Props) {
  const t = useT();
  const openDocId = useUi((s) => s.historyDocId);
  const close = useUi((s) => s.closeHistory);
  const notify = useUi((s) => s.notify);
  const open = openDocId === docId;

  const [versions, setVersions] = useState<DocVersionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmTs, setConfirmTs] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  /** retention picked in the settings, shown so the list length is explained */
  const [limit, setLimit] = useState(10);

  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [body, setBody] = useState<DocVersionBody | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [currentLines, setCurrentLines] = useState<string[]>([]);
  const [view, setView] = useState<View>("diff");

  const versionLines = useMemo(() => docLines(body?.content), [body]);
  // the LCS table costs memory, so it is only built while the diff tab is
  // actually on screen
  const diff = useMemo(
    () => (view === "diff" ? diffLines(versionLines, currentLines) : []),
    [view, versionLines, currentLines],
  );
  const changed = diff.some((line) => line.kind !== "same");

  const loadVersions = useCallback(async () => {
    const list = await api.listDocVersions(docId);
    setVersions(list);
    setSelectedTs((current) =>
      current != null && list.some((item) => item.ts === current)
        ? current
        : (list[0]?.ts ?? null),
    );
    return list;
  }, [docId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setVersions(null);
    setError(null);
    setConfirmTs(null);
    setBody(null);
    setSelectedTs(null);
    setView("diff");
    api
      .getHistoryLimit()
      .then((value) => {
        if (alive) setLimit(value);
      })
      .catch(() => {
        /* the default is a fine fallback for a caption */
      });
    loadVersions()
      .then(() => {
        if (alive) setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setVersions([]);
        setError(errorMessage(err));
      });
    api
      .readDoc(docId)
      .then((doc) => {
        if (alive) setCurrentLines(docLines(doc.content));
      })
      .catch(() => {
        if (alive) setCurrentLines([]);
      });
    return () => {
      alive = false;
      // a closed dialog must not keep a full document body (and its text
      // lines) alive for as long as the note stays open
      setVersions(null);
      setBody(null);
      setCurrentLines([]);
    };
  }, [open, docId, loadVersions]);

  useEffect(() => {
    if (!open || selectedTs == null) {
      setBody(null);
      return;
    }
    let alive = true;
    setBodyLoading(true);
    api
      .readDocVersion(docId, selectedTs)
      .then((value) => {
        if (alive) setBody(value);
      })
      .catch((err) => {
        if (!alive) return;
        setBody(null);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (alive) setBodyLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, docId, selectedTs]);

  const restore = async (ts: number) => {
    setRestoring(ts);
    const key = `doc:${docId}`;
    try {
      await saveQueue.flush(key);
      saveQueue.cancel(key);
      await api.restoreDocVersion(docId, ts);
      notify(t("Restored to the selected version"), { tone: "success" });
      onRestored();
      close();
    } catch (err) {
      notify(errorMessage(err), { tone: "error", timeout: 7000 });
    } finally {
      setRestoring(null);
      setConfirmTs(null);
    }
  };

  /** "存一个版本": flush pending edits, then snapshot what is on disk now. */
  const createSnapshot = async () => {
    setCreating(true);
    const key = `doc:${docId}`;
    try {
      await saveQueue.flush(key);
      const created = await api.createDocVersion(docId);
      const list = await loadVersions();
      setSelectedTs(created.ts);
      notify(t("Version saved ({count} total)", { count: list.length }), {
        tone: "success",
      });
    } catch (err) {
      notify(errorMessage(err), { tone: "error", timeout: 7000 });
    } finally {
      setCreating(false);
    }
  };

  const selected = versions?.find((version) => version.ts === selectedTs) ?? null;
  const confirming = selected != null && confirmTs === selected.ts;

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? close() : undefined)}>
      <DialogContent className="w-[min(880px,calc(100vw-32px))]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <DialogTitle>{t("Version history")}</DialogTitle>
            <DialogDescription>
              {t(
                "A snapshot is saved every 5 minutes, keeping up to {limit}. Restoring replaces only the body.",
                { limit },
              )}
            </DialogDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={creating}
            onClick={() => void createSnapshot()}
          >
            {creating ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Camera className="size-3" />
            )}
            {t("Save a version")}
          </Button>
        </div>

        <div className="mt-3 grid min-h-0 gap-3 sm:grid-cols-[252px_1fr]">
          <div className="max-h-[min(420px,52vh)] overflow-y-auto rounded-lg border border-border/70">
            {versions === null ? (
              <div className="flex items-center gap-2 px-3 py-6 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t("Loading version history…")}
              </div>
            ) : versions.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
                <History className="size-5 text-muted-foreground/50" strokeWidth={1.6} />
                <p className="text-[12.5px] text-muted-foreground">{t("No versions yet")}</p>
                <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                  {t("Keep editing, or click “Save a version”.")}
                </p>
              </div>
            ) : (
              versions.map((version, index) => {
                const active = version.ts === selectedTs;
                return (
                  <button
                    key={version.ts}
                    type="button"
                    onClick={() => {
                      setSelectedTs(version.ts);
                      setConfirmTs(null);
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors",
                      index > 0 && "border-t border-border/60",
                      active ? "bg-brand-soft" : "hover:bg-accent/60",
                    )}
                  >
                    <span className="text-[12.5px] font-medium tabular-nums">
                      {clock(version.ts)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {relative(version.ts)} · {t("{words} words", { words: version.words })}
                    </span>
                    <span className="line-clamp-1 w-full text-[11px] text-muted-foreground/80">
                      {version.preview || t("(Empty document)")}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="flex min-h-[220px] max-h-[min(420px,52vh)] flex-col overflow-hidden rounded-lg border border-border/70">
            <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-1.5 py-1">
              <button
                type="button"
                onClick={() => setView("diff")}
                className={cn(
                  "flex h-6 items-center gap-1 rounded px-2 text-[11.5px] transition-colors",
                  view === "diff"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <GitCompare className="size-3" />
                {t("Compare with current")}
              </button>
              <button
                type="button"
                onClick={() => setView("content")}
                className={cn(
                  "flex h-6 items-center rounded px-2 text-[11.5px] transition-colors",
                  view === "content"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                {t("Content")}
              </button>
              {selected && (
                <span className="ml-auto pr-1 text-[10.5px] tabular-nums text-muted-foreground">
                  {clock(selected.ts)}
                </span>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 text-[12px] leading-[1.6]">
              {bodyLoading ? (
                <div className="flex items-center gap-2 px-1 py-3 text-[12px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {t("Loading…")}
                </div>
              ) : !body ? (
                <p className="px-1 py-3 text-[11.5px] text-muted-foreground/70">
                  {t("Select a version on the left to view it.")}
                </p>
              ) : view === "content" ? (
                <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.65] text-foreground/90">
                  {versionLines.join("\n") || t("(Empty document)")}
                </pre>
              ) : !changed ? (
                <p className="px-1 py-3 text-[11.5px] text-muted-foreground/70">
                  {t("No changes from the current content.")}
                </p>
              ) : (
                <div className="space-y-px">
                  {diff.map((line, index) => (
                    <div
                      key={index}
                      className={cn(
                        "flex gap-1.5 whitespace-pre-wrap break-words rounded px-1",
                        line.kind === "add" && "bg-success/12 text-foreground",
                        line.kind === "del" && "bg-destructive/10 text-muted-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "w-3 shrink-0 select-none text-center text-[11px]",
                          line.kind === "add"
                            ? "text-success"
                            : line.kind === "del"
                              ? "text-destructive"
                              : "text-muted-foreground/40",
                        )}
                      >
                        {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
                      </span>
                      <span className={cn("min-w-0 flex-1", line.kind === "del" && "line-through decoration-destructive/40")}>
                        {line.text || " "}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {error && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-destructive">{error}</p>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            {t("The body before restoring is also saved as a snapshot.")}
          </p>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={close}>
              {t("Close")}
            </Button>
            <Button
              size="sm"
              variant={confirming ? "default" : "outline"}
              disabled={
                !selected || restoring !== null || (confirming && !selected)
              }
              onClick={() => {
                if (!selected) return;
                if (!confirming) {
                  setConfirmTs(selected.ts);
                  return;
                }
                void restore(selected.ts);
              }}
            >
              {restoring != null ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RotateCcw className="size-3" />
              )}
              {confirming ? t("Confirm restore") : t("Restore this version")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}