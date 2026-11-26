import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ERROR_MESSAGES } from "@/i18n/errors";
import { t } from "@/i18n";

export type NodeKind = "folder" | "doc";
export type BuiltinFolder = "completed" | "trash";

export interface TreeNode {
  id: string;
  kind: NodeKind;
  name: string;
  parentId: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
  /** set for the two system folders (已归档 / 回收站) */
  builtin?: BuiltinFolder;
  /** parent before the node was archived; "" = workspace root */
  originParent?: string;
  completedAt?: number;
  trashedAt?: number;
  pinnedAt?: number;
}

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  titleMatch: boolean;
  updatedAt: number;
}

/** What the open document looks like on disk right now. */
export interface DocStamp {
  mtimeMs: number;
  exists: boolean;
}

/** Result of a save, so the client can keep its stamp in sync. */
export interface SavedDoc {
  updatedAt: number;
  mtimeMs: number;
}

export interface Backlink {
  id: string;
  title: string;
  context: string;
}

export interface ImportStats {
  docs: number;
  folders: number;
  assets: number;
  skipped: number;
  failed: number;
  targetName: string;
  messages: string[];
  /** documents created from JSON that was not a Novion document (kept as text) */
  plainText: number;
}

export type StorageKind = "local" | "icloud";
export type SwitchMode = "merge" | "keep_local" | "use_target";

export interface StorageState {
  storage: StorageKind;
  activeRoot: string;
  localRoot: string;
  icloudRoot: string;
  /** macOS only: false on Windows, where the iCloud card is hidden. */
  icloudSupported: boolean;
  icloudAvailable: boolean;
  localReady: boolean;
  icloudReady: boolean;
  localDocs: number;
  icloudDocs: number;
}

export interface SwitchStats {
  docsCopied: number;
  docsMerged: number;
  copiesRenamed: number;
  assetsCopied: number;
  backupPath?: string | null;
}

export interface SwitchResult {
  storage: StorageKind;
  root: string;
  workspace: Workspace;
  stats: SwitchStats;
}

export interface Workspace {
  version: number;
  updatedAt: number;
  nodes: TreeNode[];
}

export interface DocFile {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
  content: unknown;
}

export interface AssetRef {
  rel: string;
  abs: string;
}

export interface NotionState {
  connected: boolean;
  /** last 4 characters only */
  tokenTail: string;
  workspaceName: string;
  botName: string;
  parentPageId: string;
  parentPageTitle: string;
  parentUrl: string;
  syncedDocs: number;
  syncedFolders: number;
  lastSyncAt: number;
}


export type ClientPermission = "readonly" | "readwrite";

export interface PairedDevice {
  id: string;
  name: string;
  permission: ClientPermission;
  createdAt: number;
  lastSeenAt: number;
}

export interface ShareStatus {
  running: boolean;
  port: number;
  addresses: string[];
  hostId: string;
  deviceName: string;
  fingerprint: string;
  paired: PairedDevice[];
  pairingCode?: string | null;
  pairingExpiresAt?: number | null;
  discoveryError?: string | null;
}

export interface RemoteHost {
  hostId: string;
  hostName: string;
  address: string;
  port: number;
  fingerprint: string;
  caPem: string;
  protocol: number;
  workspaceName: string;
}

export interface SavedConnection {
  hostId: string;
  hostName: string;
  host: string;
  port: number;
  workspaceName: string;
  fingerprint: string;
}

export interface RemoteStatus {
  connected: boolean;
  hostId?: string | null;
  hostName?: string | null;
  workspaceName?: string | null;
  rootPath?: string | null;
  assetBase?: string | null;
  latencyMs?: number | null;
  protocol?: number | null;
  error?: string | null;
  saved?: SavedConnection | null;
}

export interface RemoteTargetInput {
  host?: string | null;
  port?: number | null;
  code?: string | null;
  caPem?: string | null;
  fingerprint?: string | null;
}

export interface McpStatus {
  running: boolean;
  host: string;
  port: number;
  endpoint: string;
  token: string;
  requireToken: boolean;
}

export interface NotionConnection {
  state: NotionState;
  workspaceName: string;
  botName: string;
}

export interface NotionParent {
  id: string;
  title: string;
  url: string;
  /** target changed → the previous page mapping was discarded */
  reset: boolean;
  state: NotionState;
}

export interface NotionSyncFailure {
  docId: string;
  title: string;
  message: string;
}

export interface NotionSyncStats {
  foldersCreated: number;
  pagesCreated: number;
  pagesUpdated: number;
  pagesVerified: number;
  pagesRestored: number;
  pagesTrashed: number;
  foldersRestored: number;
  foldersTrashed: number;
  imagesUploaded: number;
  imagesFailed: number;
  failures: NotionSyncFailure[];
  lastSyncAt: number;
  parentUrl: string;
}

export interface CreatedDoc {
  workspace: Workspace;
  docId: string;
}

export interface CreatedFolder {
  workspace: Workspace;
  folderId: string;
}

/** What GitHub says about the newest published release. */
export interface UpdateInfo {
  available: boolean;
  /** false when GitHub has no published release for the repository yet */
  hasRelease: boolean;
  current: string;
  latest: string;
  name: string;
  notes: string;
  pageUrl: string;
  publishedAt: string;
  assetName: string;
  assetSize: number;
  downloadUrl: string;
  /** SHA-256 from the release manifest, empty on releases without one */
  checksum: string;
}

export interface UpdateProgress {
  received: number;
  total: number;
  /** 0–100, 0 while the server has not sent a content length */
  percent: number;
  done: boolean;
}

export interface InstallOutcome {
  /** "restart": the bundle is replaced and the app relaunches itself;
   *  "manual": the download was revealed in the file manager instead */
  mode: "restart" | "manual";
  /** the downloaded bundle */
  path: string;
  /** the `.app` that will hold the update; empty for "manual" */
  installedTo: string;
  /** where this build runs from, when the update lands somewhere else */
  previous: string;
}

/** What the launch after an install attempt can say about it. */
export interface UpdateReport {
  /** version the helper was asked to install */
  attempted: string;
  /** version running now */
  current: string;
  /** false when the swap did not take: this launch is still the old build */
  ok: boolean;
  installedTo: string;
  previous: string;
}

export type ExportFormat = "md" | "html" | "json";

export interface ExportResult {
  /** file for a single document, folder for a workspace backup */
  path: string;
  files: number;
  bytes: number;
  assets: number;
  format: string;
}

export interface DocVersionMeta {
  ts: number;
  title: string;
  bytes: number;
  /** non-whitespace characters */
  words: number;
  preview: string;
}

export interface DocVersionBody {
  ts: number;
  title: string;
  createdAt: number;
  content: unknown;
}

let remoteSession: RemoteStatus | null = null;

function remoteUnsupported() {
  return Object.assign(new Error(t("This action is unavailable while connected to a remote workspace.")), {
    code: "remote_unsupported",
  });
}

export function setRemoteSession(status: RemoteStatus | null): void {
  remoteSession = status?.connected ? status : null;
  rootCache = null;
}

export function isRemoteSession(): boolean {
  return remoteSession !== null;
}

function workspaceInvoke<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  if (remoteSession) return invoke<T>("remote_call", { name, args });
  return invoke<T>(name, args);
}

/** Thin typed wrapper around the Rust command surface. */
export const api = {
  root: async () => remoteSession?.rootPath ?? invoke<string>("get_workspace_root"),
  /**
   * `language` only matters on the very first run, where it picks the welcome
   * note. No caller passes one: that note is English for everyone, so the app
   * opens the same way whatever the interface language happens to be.
   */
  ensure: (language?: string) => workspaceInvoke<Workspace>("ensure_workspace", { language }),
  createFolder: (parentId: string | null, name: string) =>
    workspaceInvoke<CreatedFolder>("create_folder", { parentId, name }),
  renameFolder: (id: string, name: string) => workspaceInvoke<Workspace>("rename_folder", { id, name }),
  deleteFolder: (id: string) => workspaceInvoke<Workspace>("delete_folder", { id }),
  createDoc: (parentId: string | null, title: string) =>
    workspaceInvoke<CreatedDoc>("create_doc", { parentId, title }),
  renameDoc: (id: string, title: string) => workspaceInvoke<Workspace>("rename_doc", { id, title }),
  deleteDoc: (id: string) => workspaceInvoke<Workspace>("delete_doc", { id }),
  setCompleted: (id: string, completed: boolean) =>
    workspaceInvoke<Workspace>("set_completed", { id, completed }),
  setPinned: (id: string, pinned: boolean) => workspaceInvoke<Workspace>("set_pinned", { id, pinned }),
  restoreNode: (id: string) => workspaceInvoke<Workspace>("restore_node", { id }),
  purgeNode: (id: string) => workspaceInvoke<Workspace>("purge_node", { id }),
  emptyTrash: () => workspaceInvoke<Workspace>("empty_trash"),
  searchDocs: (query: string) => workspaceInvoke<SearchHit[]>("search_docs", { query }),
  getStorageState: () => invoke<StorageState>("get_storage_state"),
  setStorage: (target: StorageKind, mode: SwitchMode) => {
    if (remoteSession) return Promise.reject(remoteUnsupported());
    return invoke<SwitchResult>("set_storage", { target, mode });
  },
  revealStorageFolder: () => {
    if (remoteSession) return Promise.reject(remoteUnsupported());
    return invoke<void>("reveal_storage_folder");
  },
  moveNode: (id: string, parentId: string | null, index: number) =>
    workspaceInvoke<Workspace>("move_node", { id, parentId, index }),
  /** Replaces the tree with a previous snapshot (workspace-level undo/redo). */
  restoreWorkspace: (workspace: Workspace) =>
    workspaceInvoke<Workspace>("restore_workspace", { workspace }),
  readDoc: (id: string) => workspaceInvoke<DocFile>("read_doc", { id }),
  /**
   * `baseMtimeMs` is the file stamp the editor last saw. The backend refuses the
   * write with `doc_conflict` when the file moved on since then, so an iCloud
   * copy from another Mac is never silently overwritten.
   */
  saveDoc: (id: string, title: string, content: unknown, baseMtimeMs?: number, force?: boolean) =>
    workspaceInvoke<SavedDoc>("save_doc", { id, title, content, baseMtimeMs, force }),
  duplicateDoc: (sourceId: string, title: string, content: unknown) =>
    workspaceInvoke<CreatedDoc>("duplicate_doc", { sourceId, title, content }),
  docStamp: (id: string) => workspaceInvoke<DocStamp>("doc_stamp", { id }),
  workspaceStamp: () => workspaceInvoke<number>("workspace_stamp"),
  backlinks: (id: string) => workspaceInvoke<Backlink[]>("backlinks_doc", { id }),
  saveAsset: (nameHint: string, dataBase64: string) =>
    workspaceInvoke<AssetRef>("save_asset", { nameHint, dataBase64 }),
  deleteAsset: (rel: string) => workspaceInvoke<void>("delete_asset", { rel }),
  listDir: (rel: string) => workspaceInvoke<string[]>("list_dir", { rel }),
  /** Writes one document as md / html / json into ~/Downloads/Novion. */
  exportDoc: (id: string, format: ExportFormat) => {
    if (remoteSession) return Promise.reject(remoteUnsupported());
    return invoke<ExportResult>("export_doc", { id, format });
  },
  /** Full backup: byte-exact raw copy + a Markdown mirror of the whole tree. */
  exportWorkspace: () => {
    if (remoteSession) return Promise.reject(remoteUnsupported());
    return invoke<ExportResult>("export_workspace");
  },
  /** Reveals an exported path in Finder (only under the export/workspace roots). */
  revealPath: (path: string) => {
    if (remoteSession) return Promise.reject(remoteUnsupported());
    return invoke<void>("reveal_path", { path });
  },
  /** Native folder picker; `null` when the user cancelled. */
  pickImportFolder: () => {
    if (remoteSession) return Promise.reject(remoteUnsupported());
    return invoke<string | null>("pick_import_folder");
  },
  importMarkdown: (source: string, parentId: string | null) => {
    if (remoteSession) return Promise.reject(remoteUnsupported());
    return invoke<ImportStats>("import_markdown", { source, parentId });
  },
  importMarkdownText: (name: string, text: string, parentId: string | null) => {
    if (remoteSession) return Promise.reject(remoteUnsupported());
    return invoke<ImportStats>("import_markdown_text", { name, text, parentId });
  },
  /**
   * A dropped document JSON (as written by {@link exportDoc}). Text that is not a
   * Novion document still becomes one document, with the raw text kept.
   */
  importJsonText: (name: string, text: string, parentId: string | null) => {
    if (remoteSession) return Promise.reject(remoteUnsupported());
    return invoke<ImportStats>("import_json_text", { name, text, parentId });
  },
  /** Markdown → TipTap document JSON, for pasting Markdown into a note. */
  parseMarkdownBody: (text: string) =>
    invoke<{ type: string; content?: unknown[] }>("parse_markdown_body", { text }),
  listDocVersions: (id: string) => workspaceInvoke<DocVersionMeta[]>("list_doc_versions", { id }),
  readDocVersion: (id: string, ts: number) =>
    workspaceInvoke<DocVersionBody>("read_doc_version", { id, ts }),
  /** Writes a snapshot now, ignoring the automatic 5-minute interval. */
  createDocVersion: (id: string) => workspaceInvoke<DocVersionMeta>("create_doc_version", { id }),
  restoreDocVersion: (id: string, ts: number) =>
    workspaceInvoke<DocFile>("restore_doc_version", { id, ts }),
  /** How many snapshots a document keeps (10 by default, 5–20 configurable). */
  getHistoryLimit: () => invoke<number>("get_history_limit"),
  setHistoryLimit: (limit: number) => invoke<number>("set_history_limit", { limit }),
  /** Automatic snapshots on save; turning it off keeps existing versions. */
  getHistoryEnabled: () => invoke<boolean>("get_history_enabled"),
  setHistoryEnabled: (enabled: boolean) =>
    invoke<boolean>("set_history_enabled", { enabled }),
  shareGetStatus: () => invoke<ShareStatus>("share_get_status"),
  shareSetPort: (port: number) => invoke<ShareStatus>("share_set_port", { port }),
  shareSetDeviceName: (name: string) =>
    invoke<ShareStatus>("share_set_device_name", { name }),
  shareStart: () => invoke<ShareStatus>("share_start"),
  shareStop: () => invoke<ShareStatus>("share_stop"),
  shareNewPairingCode: () =>
    invoke<[string, number]>("share_new_pairing_code"),
  shareRevokeDevice: (id: string) => invoke<ShareStatus>("share_revoke_device", { id }),
  remoteScan: () => invoke<RemoteHost[]>("remote_scan"),
  remoteGetState: async () => {
    const status = await invoke<RemoteStatus>("remote_get_state");
    setRemoteSession(status);
    return status;
  },
  remoteConnect: async (target: RemoteTargetInput) => {
    const status = await invoke<RemoteStatus>("remote_connect", { target });
    setRemoteSession(status);
    return status;
  },
  remoteConnectSaved: async () => {
    const status = await invoke<RemoteStatus>("remote_connect_saved");
    setRemoteSession(status);
    return status;
  },
  remoteDisconnect: async () => {
    const status = await invoke<RemoteStatus>("remote_disconnect");
    setRemoteSession(status);
    return status;
  },
  remoteForget: async () => {
    const status = await invoke<RemoteStatus>("remote_forget");
    setRemoteSession(status);
    return status;
  },
  remotePing: async () => {
    const status = await invoke<RemoteStatus>("remote_ping");
    setRemoteSession(status);
    return status;
  },
  mcpGetStatus: () => invoke<McpStatus>("mcp_get_status"),
  mcpSetPort: (port: number) => invoke<McpStatus>("mcp_set_port", { port }),
  mcpSetRequireToken: (required: boolean) =>
    invoke<McpStatus>("mcp_set_require_token", { required }),
  mcpRotateToken: () => invoke<McpStatus>("mcp_rotate_token"),
  mcpStart: () => invoke<McpStatus>("mcp_start"),
  mcpStop: () => invoke<McpStatus>("mcp_stop"),
  /** Hands an external link to the system browser (never navigates the webview). */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  notionGetState: () => invoke<NotionState>("notion_get_state"),
  notionConnect: (token: string) => invoke<NotionConnection>("notion_connect", { token }),
  notionDisconnect: () => invoke<NotionState>("notion_disconnect"),
  notionSetParent: (target: string) => invoke<NotionParent>("notion_set_parent", { target }),
  notionSync: () => invoke<NotionSyncStats>("notion_sync_docs"),
  /**
   * Newest GitHub release, compared with this build.
   *
   * `deep` is for a check the user asked for: it lets the backend consult the
   * release list when `latest.json` offers nothing, which is the only way to
   * notice a newer release hiding behind an older "latest" pointer. Startup
   * checks leave it off, so they stay quota-free.
   */
  updateCheck: (deep = false) => invoke<UpdateInfo>("update_check", { deep }),
  /** Streams the bundle into the app cache; resolves with its path. */
  updateDownload: (url: string, fileName: string, checksum: string) =>
    invoke<string>("update_download", { url, fileName, checksum }),
  /** Replaces the running bundle. On success the app quits and relaunches. */
  updateInstall: (version: string) => invoke<InstallOutcome>("update_install", { version }),
  /** Reads (and clears) the marker an install attempt leaves behind. */
  updateStartupReport: () => invoke<UpdateReport | null>("update_startup_report"),
};

let rootCache: string | null = null;

export interface StorageProgress {
  phase: "copy" | "merge";
  done: number;
  total: number;
}

/** Subscribes to copy/merge progress emitted while switching storage. */
export async function onStorageProgress(
  cb: (progress: StorageProgress) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<StorageProgress>("storage:progress", (event) => cb(event.payload));
}

export interface NotionProgress {
  phase: "folders" | "docs" | "done";
  done: number;
  total: number;
  current: string;
}

/** Subscribes to per-document progress emitted while pushing to Notion. */
export async function onNotionProgress(
  cb: (progress: NotionProgress) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<NotionProgress>("notion:progress", (event) => cb(event.payload));
}

/** Subscribes to download progress for an in-app update. */
export async function onUpdateProgress(
  cb: (progress: UpdateProgress) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<UpdateProgress>("update:progress", (event) => cb(event.payload));
}

export async function getRoot(): Promise<string> {
  if (rootCache) return rootCache;
  rootCache = await api.root();
  return rootCache;
}

/** Convert a repo-relative asset path (`assets/x.png`) into a webview-safe URL. */
export async function assetUrl(rel: string): Promise<string> {
  if (/^(https?:|data:|blob:|asset:)/.test(rel)) return rel;
  if (remoteSession?.assetBase) {
    return `${remoteSession.assetBase.replace(/\/+$/, "")}/${rel.replace(/^\.?[\\/]/, "")}`;
  }
  const root = await getRoot();
  return convertFileSrc(`${root}/${rel}`);
}

export function remoteAssetBase(): string | null {
  return remoteSession?.assetBase ?? null;
}

/**
 * Reads a blob as raw base64, in independent chunks.
 *
 * `readAsDataURL` keeps the whole data-URL string *and* the sliced base64 body
 * alive at once, so a 30 MB image peaked at roughly three times its size in the
 * webview heap right before the payload was handed to Rust. Encoding 32 KB
 * slices into one output string avoids the second full copy.
 */
export function fileToBase64(file: File | Blob): Promise<string> {
  // a multiple of 3, so every chunk base64-encodes independently
  const CHUNK = 32 * 1024 * 3;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(t("Failed to read the file")));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      const parts: string[] = [];
      for (let at = 0; at < bytes.length; at += CHUNK) {
        const slice = bytes.subarray(at, at + CHUNK);
        // `btoa` needs a binary string; converting in 4 KB batches keeps the
        // intermediate strings small and the conversion native-fast
        let binary = "";
        for (let i = 0; i < slice.length; i += 4096) {
          binary += String.fromCharCode(...slice.subarray(i, i + 4096));
        }
        parts.push(btoa(binary));
      }
      resolve(parts.join(""));
    };
    reader.readAsArrayBuffer(file);
  });
}

export function errorMessage(err: unknown): string {
  if (!err) return t("Unknown error");
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const anyErr = err as Record<string, unknown>;
    // a structured backend error: translate the stable code, not the message
    if (typeof anyErr.code === "string" && anyErr.code in ERROR_MESSAGES) {
      return t(ERROR_MESSAGES[anyErr.code]);
    }
    if (typeof anyErr.message === "string") return anyErr.message;
    if (typeof anyErr.error === "string") return anyErr.error;
    if (anyErr.error) return errorMessage(anyErr.error);
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
