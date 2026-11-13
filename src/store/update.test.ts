import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The update button is one control driving one state machine, so the state
 * machine is what has to be tested: click → download → progress → restart →
 * install, plus the paths that must not look like "nothing happened".
 *
 * The Tauri bridge, the save queue, the notice store and the translator are all
 * mocked: this file checks the transitions, not the platform.
 */
const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  updateCheck: vi.fn(),
  updateDownload: vi.fn(),
  updateInstall: vi.fn(),
  updateStartupReport: vi.fn(),
  updateRevealLog: vi.fn(),
  flushAll: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  api: {
    updateCheck: mocks.updateCheck,
    updateDownload: mocks.updateDownload,
    updateInstall: mocks.updateInstall,
    updateStartupReport: mocks.updateStartupReport,
    updateRevealLog: mocks.updateRevealLog,
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  onUpdateProgress: async () => () => undefined,
}));

vi.mock("@/lib/save-scheduler", () => ({ saveQueue: { flushAll: mocks.flushAll } }));

vi.mock("@/store/ui", () => ({ useUi: { getState: () => ({ notify: mocks.notify }) } }));

// the catalogue is keyed by English text, so a mocked `t` returns the key
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

import { useUpdate } from "./update";

const release = {
  available: true,
  hasRelease: true,
  current: "0.0.1",
  latest: "0.0.2",
  name: "v0.0.2",
  notes: "",
  pageUrl: "",
  publishedAt: "",
  assetName: "novion-macos-0.0.2.dmg",
  assetSize: 12_000_000,
  downloadUrl: "https://github.com/ilemon18/novion/releases/download/v0.0.2/x.dmg",
  checksum: "abc",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateDownload.mockResolvedValue("/cache/updates/x.dmg");
  mocks.updateStartupReport.mockResolvedValue(null);
  mocks.flushAll.mockResolvedValue(undefined);
  useUpdate.setState({
    status: "idle",
    manual: false,
    info: null,
    percent: 0,
    error: null,
    installedTo: "",
    logPath: "",
  });
});

afterEach(() => {
  // clears the "the app did not restart" timer
  useUpdate.getState().dismiss();
});

describe("the update flow behind the single button", () => {
  it("goes check → available → downloading → ready → installing", async () => {
    mocks.updateCheck.mockResolvedValue(release);
    mocks.updateInstall.mockResolvedValue({
      mode: "restart",
      path: "/cache/updates/x.dmg",
      installedTo: "/Applications/Novion.app",
      previous: "",
      logPath: "/logs/update.log",
    });

    await useUpdate.getState().check(true);
    expect(useUpdate.getState().status).toBe("available");

    await useUpdate.getState().download();
    expect(mocks.updateDownload).toHaveBeenCalledWith(release.downloadUrl, release.assetName, "abc");
    expect(useUpdate.getState().status).toBe("ready");
    expect(useUpdate.getState().percent).toBe(100);

    await useUpdate.getState().install();
    // the version the helper must verify travels with the click
    expect(mocks.updateInstall).toHaveBeenCalledWith("0.0.2");
    expect(useUpdate.getState().logPath).toBe("/logs/update.log");
    expect(useUpdate.getState().installedTo).toBe("/Applications/Novion.app");
  });

  it("cannot install before the file is complete", async () => {
    await useUpdate.getState().install();
    expect(mocks.updateInstall).not.toHaveBeenCalled();
  });

  it("reports a failed download as a retryable error", async () => {
    mocks.updateCheck.mockResolvedValue(release);
    mocks.updateDownload.mockRejectedValue(
      Object.assign(new Error("断网了"), { code: "update_network" }),
    );

    await useUpdate.getState().check(true);
    await useUpdate.getState().download();

    expect(useUpdate.getState().status).toBe("error");
    expect(useUpdate.getState().error).toBe("断网了");
    expect(mocks.notify).toHaveBeenCalled();
  });

  it("keeps a ready download when a silent check runs", async () => {
    mocks.updateCheck.mockResolvedValue(release);
    await useUpdate.getState().check(true);
    await useUpdate.getState().download();

    await useUpdate.getState().check(false);
    expect(useUpdate.getState().status).toBe("ready");
    expect(mocks.updateCheck).toHaveBeenCalledTimes(1);
  });

  it("says so when the repository has no release at all", async () => {
    mocks.updateCheck.mockResolvedValue({ ...release, available: false, hasRelease: false });

    await useUpdate.getState().check(true);
    expect(useUpdate.getState().status).toBe("uptodate");
    expect(mocks.notify).toHaveBeenCalledWith("No published release yet");
  });

  it("falls back to the file manager when the bundle cannot be replaced", async () => {
    mocks.updateCheck.mockResolvedValue(release);
    mocks.updateInstall.mockResolvedValue({
      mode: "manual",
      path: "/cache/updates/x.dmg",
      installedTo: "",
      previous: "",
      logPath: "/logs/update.log",
    });

    await useUpdate.getState().check(true);
    await useUpdate.getState().download();
    await useUpdate.getState().install();

    // "manual" means the app keeps running on the old build, so the button must
    // stay usable instead of sitting on "installing" forever
    expect(useUpdate.getState().status).toBe("available");
  });
});
