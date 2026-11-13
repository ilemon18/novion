import { Download, RotateCw, TriangleAlert, type LucideIcon } from "lucide-react";
import type { UpdateInfo } from "@/lib/tauri";
import { useUpdate, type UpdateStatus } from "@/store/update";

/**
 * The one place that turns update state into what the user sees.
 *
 * Two controls render the same state machine — the pill in the document header
 * and the button in Settings → About. They used to answer "what is the next
 * step?" separately: two switches, two label maps, two copies of `formatSize`,
 * kept in agreement by a comment asking whoever edits one to edit the other.
 * This module is now the answer for both, so they cannot disagree.
 */

/** How `t` is reached: the `useT()` hook in a component, `t` in a store. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** What a click on the shared button does. `wait` = nothing to run yet. */
export type UpdateActionKind = "check" | "retry" | "download" | "install" | "wait";

export interface UpdateAction {
  kind: UpdateActionKind;
  label: string;
  icon: LucideIcon;
  /** icon motion, so both controls animate the same way */
  motion: "none" | "spin" | "pulse";
  /** 0–100: the share of the file already on disk */
  percent: number;
  tone: "brand" | "muted" | "danger";
}

/** Everything the two controls read, gathered so the callers stay one-liners. */
export interface UpdateView {
  status: UpdateStatus;
  info: UpdateInfo | null;
  percent: number;
  error: string | null;
  installedTo: string;
  /** bundle version on disk; null in a plain browser build */
  version: string | null;
}

export function updateAction(view: UpdateView, t: Translate): UpdateAction {
  switch (view.status) {
    case "downloading":
      return {
        kind: "wait",
        label: `${view.percent}%`,
        icon: Download,
        motion: "none",
        percent: Math.max(2, Math.min(100, view.percent)),
        tone: "muted",
      };
    case "installing":
      return {
        kind: "wait",
        label: t("Installing…"),
        icon: RotateCw,
        motion: "spin",
        percent: 100,
        tone: "muted",
      };
    case "ready":
      return {
        kind: "install",
        label: t("Restart to update"),
        icon: RotateCw,
        motion: "pulse",
        percent: 100,
        tone: "brand",
      };
    case "checking":
      return {
        kind: "wait",
        label: t("Checking…"),
        icon: RotateCw,
        motion: "spin",
        percent: 0,
        tone: "muted",
      };
    case "error":
      return {
        kind: "retry",
        label: t("Retry"),
        icon: TriangleAlert,
        motion: "none",
        percent: 0,
        tone: "danger",
      };
    case "available":
      return {
        kind: "download",
        label: t("Download update"),
        icon: Download,
        motion: "none",
        percent: 0,
        tone: "brand",
      };
    default:
      return {
        kind: "check",
        label: t("Check for updates"),
        icon: RotateCw,
        motion: "none",
        percent: 0,
        tone: "muted",
      };
  }
}

/** Runs the step the button is currently offering. */
export function runUpdateAction(kind: UpdateActionKind): void {
  const { info, download, install, check } = useUpdate.getState();
  switch (kind) {
    case "download":
      void download();
      return;
    case "install":
      void install();
      return;
    // a failed download is retried from the file we already have the address
    // for; with no usable release in hand the only useful reply is a new check
    case "retry":
      if (info?.available) void download();
      else void check(true);
      return;
    case "check":
      void check(true);
      return;
    default:
      return;
  }
}

/** The tooltip on the header pill: one line explaining the current step. */
export function updateTip(view: UpdateView, t: Translate): string {
  switch (view.status) {
    case "downloading":
      return t("Downloading {percent}%", { percent: view.percent });
    case "installing":
      return t("Installing the update, the app will restart");
    case "ready":
      return t("Click to restart and install");
    case "error":
      return view.error ?? t("Update failed");
    case "checking":
      return t("Checking for updates…");
    case "available":
      return t("Click to download · {version}", {
        version: view.info ? `${view.info.latest} · ${formatSize(view.info.assetSize)}` : "",
      });
    default:
      return t("Check for updates");
  }
}

/** The line under the Settings → About button; null when there is nothing to say. */
export function updateDetail(view: UpdateView, t: Translate): string | null {
  switch (view.status) {
    case "checking":
      return t("Checking for updates…");
    case "downloading":
      return t("Downloading {percent}%", { percent: view.percent });
    case "installing":
      return t("Installing the update, the app will restart");
    case "ready":
      return view.installedTo
        ? t("Update downloaded. It will be installed in {path}.", { path: view.installedTo })
        : t("Update downloaded. Restart to finish installing.");
    case "error":
      return view.error ?? t("Update failed");
    case "available":
      return view.info
        ? t("Latest version {version} · {size}", {
            version: view.info.latest,
            size: formatSize(view.info.assetSize),
          })
        : null;
    case "uptodate":
      if (view.info && !view.info.hasRelease) return t("No published release yet");
      return view.version
        ? t("You're on the latest version ({version})", { version: view.version })
        : null;
    default:
      return null;
  }
}

export function formatSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
