//! Rolling version history.
//!
//! Every document keeps a small ring of previous bodies under
//! `history/<docId>/<timestamp>.json`. Snapshots are written *before* a save
//! overwrites the file, at most once per [`SNAPSHOT_INTERVAL_MS`], so an
//! afternoon of typing costs a handful of files instead of one per keystroke.
//! The newest `history_limit` snapshots survive (ten by default, adjustable up
//! to twenty in the settings); older ones are pruned.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::atomic::{read_json, write_json_atomic};
use crate::error::{AppError, AppResult};
use crate::markdown;
use crate::models::{now_ms, DocFile};
use crate::paths::{workspace_root, Paths};

/// One snapshot per 5 minutes of editing is plenty for a notes app.
const SNAPSHOT_INTERVAL_MS: u64 = 5 * 60 * 1000;
const PREVIEW_CHARS: usize = 140;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredVersion {
    ts: u64,
    title: String,
    created_at: u64,
    content: Value,
}

/// The same payload written from borrowed data, so a snapshot never has to
/// clone the whole document body just to serialise it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredVersionRef<'a> {
    ts: u64,
    title: &'a str,
    created_at: u64,
    content: &'a Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub ts: u64,
    pub title: String,
    pub bytes: u64,
    /// non-whitespace characters, so CJK text counts the way users expect
    pub words: usize,
    pub preview: String,
}

/// `<ts>.json` files in a history folder, oldest first.
async fn list_files(dir: &Path) -> Vec<(u64, PathBuf)> {
    let Ok(mut reader) = tokio::fs::read_dir(dir).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(entry)) = reader.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        let Ok(ts) = stem.parse::<u64>() else {
            continue;
        };
        out.push((ts, entry.path()));
    }
    out.sort_by_key(|(ts, _)| *ts);
    out
}

#[cfg(test)]
fn preview_of(content: &Value) -> String {
    let text = markdown::document_text(content);
    preview_from(&text)
}

fn word_count(content: &Value) -> usize {
    count_words(&markdown::document_text(content))
}

/// Non-whitespace characters, so CJK text counts the way users expect.
fn count_words(text: &str) -> usize {
    text.chars().filter(|c| !c.is_whitespace()).count()
}

fn preview_from(text: &str) -> String {
    let mut out: String = text.chars().take(PREVIEW_CHARS).collect();
    if text.chars().count() > PREVIEW_CHARS {
        out.push('…');
    }
    out
}

/// Newest snapshot timestamp per document.
///
/// Saves are frequent and the version folder rarely changes, so listing it on
/// every write is pure overhead. Entries are keyed by workspace root + doc id
/// because the same ids exist in both the local and the iCloud workspace.
static NEWEST_TS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn newest_cache() -> &'static Mutex<HashMap<String, u64>> {
    NEWEST_TS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(paths: &Paths, doc_id: &str) -> String {
    format!("{}/{doc_id}", paths.root.display())
}

/// Timestamp of the newest snapshot, `0` when the document has none.
/// The first lookup for a document lists its history folder, afterwards the
/// in-memory value is reused (and kept in sync by [`snapshot`]).
async fn newest_ts(paths: &Paths, doc_id: &str) -> u64 {
    let key = cache_key(paths, doc_id);
    if let Some(ts) = newest_cache().lock().ok().and_then(|map| map.get(&key).copied()) {
        return ts;
    }
    let ts = match paths.history_doc_dir(doc_id) {
        Ok(dir) => list_files(&dir).await.last().map(|(ts, _)| *ts).unwrap_or(0),
        Err(_) => 0,
    };
    if let Ok(mut map) = newest_cache().lock() {
        map.insert(key, ts);
    }
    ts
}

fn remember_ts(paths: &Paths, doc_id: &str, ts: u64) {
    if let Ok(mut map) = newest_cache().lock() {
        let entry = map.entry(cache_key(paths, doc_id)).or_insert(0);
        if *entry < ts {
            *entry = ts;
        }
    }
}

/// True when a save of this document should store a new version, i.e. the
/// newest snapshot is older than [`SNAPSHOT_INTERVAL_MS`]. Lets the save path
/// decide whether it has to read the outgoing body at all.
pub async fn snapshot_due(paths: &Paths, doc_id: &str) -> bool {
    now_ms().saturating_sub(newest_ts(paths, doc_id).await) >= SNAPSHOT_INTERVAL_MS
}

/// Drops the oldest snapshots until only `limit` remain.
async fn prune(dir: &Path, limit: usize) {
    let mut all = list_files(dir).await;
    if all.len() <= limit.max(1) {
        return;
    }
    let drop_count = all.len() - limit.max(1);
    for (_, path) in all.drain(..drop_count) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

/// Stores `doc` as a version. `force` bypasses the interval (used before a
/// restore, so the state that is about to be replaced is never lost); `limit`
/// is the retention the user picked in the settings.
pub async fn snapshot(paths: &Paths, doc: &DocFile, force: bool, limit: usize) -> AppResult<()> {
    let dir = paths.history_doc_dir(&doc.id)?;

    // cheapest path first: the interval check is a cached timestamp, while
    // scanning the body runs on every autosave
    let now = now_ms();
    let latest = newest_ts(paths, &doc.id).await;
    if !force && now.saturating_sub(latest) < SNAPSHOT_INTERVAL_MS {
        return Ok(());
    }
    if word_count(&doc.content) == 0 && !force {
        return Ok(());
    }

    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::io("创建版本目录失败", e))?;

    // two saves inside the same millisecond must not overwrite each other
    let ts = if latest >= now { latest + 1 } else { now };

    // borrowed on purpose: the body can be megabytes, a clone here would
    // double the memory held by the save for no reason
    let version = StoredVersionRef {
        ts,
        title: &doc.title,
        created_at: doc.created_at,
        content: &doc.content,
    };
    write_json_atomic(&dir.join(format!("{ts}.json")), &version).await?;
    remember_ts(paths, &doc.id, ts);

    prune(&dir, limit).await;
    Ok(())
}

/// Applies a new retention to every document's history.
///
/// Lowering the limit has to take effect immediately, otherwise the version
/// dialog would keep listing more rows than the user just allowed.
pub async fn trim_all(paths: &Paths, limit: usize) {
    let Ok(mut reader) = tokio::fs::read_dir(paths.history_dir()).await else {
        return;
    };
    while let Ok(Some(entry)) = reader.next_entry().await {
        if !entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Ok(dir) = paths.history_doc_dir(&name) {
            prune(&dir, limit).await;
        }
    }
    // the cached "newest snapshot" stays valid: pruning only removes old files
}

/// Removes every snapshot of a document (called when it is purged for good).
pub async fn purge(paths: &Paths, doc_id: &str) {
    if let Ok(dir) = paths.history_doc_dir(doc_id) {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
    if let Ok(mut map) = newest_cache().lock() {
        map.remove(&cache_key(paths, doc_id));
    }
}

async fn read_version(paths: &Paths, id: &str, ts: u64) -> AppResult<StoredVersion> {
    let dir = paths.history_doc_dir(id)?;
    let file = dir.join(format!("{ts}.json"));
    if !tokio::fs::try_exists(&file).await.unwrap_or(false) {
        return Err(AppError::not_found("这个版本已经不存在了"));
    }
    read_json::<StoredVersion>(&file).await
}

#[tauri::command]
pub async fn list_doc_versions<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> AppResult<Vec<VersionMeta>> {
    let paths = Paths::new(workspace_root(&app)?);
    let dir = paths.history_doc_dir(&id)?;

    let mut out = Vec::new();
    for (ts, path) in list_files(&dir).await {
        let Ok(version) = read_json::<StoredVersion>(&path).await else {
            continue;
        };
        let bytes = tokio::fs::metadata(&path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        // one body walk feeds both the word count and the preview
        let text = markdown::document_text(&version.content);
        out.push(VersionMeta {
            ts,
            title: version.title,
            bytes,
            words: count_words(&text),
            preview: preview_from(&text),
        });
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

/// Restores a version's body. The title and creation time of the current
/// document are kept (the title lives in `workspace.json`, not in the version),
/// and the outgoing body is snapshotted first so this is itself undoable.
/// Full body of one snapshot, for the preview and the diff view.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionBody {
    pub ts: u64,
    pub title: String,
    pub created_at: u64,
    pub content: Value,
}

#[tauri::command]
pub async fn read_doc_version<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    ts: u64,
) -> AppResult<VersionBody> {
    let paths = Paths::new(workspace_root(&app)?);
    let version = read_version(&paths, &id, ts).await?;
    Ok(VersionBody {
        ts: version.ts,
        title: version.title,
        created_at: version.created_at,
        content: version.content,
    })
}

/// Writes a snapshot on demand ("存一个版本"), ignoring the 5 minute interval.
#[tauri::command]
pub async fn create_doc_version<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> AppResult<VersionMeta> {
    let paths = Paths::new(workspace_root(&app)?);
    paths.ensure_dirs().await?;
    let file = paths.doc_file(&id)?;
    if !tokio::fs::try_exists(&file).await.unwrap_or(false) {
        return Err(AppError::not_found("文档不存在"));
    }
    let doc = read_json::<DocFile>(&file).await?;
    snapshot(&paths, &doc, true, crate::config::history_limit(&app)).await?;

    let dir = paths.history_doc_dir(&id)?;
    let ts = list_files(&dir).await.last().map(|(ts, _)| *ts).unwrap_or(0);
    let bytes = tokio::fs::metadata(dir.join(format!("{ts}.json")))
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let text = markdown::document_text(&doc.content);
    Ok(VersionMeta {
        ts,
        title: doc.title,
        bytes,
        words: count_words(&text),
        preview: preview_from(&text),
    })
}

#[tauri::command]
pub async fn restore_doc_version<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    ts: u64,
) -> AppResult<DocFile> {
    let paths = Paths::new(workspace_root(&app)?);
    paths.ensure_dirs().await?;

    let version = read_version(&paths, &id, ts).await?;
    let file = paths.doc_file(&id)?;
    let current = if tokio::fs::try_exists(&file).await.unwrap_or(false) {
        read_json::<DocFile>(&file).await.ok()
    } else {
        None
    };

    if let Some(current) = &current {
        let _ = snapshot(&paths, current, true, crate::config::history_limit(&app)).await;
    }

    let now = now_ms();
    let doc = DocFile {
        id: id.clone(),
        title: current
            .as_ref()
            .map(|d| d.title.clone())
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| version.title.clone()),
        created_at: current
            .as_ref()
            .map(|d| d.created_at)
            .unwrap_or(version.created_at),
        updated_at: now,
        schema_version: 1,
        content: version.content,
    };
    write_json_atomic(&file, &doc).await?;
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_doc(content: Value) -> DocFile {
        DocFile {
            id: "d_test".to_string(),
            title: "标题".to_string(),
            created_at: 1,
            updated_at: 2,
            schema_version: 1,
            content,
        }
    }

    #[test]
    fn word_count_ignores_whitespace() {
        let d = make_doc(json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [
                { "type": "text", "text": "你好 世界 a b" } ] }]
        }));
        assert_eq!(word_count(&d.content), 6);
    }

    #[test]
    fn preview_is_capped() {
        let long = "字".repeat(PREVIEW_CHARS + 40);
        let content = json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": long }] }]
        });
        let preview = preview_of(&content);
        assert_eq!(preview.chars().count(), PREVIEW_CHARS + 1);
        assert!(preview.ends_with('…'));
    }

    fn body(text: &str) -> Value {
        json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }]
        })
    }

    fn temp_paths() -> Paths {
        Paths::new(std::env::temp_dir().join(format!(
            "novion-history-test-{}",
            uuid::Uuid::new_v4().simple()
        )))
    }

    #[tokio::test]
    async fn snapshots_are_throttled_and_forced_writes_always_land() {
        let paths = temp_paths();
        paths.ensure_dirs().await.unwrap();
        let doc = make_doc(body("第一版"));
        let dir = paths.history_doc_dir(&doc.id).unwrap();

        snapshot(&paths, &doc, false, 10).await.unwrap();
        assert_eq!(list_files(&dir).await.len(), 1);

        // inside the 5 minute window: no second file
        snapshot(&paths, &doc, false, 10).await.unwrap();
        assert_eq!(list_files(&dir).await.len(), 1);

        // a forced snapshot (before a restore) never skips
        snapshot(&paths, &doc, true, 10).await.unwrap();
        assert_eq!(list_files(&dir).await.len(), 2);

        // empty bodies are not worth a snapshot unless forced
        let empty = make_doc(body(""));
        snapshot(&paths, &empty, false, 10).await.unwrap();
        assert_eq!(list_files(&dir).await.len(), 2);

        let _ = tokio::fs::remove_dir_all(&paths.root).await;
    }

    #[tokio::test]
    async fn retention_keeps_only_the_newest_snapshots() {
        let paths = temp_paths();
        paths.ensure_dirs().await.unwrap();
        let doc = make_doc(body("内容"));
        let dir = paths.history_doc_dir(&doc.id).unwrap();

        // forced writes are the only way to get more than one per 5 minutes
        for _ in 0..14 {
            snapshot(&paths, &doc, true, 10).await.unwrap();
        }
        let kept = list_files(&dir).await;
        assert_eq!(kept.len(), 10);

        // lowering the limit prunes immediately, without waiting for a save
        trim_all(&paths, 5).await;
        assert_eq!(list_files(&dir).await.len(), 5);

        let _ = tokio::fs::remove_dir_all(&paths.root).await;
    }

    #[tokio::test]
    async fn a_version_round_trips_through_disk() {
        let paths = temp_paths();
        paths.ensure_dirs().await.unwrap();
        let doc = make_doc(body("原始内容"));
        snapshot(&paths, &doc, true, 10).await.unwrap();

        let dir = paths.history_doc_dir(&doc.id).unwrap();
        let (ts, _) = list_files(&dir).await.pop().unwrap();
        let version = read_version(&paths, &doc.id, ts).await.unwrap();
        assert_eq!(version.title, "标题");
        assert_eq!(word_count(&version.content), 4);
        assert!(preview_of(&version.content).contains("原始内容"));

        let _ = tokio::fs::remove_dir_all(&paths.root).await;
    }
}
