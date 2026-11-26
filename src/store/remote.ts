import { create } from "zustand";
import {
  api,
  errorMessage,
  type RemoteHost,
  type RemoteStatus,
  type ShareStatus,
} from "@/lib/tauri";
import { useWorkspace } from "@/store/workspace";

interface RemoteStore {
  status: RemoteStatus | null;
  share: ShareStatus | null;
  hosts: RemoteHost[];
  loading: boolean;
  scanning: boolean;
  busy: boolean;
  error: string | null;

  load: () => Promise<void>;
  loadShare: () => Promise<void>;
  scan: () => Promise<void>;
  connect: (host: RemoteHost, code: string) => Promise<boolean>;
  connectManual: (host: string, port: number, code: string) => Promise<boolean>;
  reconnectSaved: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  forget: () => Promise<void>;
  ping: () => Promise<void>;

  startShare: () => Promise<void>;
  stopShare: () => Promise<void>;
  setSharePort: (port: number) => Promise<void>;
  setShareName: (name: string) => Promise<void>;
  newPairingCode: () => Promise<string | null>;
  revokeDevice: (id: string) => Promise<void>;
  clearError: () => void;
}

async function adoptRemote(status: RemoteStatus) {
  if (!status.connected || !status.rootPath) return;
  const workspace = await api.ensure();
  useWorkspace.getState().adopt(workspace, status.rootPath);
}

async function adoptLocal() {
  const [root, workspace] = await Promise.all([api.root(), api.ensure()]);
  useWorkspace.getState().adopt(workspace, root);
}

export const useRemote = create<RemoteStore>((set, get) => ({
  status: null,
  share: null,
  hosts: [],
  loading: true,
  scanning: false,
  busy: false,
  error: null,

  load: async () => {
    try {
      // Load the sharing side too: the host needs to know it is in shared mode
      // so an open document can refresh when a client writes to it.
      const [status, share] = await Promise.all([
        api.remoteGetState(),
        api.shareGetStatus().catch(() => null),
      ]);
      set({ status, share: share ?? get().share, loading: false, error: status.error ?? null });
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
    }
  },

  loadShare: async () => {
    try {
      const share = await api.shareGetStatus();
      set({ share });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  scan: async () => {
    set({ scanning: true, error: null });
    try {
      const hosts = await api.remoteScan();
      set({ hosts, scanning: false });
    } catch (err) {
      set({ scanning: false, error: errorMessage(err) });
    }
  },

  connect: async (host, code) => {
    set({ busy: true, error: null });
    try {
      const status = await api.remoteConnect({
        host: host.address,
        port: host.port,
        code: code.trim() || null,
        caPem: host.caPem,
        fingerprint: host.fingerprint,
      });
      await adoptRemote(status);
      set({ status, busy: false });
      return true;
    } catch (err) {
      const status = await api.remoteDisconnect().catch(() => null);
      set({ status, busy: false, error: errorMessage(err) });
      return false;
    }
  },

  connectManual: async (host, port, code) => {
    set({ busy: true, error: null });
    try {
      const status = await api.remoteConnect({
        host,
        port,
        code: code.trim() || null,
      });
      await adoptRemote(status);
      set({ status, busy: false });
      return true;
    } catch (err) {
      const status = await api.remoteDisconnect().catch(() => null);
      set({ status, busy: false, error: errorMessage(err) });
      return false;
    }
  },

  reconnectSaved: async () => {
    set({ busy: true, error: null });
    try {
      const status = await api.remoteConnectSaved();
      await adoptRemote(status);
      set({ status, busy: false });
      return true;
    } catch (err) {
      const status = await api.remoteDisconnect().catch(() => null);
      set({ status, busy: false, error: errorMessage(err) });
      return false;
    }
  },

  disconnect: async () => {
    set({ busy: true, error: null });
    try {
      const status = await api.remoteDisconnect();
      set({ status, busy: false });
      await adoptLocal();
    } catch (err) {
      set({ busy: false, error: errorMessage(err) });
    }
  },

  forget: async () => {
    set({ busy: true, error: null });
    try {
      const status = await api.remoteForget();
      set({ status, busy: false });
      await adoptLocal();
    } catch (err) {
      set({ busy: false, error: errorMessage(err) });
    }
  },

  ping: async () => {
    const wasConnected = !!get().status?.connected;
    if (!wasConnected) return;
    try {
      const status = await api.remotePing();
      set({ status, error: status.error ?? null });
      if (!status.connected) await adoptLocal();
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  startShare: async () => {
    set({ busy: true, error: null });
    try {
      const share = await api.shareStart();
      set({ share, busy: false });
      if (!share.pairingCode) {
        const code = await api.shareNewPairingCode();
        const next = await api.shareGetStatus();
        set({
          share: {
            ...next,
            pairingCode: code[0],
            pairingExpiresAt: code[1],
          },
        });
      }
    } catch (err) {
      set({ busy: false, error: errorMessage(err) });
    }
  },

  stopShare: async () => {
    set({ busy: true, error: null });
    try {
      const share = await api.shareStop();
      set({ share, busy: false });
    } catch (err) {
      set({ busy: false, error: errorMessage(err) });
    }
  },

  setSharePort: async (port) => {
    set({ busy: true, error: null });
    try {
      const share = await api.shareSetPort(port);
      set({ share, busy: false });
    } catch (err) {
      set({ busy: false, error: errorMessage(err) });
    }
  },

  setShareName: async (name) => {
    set({ busy: true, error: null });
    try {
      const share = await api.shareSetDeviceName(name);
      set({ share, busy: false });
    } catch (err) {
      set({ busy: false, error: errorMessage(err) });
    }
  },

  newPairingCode: async () => {
    try {
      const [code, expiresAt] = await api.shareNewPairingCode();
      const share = get().share;
      if (share) set({ share: { ...share, pairingCode: code, pairingExpiresAt: expiresAt } });
      return code;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    }
  },

  revokeDevice: async (id) => {
    try {
      const share = await api.shareRevokeDevice(id);
      set({ share });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  clearError: () => set({ error: null }),
}));
