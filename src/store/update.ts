import { create } from "zustand";
import { api, errorMessage, onUpdateProgress, type UpdateInfo, type UpdateReport } from "@/lib/tauri";
import { saveQueue } from "@/lib/save-scheduler";
import { useUi } from "@/store/ui";
import { t } from "@/i18n";

/**
 * In-app update state (GitHub Releases).
 *
 * One check runs at every launch — cheap, silent, and the only way the button
 * can appear without the user hunting for it. Downloading is opt-in: the button
 * in the document header (and the one in Settings → About) is the only trigger,
 * and both drive this single state machine, so they can never disagree.
 *
 * Every status maps to exactly one button label:
 *
 *   idle/uptodate → "检查更新"   available → "下载更新"
 *   downloading   → "42%"        ready     → "重启更新"
 *   installing    → "正在安装…"   error     → "重试"
 *
 * That mapping lives in `lib/update-view.ts`, which both the header pill and
 * the Settings → About button render.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "uptodate"
  | "error";

interface UpdateStore {
  status: UpdateStatus;
  /** true when the current "checking" was started by the user, not by startup */
  manual: boolean;
  info: UpdateInfo | null;
  /** 0–100 while downloading; stays at 100 once the file is complete */
  percent: number;
  error: string | null;
  /** where a finished install put the app, when it is not where it ran from */
  installedTo: string;
  /** `update.log`, so a failed install can be inspected instead of guessed at */
  logPath: string;
  check: (manual?: boolean) => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  revealLog: () => Promise<void>;
  dismiss: () => void;
}

let progressSubscription: (() => void) | null = null;
let started = false;
let installTimer: ReturnType<typeof setTimeout> | null = null;

async function watchProgress() {
  if (progressSubscription) return;
  progressSubscription = await onUpdateProgress((progress) => {
    useUpdate.setState({ percent: progress.percent });
  });
}

function unwatchProgress() {
  progressSubscription?.();
  progressSubscription = null;
}

function clearInstallTimer() {
  if (installTimer) clearTimeout(installTimer);
  installTimer = null;
}

export const useUpdate = create<UpdateStore>((set, get) => ({
  status: "idle",
  manual: false,
  info: null,
  percent: 0,
  error: null,
  installedTo: "",
  logPath: "",

  check: async (manual = false) => {
    const state = get();
    if (
      state.status === "checking" ||
      state.status === "downloading" ||
      state.status === "ready" ||
      state.status === "installing"
    ) {
      return;
    }
    // a finished download is more valuable than a fresh check
    if (!manual && state.status === "available") return;

    set({ status: "checking", manual, error: null });
    const notify = useUi.getState().notify;
    try {
      const info = await api.updateCheck();
      set({ info });
      if (info.available) {
        set({ status: "available" });
        // the button itself turns into "下载更新": a toast with a second
        // download action would just be another copy of the same control
        if (manual) {
          notify(t("Update available · {version}", { version: info.latest }), {
            timeout: 6000,
          });
        }
      } else {
        set({ status: "uptodate" });
        if (manual) {
          notify(t(info.hasRelease ? "You're on the latest version" : "No published release yet"));
        }
      }
    } catch (err) {
      const message = errorMessage(err);
      // a failed background check is noise: the next launch tries again
      set({ status: manual ? "error" : "idle", error: message });
      if (manual) notify(message, { tone: "error", timeout: 8000 });
    }
  },

  download: async () => {
    const { info, status } = get();
    // needs a published bundle for this platform; the UI only offers this when
    // `available` is true, so a second guard keeps double-clicks out
    if (!info?.available || !info.downloadUrl || status === "downloading") return;
    set({ status: "downloading", percent: 0, error: null });
    await watchProgress();
    try {
      await api.updateDownload(info.downloadUrl, info.assetName, info.checksum);
      clearInstallTimer();
      // nothing left to listen to once the file is on disk
      unwatchProgress();
      set({ status: "ready", percent: 100 });
    } catch (err) {
      set({ status: "error", error: errorMessage(err) });
      useUi.getState().notify(errorMessage(err), { tone: "error", timeout: 8000 });
      unwatchProgress();
    }
  },

  install: async () => {
    const { status, info } = get();
    if (status !== "ready") return;
    set({ status: "installing", error: null });
    // the app quits right after this: never drop the last edit
    await saveQueue.flushAll();
    try {
      const outcome = await api.updateInstall(info?.latest ?? "");
      set({ installedTo: outcome.installedTo, logPath: outcome.logPath });
      if (outcome.mode === "manual") {
        set({ status: "available" });
        useUi.getState().notify(
          t("The update was downloaded and shown in the Finder: {path}", { path: outcome.path }),
          { timeout: 8000 },
        );
        return;
      }
      const moved = Boolean(outcome.previous && outcome.installedTo !== outcome.previous);
      useUi.getState().notify(
        moved
          ? t("Installing the update into {path}, then restarting", { path: outcome.installedTo })
          : t("Restarting to install the update…"),
        { timeout: 4000 },
      );
      // The helper quits the app within a second. If that never happens the
      // install did not start, and the button must not stay stuck saying
      // "installing" forever.
      clearInstallTimer();
      installTimer = setTimeout(() => {
        installTimer = null;
        if (useUpdate.getState().status !== "installing") return;
        useUpdate.setState({ status: "ready", error: t("The app did not restart. Quit and reopen it to finish installing.") });
      }, 15_000);
    } catch (err) {
      clearInstallTimer();
      set({ status: "error", error: errorMessage(err) });
      useUi.getState().notify(errorMessage(err), { tone: "error", timeout: 8000 });
      unwatchProgress();
    }
  },

  revealLog: async () => {
    try {
      const path = await api.updateRevealLog();
      set({ logPath: path });
    } catch (err) {
      useUi.getState().notify(errorMessage(err), { tone: "error", timeout: 6000 });
    }
  },

  dismiss: () => {
    unwatchProgress();
    clearInstallTimer();
    set({
      status: "idle",
      percent: 0,
      error: null,
      installedTo: "",
    });
  },
}));

/**
 * Reports the outcome of an install attempt made before this launch.
 *
 * "Restart to install" used to be believable on its own: the helper could fail
 * after the app quit and nothing would ever say so. The version marker makes
 * that visible — the one case the user described on Windows ("it restarts, and
 * it is still the old version").
 */
async function reportStartup(): Promise<UpdateReport | null> {
  let report: UpdateReport | null = null;
  try {
    report = await api.updateStartupReport();
  } catch {
    return null;
  }
  if (!report) return null;
  const notify = useUi.getState().notify;
  useUpdate.setState({ logPath: report.logPath });
  if (report.ok) {
    notify(t("Updated to {version}", { version: report.current }), { timeout: 6000 });
    return report;
  }
  useUpdate.setState({
    // not "ready": the downloaded file is gone with the old process, so the
    // only useful next step is downloading it again
    status: "error",
    info: null,
    error: t("The update to {version} did not take effect: still on {current}.", {
      version: report.attempted,
      current: report.current,
    }),
  });
  notify(
    t("The update to {version} did not take effect: still on {current}.", {
      version: report.attempted,
      current: report.current,
    }),
    {
      tone: "error",
      timeout: 0,
      actionLabel: t("Update log"),
      action: () => void useUpdate.getState().revealLog(),
    },
  );
  return report;
}

/**
 * Starts the launch-time work: report the previous install, then check. Called
 * once from the app shell; safe against the double-mount of React's dev
 * StrictMode and against HMR reloads.
 */
export function startUpdateWatcher() {
  if (started) return;
  started = true;
  void reportStartup().then((report) => {
    // a report that says the install failed is the most important thing on
    // screen: a silent check would replace it with "发现新版本" and bury it
    if (report && !report.ok) return;
    void useUpdate.getState().check(false);
  });
}
