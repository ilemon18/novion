import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Cloud,
  FolderOpen,
  HardDrive,
  Loader2,
  PackageOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type StorageKind, type SwitchMode } from "@/lib/tauri";
import { exportWorkspace, formatBytes, shortPath } from "@/lib/export-actions";
import { useStorage } from "@/store/storage";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

type Phase = "idle" | "confirm" | "running" | "done";

interface Choice {
  mode: SwitchMode;
  label: string;
  hint: string;
}

const CONFLICT_CHOICES: Choice[] = [
  {
    mode: "merge",
    label: "Merge both sides (recommended)",
    hint: "Everything on both sides is kept. For the same note the newer copy wins and the older one is stored as “(local copy)”.",
  },
  {
    mode: "use_target",
    label: "Keep only the destination data",
    hint: "The destination content is used. Local data is backed up first as Novion.backup-<timestamp>.",
  },
  {
    mode: "keep_local",
    label: "Keep only local data",
    hint: "Local content replaces the destination. The destination's existing data is backed up first as Novion.backup-<timestamp>.",
  },
];

const EMPTY_CHOICES: Choice[] = [
  {
    mode: "keep_local",
    label: "Copy to the destination",
    hint: "Every local note and image is copied over, then Novion switches.",
  },
];

export function StorageSection() {
  const t = useT();
  const info = useStorage((s) => s.info);
  const loading = useStorage((s) => s.loading);
  const switching = useStorage((s) => s.switching);
  const progress = useStorage((s) => s.progress);
  const error = useStorage((s) => s.error);
  const load = useStorage((s) => s.load);
  const switchTo = useStorage((s) => s.switchTo);

  const [phase, setPhase] = useState<Phase>("idle");
  const [target, setTarget] = useState<StorageKind | null>(null);
  const [mode, setMode] = useState<SwitchMode>("merge");
  const [summary, setSummary] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState<{ path: string; files: number; bytes: number } | null>(
    null,
  );

  useEffect(() => {
    if (!info && !loading) void load();
  }, [info, loading, load]);

  if (!info) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {t("Reading storage status…")}
      </div>
    );
  }

  const targetInfo = target === "icloud"
    ? { path: info.icloudRoot, ready: info.icloudReady, docs: info.icloudDocs }
    : { path: info.localRoot, ready: info.localReady, docs: info.localDocs };

  const choices = targetInfo.ready ? CONFLICT_CHOICES : EMPTY_CHOICES;

  const start = async () => {
    if (!target) return;
    setPhase("running");
    const stats = await switchTo(target, mode);
    if (!stats) {
      setPhase("confirm");
      return;
    }
    const lines: string[] = [];
    if (stats.docsCopied) lines.push(t("Copied {count} notes", { count: stats.docsCopied }));
    if (stats.docsMerged) lines.push(t("Updated {count} matching notes", { count: stats.docsMerged }));
    if (stats.copiesRenamed) lines.push(t("Kept {count} conflicting copies", { count: stats.copiesRenamed }));
    if (stats.assetsCopied) lines.push(t("Copied {count} images", { count: stats.assetsCopied }));
    if (stats.backupPath) lines.push(t("Backup: {path}", { path: stats.backupPath }));
    setSummary(lines.length ? lines : [t("Nothing needed to move")]);
    setPhase("done");
  };

  const cards: {
    kind: StorageKind;
    title: string;
    detail: string;
    docs: number;
    ready: boolean;
    disabled?: boolean;
  }[] = [
    {
      kind: "local",
      title: "On this computer",
      detail: info.localRoot,
      docs: info.localDocs,
      ready: info.localReady,
    },
    ];
  // iCloud Drive only exists on macOS; on Windows the card would offer a
  // switch that can never succeed, so it is not shown at all.
  if (info.icloudSupported) {
    cards.push({
      kind: "icloud",
      title: "iCloud Drive",
      detail: info.icloudRoot,
      docs: info.icloudDocs,
      ready: info.icloudReady,
      disabled: !info.icloudAvailable,
    });
  }

  if (phase === "confirm" && target) {
    return (
      <div>
        <div className="text-[13px] font-medium">
          {t("Switch to {destination}", {
            destination: target === "icloud" ? t("iCloud Drive") : t("On this computer"),
          })}
        </div>
        <div className="mt-1 selectable break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/75">
          {targetInfo.path}
        </div>
        <div className="mt-1 text-[11.5px] text-muted-foreground">
          {targetInfo.ready
            ? t("The destination already holds {count} notes.", { count: targetInfo.docs })
            : t("The destination has no data yet.")}
        </div>

        <div className="mt-3 space-y-2">
          {choices.map((choice) => {
            const active = mode === choice.mode;
            return (
              <button
                key={choice.mode}
                onClick={() => setMode(choice.mode)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
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
                  <span className="block text-[12.5px] font-medium">{t(choice.label)}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                    {t(choice.hint)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-1.5 rounded-md border border-destructive/35 px-2 py-1.5 text-[11.5px] leading-relaxed text-destructive">
            <AlertTriangle className="mt-[1px] size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPhase("idle")}>
            {t("Cancel")}
          </Button>
          <Button variant="default" size="sm" onClick={() => void start()}>
            {t("Start switching")}
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  if (phase === "running") {
    const total = progress?.total ?? 0;
    const done = progress?.done ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
    return (
      <div className="py-6">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Loader2 className="size-3.5 animate-spin text-brand" />
          {progress?.phase === "merge" ? t("Merging data…") : t("Copying data…")}
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full bg-brand transition-[width] duration-200",
              pct === null && "w-1/3 animate-pulse",
            )}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 text-[11.5px] tabular-nums text-muted-foreground">
          {total > 0 ? `${done} / ${total}` : t("Preparing…")}
          <span className="ml-2 opacity-70">{t("Please keep this window open")}</span>
        </div>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div>
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <Check className="size-4 text-brand" />
          {t("Switched to {destination}", {
            destination: info.storage === "icloud" ? t("iCloud Drive") : t("On this computer"),
          })}
        </div>
        <ul className="mt-2 space-y-1 text-[11.5px] leading-relaxed text-muted-foreground">
          {summary.map((line) => (
            <li key={line} className="break-all">
              · {line}
            </li>
          ))}
        </ul>
        <div className="mt-3 selectable break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] text-foreground/75">
          {info.activeRoot}
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="default" onClick={() => setPhase("idle")}>
            {t("Done")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {t("Data location")}
      </div>
      <div className="mt-2 space-y-2">
        {cards.map((card) => {
          const active = info.storage === card.kind;
          const Icon = card.kind === "icloud" ? Cloud : HardDrive;
          return (
            <div
              key={card.kind}
              className={cn(
                "rounded-lg border px-3 py-2.5 transition-colors",
                active ? "border-brand/60 bg-brand-soft" : "border-border",
                card.disabled && "opacity-55",
              )}
            >
              <div className="flex items-start gap-2">
                <Icon
                  className={cn(
                    "mt-[2px] size-4 shrink-0",
                    active ? "text-brand" : "text-muted-foreground",
                  )}
                  strokeWidth={1.8}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-medium">{t(card.title)}</span>
                    {active && (
                      <span className="rounded border border-brand/40 px-1 text-[10px] text-brand">
                        {t("Current")}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                      {t("{count} notes", { count: card.docs })}
                    </span>
                  </div>
                  <div
                    className="mt-1 selectable break-all font-mono text-[10.5px] leading-relaxed text-muted-foreground/70"
                    title={card.detail}
                  >
                    {card.detail}
                  </div>
                  {card.disabled && (
                    <div className="mt-1.5 flex items-start gap-1 text-[11px] leading-relaxed text-destructive">
                      <AlertTriangle className="mt-[1px] size-3 shrink-0" />
                      {t("iCloud Drive was not found. Sign in to iCloud in System Settings and turn on iCloud Drive.")}
                    </div>
                  )}
                  {!active && !card.disabled && (
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={switching}
                        onClick={() => {
                          setTarget(card.kind);
                          setMode(card.ready ? "merge" : "keep_local");
                          setPhase("confirm");
                        }}
                      >
                        {t("Switch here")}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void api.revealStorageFolder().catch((err) => errorMessage(err));
          }}
        >
          <FolderOpen className="size-3.5" />
          {t("Show in folder")}
        </Button>
      </div>

      <div className="mt-4 rounded-lg border border-border/70 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <PackageOpen
            className="mt-[2px] size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.8}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium">{t("Export and backup")}</div>
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={exporting}
                onClick={async () => {
                  setExporting(true);
                  const result = await exportWorkspace();
                  setExporting(false);
                  if (result) {
                    setLastExport({
                      path: result.path,
                      files: result.files,
                      bytes: result.bytes,
                    });
                  }
                }}
              >
                {exporting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <PackageOpen className="size-3.5" />
                )}
                {t("Back up the whole workspace")}
              </Button>
              {lastExport && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void api.revealPath(lastExport.path).catch((err) => {
                      useUi.getState().notify(errorMessage(err), { tone: "error" });
                    });
                  }}
                >
                  <FolderOpen className="size-3.5" />
                  {t("Show in folder")}
                </Button>
              )}
            </div>
            {lastExport && (
              <p className="mt-1.5 break-all font-mono text-[10.5px] leading-relaxed text-muted-foreground/70">
                {shortPath(lastExport.path)} · {t("{count} files", { count: lastExport.files })} ·{" "}
                {formatBytes(lastExport.bytes)}
              </p>
            )}
          </div>
        </div>
      </div>

      </div>
  );
}
