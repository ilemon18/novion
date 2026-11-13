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

export type NotionSyncMode = "new_only" | "overwrite";
export type NotionSyncDirection = "push" | "pull" | "both";
export type NotionConflictPolicy = "ask" | "local" | "remote";
export type NotionConflictAction = "local" | "remote" | "both";

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

export interface NotionSyncOptions {
  includeCompleted: boolean;
  mode: NotionSyncMode;
  direction: NotionSyncDirection;
  conflictPolicy: NotionConflictPolicy;
}

/** A note both sides changed since the last sync. */
export interface NotionSyncConflict {
  docId: string;
  title: string;
  pageId: string;
  url: string;
}

export interface NotionConflictResolution {
  docId: string;
  action: NotionConflictAction;
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
  pagesSkipped: number;
  pagesPulled: number;
  pagesImported: number;
  conflicts: NotionSyncConflict[];
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
  path: string;
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

/** Thin typed wrapper around the Rust command surface. */
export const api = {
  root: () => invoke<string>("get_workspace_root"),
  /**
   * `language` only matters on the very first run, where it picks the welcome
   * note. No caller passes one: that note is English for everyone, so the app
   * opens the same way whatever the interface language happens to be.
   */
  ensure: (language?: string) => invoke<Workspace>("ensure_workspace", { language }),
  createFolder: (parentId: string | null, name: string) =>
    invoke<CreatedFolder>("create_folder", { parentId, name }),
  renameFolder: (id: string, name: string) => invoke<Workspace>("rename_folder", { id, name }),
  deleteFolder: (id: string) => invoke<Workspace>("delete_folder", { id }),
  createDoc: (parentId: string | null, title: string) =>
    invoke<CreatedDoc>("create_doc", { parentId, title }),
  renameDoc: (id: string, title: string) => invoke<Workspace>("rename_doc", { id, title }),
  deleteDoc: (id: string) => invoke<Workspace>("delete_doc", { id }),
  setCompleted: (id: string, completed: boolean) =>
    invoke<Workspace>("set_completed", { id, completed }),
  setPinned: (id: string, pinned: boolean) => invoke<Workspace>("set_pinned", { id, pinned }),
  restoreNode: (id: string) => invoke<Workspace>("restore_node", { id }),
  purgeNode: (id: string) => invoke<Workspace>("purge_node", { id }),
  emptyTrash: () => invoke<Workspace>("empty_trash"),
  searchDocs: (query: string) => invoke<SearchHit[]>("search_docs", { query }),
  getStorageState: () => invoke<StorageState>("get_storage_state"),
  setStorage: (target: StorageKind, mode: SwitchMode) =>
    invoke<SwitchResult>("set_storage", { target, mode }),
  revealStorageFolder: () => invoke<void>("reveal_storage_folder"),
  moveNode: (id: string, parentId: string | null, index: number) =>
    invoke<Workspace>("move_node", { id, parentId, index }),
  /** Replaces the tree with a previous snapshot (workspace-level undo/redo). */
  restoreWorkspace: (workspace: Workspace) =>
    invoke<Workspace>("restore_workspace", { workspace }),
  readDoc: (id: string) => invoke<DocFile>("read_doc", { id }),
  /**
   * `baseMtimeMs` is the file stamp the editor last saw. The backend refuses the
   * write with `doc_conflict` when the file moved on since then, so an iCloud
   * copy from another Mac is never silently overwritten.
   */
  saveDoc: (id: string, title: string, content: unknown, baseMtimeMs?: number, force?: boolean) =>
    invoke<SavedDoc>("save_doc", { id, title, content, baseMtimeMs, force }),
  duplicateDoc: (sourceId: string, title: string, content: unknown) =>
    invoke<CreatedDoc>("duplicate_doc", { sourceId, title, content }),
  docStamp: (id: string) => invoke<DocStamp>("doc_stamp", { id }),
  workspaceStamp: () => invoke<number>("workspace_stamp"),
  backlinks: (id: string) => invoke<Backlink[]>("backlinks_doc", { id }),
  saveAsset: (nameHint: string, dataBase64: string) =>
    invoke<AssetRef>("save_asset", { nameHint, dataBase64 }),
  deleteAsset: (rel: string) => invoke<void>("delete_asset", { rel }),
  listDir: (rel: string) => invoke<string[]>("list_dir", { rel }),
  /** Writes one document as md / html / json into ~/Downloads/Novion. */
  exportDoc: (id: string, format: ExportFormat) =>
    invoke<ExportResult>("export_doc", { id, format }),
  /** Full backup: byte-exact raw copy + a Markdown mirror of the whole tree. */
  exportWorkspace: () => invoke<ExportResult>("export_workspace"),
  /** Reveals an exported path in Finder (only under the export/workspace roots). */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  /** Native folder picker; `null` when the user cancelled. */
  pickImportFolder: () => invoke<string | null>("pick_import_folder"),
  importMarkdown: (source: string, parentId: string | null) =>
    invoke<ImportStats>("import_markdown", { source, parentId }),
  importMarkdownText: (name: string, text: string, parentId: string | null) =>
    invoke<ImportStats>("import_markdown_text", { name, text, parentId }),
  /** Markdown → TipTap document JSON, for pasting Markdown into a note. */
  parseMarkdownBody: (text: string) =>
    invoke<{ type: string; content?: unknown[] }>("parse_markdown_body", { text }),
  listDocVersions: (id: string) => invoke<DocVersionMeta[]>("list_doc_versions", { id }),
  readDocVersion: (id: string, ts: number) =>
    invoke<DocVersionBody>("read_doc_version", { id, ts }),
  /** Writes a snapshot now, ignoring the automatic 5-minute interval. */
  createDocVersion: (id: string) => invoke<DocVersionMeta>("create_doc_version", { id }),
  restoreDocVersion: (id: string, ts: number) =>
    invoke<DocFile>("restore_doc_version", { id, ts }),
  /** How many snapshots a document keeps (10 by default, 5–20 configurable). */
  getHistoryLimit: () => invoke<number>("get_history_limit"),
  setHistoryLimit: (limit: number) => invoke<number>("set_history_limit", { limit }),
  /** Automatic snapshots on save; turning it off keeps existing versions. */
  getHistoryEnabled: () => invoke<boolean>("get_history_enabled"),
  setHistoryEnabled: (enabled: boolean) =>
    invoke<boolean>("set_history_enabled", { enabled }),
  /** Hands an external link to the system browser (never navigates the webview). */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  notionGetState: () => invoke<NotionState>("notion_get_state"),
  notionConnect: (token: string) => invoke<NotionConnection>("notion_connect", { token }),
  notionDisconnect: () => invoke<NotionState>("notion_disconnect"),
  notionSetParent: (target: string) => invoke<NotionParent>("notion_set_parent", { target }),
  notionSync: (options: NotionSyncOptions) =>
    invoke<NotionSyncStats>("notion_sync_docs", { options }),
  notionResolveConflicts: (resolutions: NotionConflictResolution[]) =>
    invoke<NotionSyncStats>("notion_resolve_conflicts", { resolutions }),
  /** Newest GitHub release, compared with this build. */
  updateCheck: () => invoke<UpdateInfo>("update_check"),
  /** Streams the bundle into the app cache; resolves with its path. */
  updateDownload: (url: string, fileName: string, checksum: string) =>
    invoke<string>("update_download", { url, fileName, checksum }),
  /** Replaces the running bundle. On success the app quits and relaunches. */
  updateInstall: () => invoke<InstallOutcome>("update_install"),
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
  phase: "prepare" | "folders" | "docs" | "pull" | "import" | "images" | "done";
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
  const root = await getRoot();
  return convertFileSrc(`${root}/${rel}`);
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