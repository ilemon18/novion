import { create } from "zustand";
import {
  api,
  errorMessage,
  onNotionProgress,
  type NotionConflictResolution,
  type NotionConflictPolicy,
  type NotionProgress,
  type NotionState,
  type NotionSyncDirection,
  type NotionSyncMode,
  type NotionSyncStats,
} from "@/lib/tauri";
import { saveQueue } from "@/lib/save-scheduler";

interface NotionStore {
  info: NotionState | null;
  loading: boolean;
  connecting: boolean;
  resolving: boolean;
  syncing: boolean;
  progress: NotionProgress | null;
  error: string | null;
  lastStats: NotionSyncStats | null;
  load: () => Promise<void>;
  connect: (token: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  setParent: (target: string) => Promise<{ reset: boolean; title: string } | null>;
  sync: (
    mode: NotionSyncMode,
    includeCompleted: boolean,
    direction: NotionSyncDirection,
    conflictPolicy: NotionConflictPolicy,
  ) => Promise<NotionSyncStats | null>;
  resolveConflicts: (resolutions: NotionConflictResolution[]) => Promise<NotionSyncStats | null>;
  clearError: () => void;
  resetStats: () => void;
}

let unlisten: (() => void) | null = null;

export const useNotion = create<NotionStore>((set, get) => ({
  info: null,
  loading: false,
  connecting: false,
  resolving: false,
  syncing: false,
  progress: null,
  error: null,
  lastStats: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      if (!unlisten) {
        unlisten = await onNotionProgress((progress) => {
          if (get().syncing) set({ progress });
        });
      }
      const info = await api.notionGetState();
      set({ info, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
    }
  },

  connect: async (token) => {
    set({ connecting: true, error: null });
    try {
      const result = await api.notionConnect(token);
      set({ info: result.state, connecting: false });
      return true;
    } catch (err) {
      set({ connecting: false, error: errorMessage(err) });
      return false;
    }
  },

  disconnect: async () => {
    set({ connecting: true, error: null });
    try {
      const info = await api.notionDisconnect();
      set({ info, connecting: false, lastStats: null, progress: null });
    } catch (err) {
      set({ connecting: false, error: errorMessage(err) });
    }
  },

  setParent: async (target) => {
    set({ resolving: true, error: null });
    try {
      const result = await api.notionSetParent(target);
      set({ info: result.state, resolving: false });
      return { reset: result.reset, title: result.title };
    } catch (err) {
      set({ resolving: false, error: errorMessage(err) });
      return null;
    }
  },

  sync: async (mode, includeCompleted, direction, conflictPolicy) => {
    set({ syncing: true, progress: null, error: null, lastStats: null });
    try {
      // never push a stale snapshot: finish pending autosaves first
      await saveQueue.flushAll();
      const stats = await api.notionSync({
        mode,
        includeCompleted,
        direction,
        conflictPolicy,
      });
      const info = await api.notionGetState();
      set({ syncing: false, progress: null, lastStats: stats, info });

      // When nothing at all got through, the first failure is the run-level
      // reason (dead token, no permission, wrong target): show it as a banner.
      // It is language-independent, unlike matching on the message text.
      const attempted =
        stats.pagesCreated + stats.pagesUpdated + stats.pagesPulled + stats.pagesImported;
      if (attempted === 0 && stats.failures.length > 0) {
        set({ error: stats.failures[0].message });
      }
      return stats;
    } catch (err) {
      set({ syncing: false, progress: null, error: errorMessage(err) });
      return null;
    }
  },

  resolveConflicts: async (resolutions) => {
    set({ syncing: true, progress: null, error: null });
    try {
      await saveQueue.flushAll();
      const stats = await api.notionResolveConflicts(resolutions);
      const info = await api.notionGetState();
      set({ syncing: false, progress: null, lastStats: stats, info });
      return stats;
    } catch (err) {
      set({ syncing: false, progress: null, error: errorMessage(err) });
      return null;
    }
  },

  clearError: () => set({ error: null }),
  resetStats: () => set({ lastStats: null }),
}));
