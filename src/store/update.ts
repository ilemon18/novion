import { create } from "zustand";
import { api, errorMessage, onUpdateProgress, type UpdateInfo } from "@/lib/tauri";
import { saveQueue } from "@/lib/save-scheduler";
import { useUi } from "@/store/ui";
import { t } from "@/i18n";

/**
 * In-app update state (GitHub Releases).
 *
 * One check runs at every launch — cheap, silent, and the only way the button
 * can appear without the user hunting for it. Downloading is opt-in: the button
 * in the document header is the only trigger.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error";

interface UpdateStore {
  status: UpdateStatus;
  /** true when the current "checking" was started by the user, not by startup */
  manual: boolean;
  info: UpdateInfo | null;
  /** 0–100 while downloading; stays at 100 once the file is complete */
  percent: number;
  received: number;
  total: number;
  error: string | null;
  /** the helper script is taking over; the app is about to quit */
  installing: boolean;
  check: (manual?: boolean) => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

let progressSubscription: (() => void) | null = null;
let started = false;

async function watchProgress() {
  if (progressSubscription) return;
  progressSubscription = await onUpdateProgress((progress) => {
    useUpdate.setState({
      percent: progress.percent,
      received: progress.received,
      total: progress.total,
    });
  });
}

function unwatchProgress() {
  progressSubscription?.();
  progressSubscription = null;
}

export const useUpdate = create<UpdateStore>((set, get) => ({
  status: "idle",
  manual: false,
  info: null,
  percent: 0,
  received: 0,
  total: 0,
  error: null,
  installing: false,

  check: async (manual = false) => {
    const state = get();
    if (state.status === "checking" || state.status === "downloading" || state.installing) return;
    // a finished download is more valuable than a fresh check
    if (!manual && (state.status === "ready" || state.status === "available")) return;

    set({ status: "checking", manual, error: null });
    const notify = useUi.getState().notify;
    try {
      const info = await api.updateCheck();
      set({ info });
      if (info.available) {
        set({ status: "available" });
        if (manual) {
          notify(t("Update available · {version}", { version: info.latest }), {
            actionLabel: t("Download"),
            action: () => void get().download(),
            timeout: 8000,
          });
        }
      } else {
        set({ status: "uptodate" });
        if (manual) notify(t(info.hasRelease ? "You're on the latest version" : "No published release yet"));
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
    set({ status: "downloading", percent: 0, received: 0, total: info.assetSize, error: null });
    await watchProgress();
    try {
      await api.updateDownload(info.downloadUrl, info.assetName, info.checksum);
      set({ status: "ready", percent: 100 });
      useUi.getState().notify(t("Update downloaded. Click the button to restart."), {
        timeout: 6000,
      });
    } catch (err) {
      set({ status: "error", error: errorMessage(err) });
      useUi.getState().notify(errorMessage(err), { tone: "error", timeout: 8000 });
      unwatchProgress();
    }
  },

  install: async () => {
    const { status } = get();
    if (status !== "ready" || get().installing) return;
    set({ installing: true });
    // the app quits right after this: never drop the last edit
    await saveQueue.flushAll();
    try {
      const outcome = await api.updateInstall();
      if (outcome.mode === "manual") {
        set({ installing: false, status: "available" });
        useUi.getState().notify(
          t("The update was downloaded and shown in the Finder: {path}", { path: outcome.path }),
          { timeout: 8000 },
        );
      }
    } catch (err) {
      set({ installing: false, status: "error", error: errorMessage(err) });
      useUi.getState().notify(errorMessage(err), { tone: "error", timeout: 8000 });
      unwatchProgress();
    }
  },

  dismiss: () => {
    unwatchProgress();
    set({ status: "idle", percent: 0, received: 0, total: 0, error: null, installing: false });
  },
}));

/**
 * Starts the launch-time check. Called once from the app shell; safe against
 * the double-mount of React's dev StrictMode and against HMR reloads.
 */
export function startUpdateWatcher() {
  if (started) return;
  started = true;
  void useUpdate.getState().check(false);
}