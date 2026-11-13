import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/tauri";
import { useUpdate } from "@/store/update";
import { useUi } from "@/store/ui";
import { cn } from "@/lib/utils";
import {
  runUpdateAction,
  updateAction,
  updateDetail,
  type UpdateView,
} from "@/lib/update-view";
import { useT } from "@/i18n";

/** Where the name plate points. Kept here so the URL is stated once. */
const PROJECT_URL = "https://github.com/ilemon18/novion";

export function AboutSection() {
  const t = useT();
  const notify = useUi((s) => s.notify);
  // The bundle version comes from the tag that built it (see
  // scripts/set-version.mjs), so this doubles as a "which build is this" check.
  const [version, setVersion] = useState<string | null>(null);

  const status = useUpdate((s) => s.status);
  const info = useUpdate((s) => s.info);
  const percent = useUpdate((s) => s.percent);
  const error = useUpdate((s) => s.error);
  const installedTo = useUpdate((s) => s.installedTo);
  const logPath = useUpdate((s) => s.logPath);
  const revealLog = useUpdate((s) => s.revealLog);

  useEffect(() => {
    let alive = true;
    void getVersion()
      .then((value) => {
        if (alive) setVersion(value);
      })
      .catch(() => {
        // a webview without the Tauri API (vite dev in a browser): no version
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * One button for the whole update flow: it names the next step and nothing
   * else on this panel does the same thing. "检查更新" → "下载更新" →
   * "重启更新" → "正在安装…". The label and the line under it come from the
   * same helper the header pill uses, so the two never offer different steps.
   */
  const view: UpdateView = { status, info, percent, error, installedTo, version };
  const action = updateAction(view, t);
  const detail = updateDetail(view, t);
  const busy = action.kind === "wait";

  const Icon = action.icon;

  return (
    <div className="flex flex-col items-center pt-10">
      <img
        src="/icon.png"
        alt="Novion"
        width={72}
        height={72}
        className="size-[72px] rounded-[18px] shadow-sm"
      />
      {/* The name is the project link: it opens the repository in the system
          browser, not inside the webview. */}
      <button
        type="button"
        onClick={() =>
          void api
            .openUrl(PROJECT_URL)
            .catch((err) => notify(errorMessage(err), { tone: "error", timeout: 6000 }))
        }
        title={PROJECT_URL}
        className="mt-3 -mx-1.5 rounded-md px-1.5 text-[15px] font-semibold tracking-[-0.01em] outline-none transition-colors hover:text-brand focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        Novion
      </button>
      {version ? (
        <div className="mt-1 text-[11.5px] tabular-nums text-muted-foreground">
          {t("Version {version}", { version })}
        </div>
      ) : null}

      <div className="mt-5 flex items-center gap-2">
        <Button
          size="sm"
          variant={status === "ready" ? "default" : "outline"}
          disabled={busy}
          onClick={() => runUpdateAction(action.kind)}
        >
          <Icon
            className={cn(
              "size-3.5",
              action.motion === "spin" && "animate-spin",
              action.motion === "pulse" && "animate-pulse",
            )}
          />
          {action.label}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void api
              .revealStorageFolder()
              .catch((err) => notify(errorMessage(err), { tone: "error", timeout: 6000 }))
          }
        >
          <FolderOpen className="size-3.5" />
          {t("Show in folder")}
        </Button>
      </div>

      {detail ? (
        <div className="mt-3 max-w-[320px] text-center text-[11.5px] leading-relaxed text-muted-foreground">
          {detail}
        </div>
      ) : null}

      {logPath ? (
        <button
          type="button"
          onClick={() => void revealLog()}
          className="mt-1.5 rounded-md px-1.5 text-[11px] text-muted-foreground underline-offset-2 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {t("Update log")}
        </button>
      ) : null}
    </div>
  );
}

