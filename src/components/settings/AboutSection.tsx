import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Download, FolderOpen, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/tauri";
import { useUpdate } from "@/store/update";
import { useUi } from "@/store/ui";
import { useT } from "@/i18n";

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
  const check = useUpdate((s) => s.check);
  const download = useUpdate((s) => s.download);
  const install = useUpdate((s) => s.install);

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

  const checking = status === "checking";
  const busy = checking || status === "downloading";

  /** One line of state under the buttons — never a silent "nothing happened". */
  const detail = (() => {
    if (checking) return t("Checking for updates…");
    if (status === "downloading") return t("Downloading {percent}%", { percent });
    if (status === "ready") return t("Update downloaded. Click the button to restart.");
    if (status === "available" && info) return t("Latest version {version}", { version: info.latest });
    if (status === "uptodate" && info && !info.hasRelease) return t("No published release yet");
    if (status === "error") return error ?? t("Update failed");
    return null;
  })();

  return (
    <div className="flex flex-col items-center pt-10">
      <img
        src="/icon.png"
        alt="Novion"
        width={72}
        height={72}
        className="size-[72px] rounded-[18px] shadow-sm"
      />
      <div className="mt-3 text-[15px] font-semibold tracking-[-0.01em]">Novion</div>
      {version ? (
        <div className="mt-1 text-[11.5px] tabular-nums text-muted-foreground">
          {t("Version {version}", { version })}
        </div>
      ) : null}

      <div className="mt-5 flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void check(true)}>
          <RotateCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
          {t("Check for updates")}
        </Button>
        {status === "available" && (
          <Button size="sm" onClick={() => void download()}>
            <Download className="size-3.5" />
            {t("Download")}
          </Button>
        )}
        {status === "ready" && (
          <Button size="sm" onClick={() => void install()}>
            <RotateCw className="size-3.5" />
            {t("Restart to update")}
          </Button>
        )}
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
    </div>
  );
}