use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Runtime};

use crate::assets;
use crate::atomic::{read_json, write_json_atomic};
use crate::error::{AppError, AppResult};
use crate::models::{empty_doc, now_ms, DocFile};
use crate::paths::{workspace_root, Paths};
use crate::workspace;

/// What the save path needs to know about the file it is about to overwrite.
///
/// Reading and parsing the previous body on every autosave used to cost a full
/// JSON decode per keystroke burst. The values below are stable across saves
/// (`created_at` never changes, the asset refs only change when the body does),
/// so they are cached and validated against the file's size and mtime.
struct DocMeta {
    created_at: u64,
    /// assets referenced by the body that is currently on disk
    asset_refs: Vec<String>,
    len: u64,
    mtime_ms: u64,
}

static META_CACHE: OnceLock<Mutex<MetaCache>> = OnceLock::new();

/// Upper bound on rememberd documents. Each entry is a `created_at` plus the
/// asset refs of one file, so the cap is about keeping a long-running app from
/// accumulating an entry per document ever opened.
const MAX_META_ENTRIES: usize = 512;

#[derive(Default)]
struct MetaCache {
    entries: HashMap<String, DocMeta>,
    /// insertion order, oldest first
    order: std::collections::VecDeque<String>,
}

impl MetaCache {
    fn insert(&mut self, key: String, meta: DocMeta) {
        if self.entries.insert(key.clone(), meta).is_none() {
            self.order.push_back(key);
        }
        while self.entries.len() > MAX_META_ENTRIES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
        }
        // drop stale keys that were replaced before they reached the front
        self.order.retain(|key| self.entries.contains_key(key));
    }
}

fn meta_cache() -> &'static Mutex<MetaCache> {
    META_CACHE.get_or_init(|| Mutex::new(MetaCache::default()))
}

/// Ids are unique per workspace but repeat across the local and the iCloud
/// root, so the cache key has to carry the root as well.
fn cache_key(paths: &Paths, id: &str) -> String {
    format!("{}/{id}", paths.root.display())
}

fn file_stamp(meta: &std::fs::Metadata) -> (u64, u64) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (mtime, meta.len())
}

/// Cached metadata for `id`, but only when the file on disk still matches what
/// was recorded. Returns `None` when the file changed behind our back (iCloud
/// sync, hand edit, restore) so the caller re-reads it.
fn cached_meta(paths: &Paths, id: &str, len: u64, mtime_ms: u64) -> Option<(u64, Vec<String>)> {
    let map = meta_cache().lock().ok()?;
    let entry = map.entries.get(&cache_key(paths, id))?;
    if entry.len == len && entry.mtime_ms == mtime_ms {
        Some((entry.created_at, entry.asset_refs.clone()))
    } else {
        None
    }
}

fn remember_meta(paths: &Paths, id: &str, meta: DocMeta) {
    if let Ok(mut map) = meta_cache().lock() {
        map.insert(cache_key(paths, id), meta);
    }
}

/// What the client needs to notice that a file changed behind its back.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocStamp {
    /// file mtime in ms; `0` when the file does not exist yet
    pub mtime_ms: u64,
    pub exists: bool,
}

/// Result of a successful save, so the client can keep its stamp in sync.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDoc {
    pub updated_at: u64,
    pub mtime_ms: u64,
}

async fn stamp_of(file: &std::path::Path) -> DocStamp {
    let Ok(meta) = tokio::fs::metadata(file).await else {
        return DocStamp {
            mtime_ms: 0,
            exists: false,
        };
    };
    // mtime only: the poll runs every few seconds and must never decode a body
    DocStamp {
        mtime_ms: file_stamp(&meta).0,
        exists: true,
    }
}

/// Cheap "did this file change?" probe, polled by the UI for the open document.
#[tauri::command]
pub async fn doc_stamp<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<DocStamp> {
    let paths = Paths::new(workspace_root(&app)?);
    let file = paths.doc_file(&id)?;
    Ok(stamp_of(&file).await)
}

/// mtime of `workspace.json`: when another device added or removed a note, the
/// tree in the sidebar has to be refreshed without restarting the app.
#[tauri::command]
pub async fn workspace_stamp<R: Runtime>(app: AppHandle<R>) -> AppResult<u64> {
    let paths = Paths::new(workspace_root(&app)?);
    Ok(stamp_of(&paths.workspace_file()).await.mtime_ms)
}

/// Reads one document; a missing file materialises an empty doc so the UI can
/// recover from a partially copied workspace without an error dialog.
#[tauri::command]
pub async fn read_doc<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<DocFile> {
    let paths = Paths::new(workspace_root(&app)?);
    paths.ensure_dirs().await?;
    let file = paths.doc_file(&id)?;

    if tokio::fs::try_exists(&file).await.unwrap_or(false) {
        if let Ok(doc) = read_json::<DocFile>(&file).await {
            // warm the save path: the next write already knows the file
            if let Ok(meta) = tokio::fs::metadata(&file).await {
                let (mtime_ms, len) = file_stamp(&meta);
                remember_meta(
                    &paths,
                    &id,
                    DocMeta {
                        created_at: doc.created_at,
                        asset_refs: assets::collect_asset_refs(&doc.content),
                        len,
                        mtime_ms,
                    },
                );
            }
            return Ok(doc);
        }
    }

    let node = workspace::load_shared(&paths)
        .await
        .ok()
        .and_then(|ws| ws.nodes.iter().find(|n| n.id == id).cloned());
    let now = now_ms();
    Ok(DocFile {
        id,
        title: node.as_ref().map(|n| n.name.clone()).unwrap_or_default(),
        created_at: node.map(|n| n.created_at).unwrap_or(now),
        updated_at: now,
        schema_version: 1,
        content: empty_doc(),
    })
}

/// Writes one document.
///
/// `base_mtime_ms` is the mtime the client last saw for this file. When the file
/// on disk has moved on since then (iCloud pulled a newer copy from another Mac,
/// or the workspace was edited outside the app) the write is refused with the
/// `doc_conflict` code instead of silently overwriting the other version.
/// `force` is what the user picks in that dialog ("keep mine").
#[tauri::command]
pub async fn save_doc<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    title: String,
    content: serde_json::Value,
    base_mtime_ms: Option<u64>,
    force: Option<bool>,
) -> AppResult<SavedDoc> {
    let paths = Paths::new(workspace_root(&app)?);
    let file = paths.doc_file(&id)?;
    let now = now_ms();

    let stamp = match tokio::fs::metadata(&file).await {
        Ok(meta) => Some(file_stamp(&meta)),
        Err(_) => None,
    };

    if force != Some(true) {
        if let (Some(base), Some((disk_mtime, _))) = (base_mtime_ms, stamp) {
            // sub-millisecond drift happens on some file systems: only a real
            // move counts as somebody else's write
            if base != 0 && disk_mtime.saturating_sub(base) > 1 {
                return Err(AppError::new(
                    "doc_conflict",
                    "这篇文档在磁盘上已被修改（可能来自另一台电脑）。为避免覆盖，保存已暂停。",
                ));
            }
        }
    }
    let known = stamp.and_then(|(mtime_ms, len)| cached_meta(&paths, &id, len, mtime_ms));

    // The outgoing body only has to be parsed when we cannot describe it from
    // the cache, or when a version snapshot of it is actually due.
    let has_file = stamp.is_some();
    let history_on = crate::config::history_enabled(&app);
    // With history off we still read the outgoing body on a cold cache: it also
    // carries `created_at`, which must not be reset to "now" on the next save.
    let want_previous =
        has_file && (known.is_none() || (history_on && crate::history::snapshot_due(&paths, &id).await));
    let previous = if want_previous {
        read_json::<DocFile>(&file).await.ok()
    } else {
        None
    };

    let created_at = previous
        .as_ref()
        .map(|d| d.created_at)
        .or_else(|| known.as_ref().map(|(created_at, _)| *created_at))
        .unwrap_or(now);

    // keep a rolling history of what is about to be overwritten; a failure here
    // must never block the actual save
    if history_on {
        if let Some(previous) = &previous {
            let limit = crate::config::history_limit(&app);
            if let Err(err) = crate::history::snapshot(&paths, previous, false, limit).await {
                eprintln!("[novion] history snapshot failed for {id}: {err}");
            }
        }
    }

    let doc = DocFile {
        id: id.clone(),
        title,
        created_at,
        updated_at: now,
        schema_version: 1,
        content,
    };
    write_json_atomic(&file, &doc).await?;

    let doc_refs = assets::collect_asset_refs(&doc.content);

    // images dropped from the body are deleted from assets/ once the document
    // is safely on disk (so undo never races a premature delete)
    let previous_refs = previous
        .as_ref()
        .map(|d| assets::collect_asset_refs(&d.content))
        .or_else(|| known.map(|(_, refs)| refs));
    if let Some(previous_refs) = previous_refs {
        if !previous_refs.is_empty() {
            let removed: Vec<String> = previous_refs
                .into_iter()
                .filter(|rel| !doc_refs.contains(rel))
                .collect();
            if !removed.is_empty() {
                let still_used = assets::refs_used_elsewhere(&paths, &doc.id).await;
                let deletable: Vec<String> = removed
                    .into_iter()
                    .filter(|rel| !still_used.contains(rel))
                    .collect();
                assets::remove_assets(&paths, &deletable).await;
            }
        }
    }

    // remember what is on disk now so the next save can skip the parse
    if let Ok(meta) = tokio::fs::metadata(&file).await {
        let (mtime_ms, len) = file_stamp(&meta);
        remember_meta(
            &paths,
            &id,
            DocMeta {
                created_at,
                asset_refs: doc_refs,
                len,
                mtime_ms,
            },
        );
    }

    Ok(SavedDoc {
        updated_at: now,
        mtime_ms: tokio::fs::metadata(&file)
            .await
            .map(|meta| file_stamp(&meta).0)
            .unwrap_or(0),
    })
}

/// Copies a document into a brand new one (used by "keep both versions" when a
/// save conflicts with an edit from another device).
#[tauri::command]
pub async fn duplicate_doc<R: Runtime>(
    app: AppHandle<R>,
    source_id: String,
    title: String,
    content: serde_json::Value,
) -> AppResult<crate::models::CreatedDoc> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = crate::workspace::load(&paths).await?;

    let parent_id = ws
        .nodes
        .iter()
        .find(|n| n.id == source_id)
        .and_then(|n| n.parent_id.clone());
    let order = ws
        .nodes
        .iter()
        .filter(|n| n.parent_id == parent_id)
        .map(|n| n.order)
        .max()
        .map(|o| o + 1)
        .unwrap_or(0);

    let now = now_ms();
    let id = format!("d_{}", crate::paths::short_id());
    let name = if title.trim().is_empty() {
        "Untitled".to_string()
    } else {
        title.trim().chars().take(160).collect()
    };
    let node = crate::models::Node::new(
        id.clone(),
        crate::models::NodeKind::Doc,
        name.clone(),
        parent_id.clone(),
        order,
    );
    ws.nodes.push(node);
    ws.updated_at = now;
    crate::workspace::save(&paths, &ws).await?;

    let doc = DocFile {
        id: id.clone(),
        title: name,
        created_at: now,
        updated_at: now,
        schema_version: 1,
        content,
    };
    write_json_atomic(&paths.doc_file(&id)?, &doc).await?;

    Ok(crate::models::CreatedDoc {
        workspace: ws,
        doc_id: id,
    })
}
