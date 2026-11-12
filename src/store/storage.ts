import { create } from "zustand";
import {
  api,
  errorMessage,
  onStorageProgress,
  type StorageKind,
  type StorageProgress,
  type StorageState,
  type SwitchMode,
  type SwitchStats,
} from "@/lib/tauri";
import { saveQueue } from "@/lib/save-scheduler";
import { useWorkspace } from "@/store/workspace";

interface StorageStore {
  info: StorageState | null;
  loading: boolean;
  switching: boolean;
  progress: StorageProgress | null;
  error: string | null;
  load: () => Promise<void>;
  /** Switches the active root, then re-loads the workspace from it. */
  switchTo: (target: StorageKind, mode: SwitchMode) => Promise<SwitchStats | null>;
}

let unlisten: (() => void) | null = null;

export const useStorage = create<StorageStore>((set, get) => ({
  info: null,
  loading: false,
  switching: false,
  progress: null,
  error: null,

  load: async () => {
    // the app preloads this at boot; never run two probes at once
    if (get().loading) return;
    set({ loading: true });
    try {
      if (!unlisten) {
        unlisten = await onStorageProgress((progress) => {
          if (get().switching) set({ progress });
        });
      }
      const info = await api.getStorageState();
      set({ info, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
    }
  },

  switchTo: async (target, mode) => {
    set({ switching: true, progress: null, error: null });
    try {
      // never let an autosave land in the old root mid-switch
      await saveQueue.flushAll();
      const result = await api.setStorage(target, mode);

      useWorkspace.getState().adopt(result.workspace, result.root);
      window.dispatchEvent(new Event("novion:storage-changed"));

      const info = await api.getStorageState();
      set({ info, switching: false, progress: null });
      return result.stats;
    } catch (err) {
      set({ switching: false, progress: null, error: errorMessage(err) });
      return null;
    }
  },
}));
