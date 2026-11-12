//! Backlinks: which documents link to this one.
//!
//! Links are stored as a `link` mark with `href = novion://doc/<id>` (inserted by
//! the `[[` picker or resolved during a Markdown import), so the index only has
//! to look for that prefix. The scan runs over the raw file bytes instead of the
//! parsed body: a note is a single JSON line, the marker is ASCII, and skipping
//! the JSON decode keeps a whole-workspace pass in the low milliseconds.
//!
//! Results are cached per document and invalidated by (mtime, size), the same
//! trick the search index uses.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::error::AppResult;
use crate::markdown::DOC_PREFIX;
use crate::models::NodeKind;
use crate::paths::{workspace_root, Paths};

/// Bytes of context kept on each side of a match, for the panel preview.
const CONTEXT_CHARS: usize = 90;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub id: String,
    pub title: String,
    /// plain text around the first link to this document
    pub context: String,
}

struct CacheEntry {
    mtime: u64,
    len: u64,
    /// document ids this document links to (deduplicated)
    targets: Vec<String>,
    /// the text around each target, keyed by target id
    snippets: HashMap<String, String>,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
    bytes: usize,
}

static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}

impl Cache {
    /// Cached lookup that answers "does this document link to `target`, and
    /// with which snippet".
    ///
    /// `get` used to clone the target list and the whole snippet map on every
    /// hit; a workspace-wide backlink scan therefore allocated (and freed) one
    /// map per document just to throw it away.
    ///
    /// `None` = not cached, `Some(None)` = cached but no link to `target`.
    fn probe(&self, id: &str, mtime: u64, len: u64, target: &str) -> Option<Option<String>> {
        let entry = self.entries.get(id)?;
        if entry.mtime != mtime || entry.len != len {
            return None;
        }
        Some(entry.snippets.get(target).cloned())
    }

    fn insert(
        &mut self,
        id: String,
        mtime: u64,
        len: u64,
        targets: Vec<String>,
        snippets: HashMap<String, String>,
    ) {
        let size = targets.iter().map(String::len).sum::<usize>()
            + snippets.values().map(String::len).sum::<usize>()
            + id.len();
        if size > MAX_CACHE_BYTES {
            return;
        }
        if let Some(old) = self.entries.remove(&id) {
            self.bytes = self.bytes.saturating_sub(entry_size(&old));
        }
        self.bytes += size;
        self.entries.insert(
            id.clone(),
            CacheEntry {
                mtime,
                len,
                targets,
                snippets,
            },
        );
        self.order.push_back(id);
        while self.bytes > MAX_CACHE_BYTES {
            let Some(evicted) = self.order.pop_front() else { break };
            if let Some(old) = self.entries.remove(&evicted) {
                self.bytes = self.bytes.saturating_sub(entry_size(&old));
            }
        }
    }
}

fn entry_size(entry: &CacheEntry) -> usize {
    entry.targets.iter().map(String::len).sum::<usize>()
        + entry.snippets.values().map(String::len).sum::<usize>()
        + 8
}

/// Reads the doc ids a body links to, plus a readable snippet per target.
fn scan_links(raw: &str) -> (Vec<String>, HashMap<String, String>) {
    let mut targets: Vec<String> = Vec::new();
    let mut snippets: HashMap<String, String> = HashMap::new();
    let bytes = raw.as_bytes();
    let needle = DOC_PREFIX.as_bytes();
    let mut from = 0usize;

    while let Some(at) = find_bytes(bytes, needle, from) {
        let start = at + needle.len();
        let mut end = start;
        while end < bytes.len() && is_id_byte(bytes[end]) {
            end += 1;
        }
        if end > start {
            let id = String::from_utf8_lossy(&bytes[start..end]).to_string();
            if !targets.contains(&id) {
                targets.push(id.clone());
                snippets.insert(id, readable_context(raw, at));
            }
        }
        from = end.max(at + 1);
    }
    (targets, snippets)
}

fn is_id_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

fn find_bytes(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let mut i = from;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Cuts `CONTEXT_CHARS` around the match out of the raw JSON and strips the
/// markup so the panel shows prose instead of escaped JSON.
///
/// The window is found by walking outwards from the byte offset, so the only
/// allocation is the snippet itself. Collecting `raw.chars()` into a vector
/// first (as this used to) cost 4 bytes per character *per link* — tens of
/// megabytes of transient memory for a large document with many links.
fn readable_context(raw: &str, at: usize) -> String {
    let at = at.min(raw.len());
    let start = raw[..at]
        .char_indices()
        .rev()
        .nth(CONTEXT_CHARS)
        .map(|(index, _)| index)
        .unwrap_or(0);
    let end = raw[at..]
        .char_indices()
        .nth(CONTEXT_CHARS)
        .map(|(index, _)| at + index)
        .unwrap_or(raw.len());
    let window = &raw[start..end];

    let mut out = String::with_capacity(window.len());
    let mut chars = window.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                if let Some(next) = chars.next() {
                    match next {
                        'n' => out.push(' '),
                        't' => out.push(' '),
                        '"' => out.push('"'),
                        other => out.push(other),
                    }
                }
            }
            '"' | '{' | '}' | '[' | ']' => out.push(' '),
            ':' => out.push(' '),
            ch if ch.is_control() => out.push(' '),
            ch => out.push(ch),
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    // drop the JSON key fragments that survive the strip
    collapsed
        .replace("type link attrs href novion //doc ", "")
        .replace("marks novion //doc ", "")
        .trim()
        .chars()
        .take(CONTEXT_CHARS * 2)
        .collect()
}

/// Documents that link to `id`, newest first.
#[tauri::command]
pub async fn backlinks_doc<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<Vec<Backlink>> {
    let paths = Paths::new(workspace_root(&app)?);
    let ws = crate::workspace::load_shared(&paths).await?;

    // borrowed names: the map is only read, so cloning every title (and every
    // id) of the workspace on each open was pure churn
    let titles: HashMap<&str, (&str, u64)> = ws
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Doc && !crate::workspace::in_trash(&ws.nodes, &n.id))
        .map(|n| (n.id.as_str(), (n.name.as_str(), n.updated_at)))
        .collect();

    let mut out: Vec<Backlink> = Vec::new();
    for (doc_id, (title, _)) in titles.iter() {
        if *doc_id == id {
            continue;
        }
        let Ok(file) = paths.doc_file(doc_id) else { continue };
        let Ok(meta) = tokio::fs::metadata(&file).await else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let len = meta.len();

        let snippet = match cache().lock().ok().and_then(|c| c.probe(doc_id, mtime, len, &id)) {
            Some(found) => found,
            None => {
                let raw = tokio::fs::read_to_string(&file).await.unwrap_or_default();
                let (targets, snippets) = scan_links(&raw);
                if let Ok(mut guard) = cache().lock() {
                    guard.insert(
                        doc_id.to_string(),
                        mtime,
                        len,
                        targets,
                        snippets.clone(),
                    );
                }
                snippets.get(&id).cloned()
            }
        };

        if let Some(context) = snippet {
            out.push(Backlink {
                id: doc_id.to_string(),
                title: title.to_string(),
                context,
            });
        }
    }

    out.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(links: &[(&str, &str)]) -> String {
        let mut content = String::from(r#"{"type":"doc","content":["#);
        for (i, (id, text)) in links.iter().enumerate() {
            if i > 0 {
                content.push(',');
            }
            content.push_str(&format!(
                r#"{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}},{{"type":"text","marks":[{{"type":"link","attrs":{{"href":"novion://doc/{id}"}}}}],"text":"链接"}}]}}"#
            ));
        }
        content.push_str("]}");
        content
    }

    #[test]
    fn finds_every_linked_document_once() {
        let raw = body(&[("d_a", "前面的话"), ("d_b", "另一段"), ("d_a", "再来一次")]);
        let (targets, snippets) = scan_links(&raw);
        assert_eq!(targets, vec!["d_a", "d_b"]);
        assert!(snippets.contains_key("d_a"));
    }

    #[test]
    fn documents_without_links_yield_nothing() {
        let (targets, _) = scan_links(r#"{"type":"doc","content":[{"type":"paragraph"}]}"#);
        assert!(targets.is_empty());
    }

    #[test]
    fn context_strips_markup() {
        let raw = body(&[("d_a", "一段正文")]);
        let (_, snippets) = scan_links(&raw);
        let context = snippets.get("d_a").unwrap();
        assert!(!context.contains("novion:"), "{context}");
        assert!(!context.contains('{'), "{context}");
    }

    #[test]
    fn cache_evicts_when_over_budget() {
        let mut cache = Cache::default();
        let big = "x".repeat(1024 * 1024);
        for i in 0..16 {
            let mut snippets = HashMap::new();
            snippets.insert("d_a".to_string(), big.clone());
            cache.insert(format!("d_{i}"), 1, 10, vec!["d_a".to_string()], snippets);
        }
        assert!(cache.bytes <= MAX_CACHE_BYTES);
        assert!(cache.entries.len() < 16);
    }
}
