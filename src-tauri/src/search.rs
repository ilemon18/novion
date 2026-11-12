use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::atomic::read_json;
use crate::error::AppResult;
use crate::models::{DocFile, NodeKind};
use crate::paths::{workspace_root, Paths};
use crate::workspace;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    /// Plain-text excerpt around the first body match (empty when only the
    /// title matched, or when listing recent documents).
    pub snippet: String,
    pub title_match: bool,
    pub updated_at: u64,
}

struct CacheEntry {
    mtime: u64,
    len: u64,
    /// Normalised plain text (original casing) — snippets are cut from this.
    text: Arc<str>,
    /// `text` lowercased once on insert, so a query never builds a second
    /// full copy of every document just to compare it.
    lower: Arc<str>,
}

/// Doc id -> extracted plain text. Keyed by (mtime, size) so edits invalidate
/// themselves without any extra bookkeeping.
///
/// This is a pure cache: it is capped so a large workspace can never pin all
/// of its text in memory, and values are handed out as `Arc<str>` so a lookup
/// is a refcount bump instead of a full copy.
static TEXT_CACHE: OnceLock<Mutex<TextCache>> = OnceLock::new();

/// Upper bound on the cached bytes (text + lowercased copy).
const MAX_CACHE_BYTES: usize = 12 * 1024 * 1024;

#[derive(Default)]
struct TextCache {
    entries: HashMap<String, CacheEntry>,
    /// insertion order, oldest first: eviction walks from the front
    order: VecDeque<String>,
    bytes: usize,
}

fn cache() -> &'static Mutex<TextCache> {
    TEXT_CACHE.get_or_init(|| Mutex::new(TextCache::default()))
}

impl TextCache {
    /// Returns the cached text for `id` when the file has not changed since it
    /// was indexed. Cloning the two `Arc<str>` is O(1).
    fn get(&self, id: &str, mtime: u64, len: u64) -> Option<(Arc<str>, Arc<str>)> {
        let entry = self.entries.get(id)?;
        if entry.mtime == mtime && entry.len == len {
            Some((entry.text.clone(), entry.lower.clone()))
        } else {
            None
        }
    }

    fn insert(&mut self, id: String, mtime: u64, len: u64, text: Arc<str>, lower: Arc<str>) {
        let size = text.len() + lower.len();
        // one oversized document is cheaper to re-read than to pin forever
        if size > MAX_CACHE_BYTES {
            return;
        }
        if let Some(old) = self.entries.remove(&id) {
            self.bytes = self.bytes.saturating_sub(old.text.len() + old.lower.len());
        }
        self.bytes += size;
        self.entries.insert(
            id.clone(),
            CacheEntry {
                mtime,
                len,
                text,
                lower,
            },
        );
        self.order.push_back(id);
        self.evict();
    }

    fn evict(&mut self) {
        while self.bytes > MAX_CACHE_BYTES {
            let Some(id) = self.order.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&id) {
                self.bytes = self.bytes.saturating_sub(entry.text.len() + entry.lower.len());
            }
        }
    }
}

fn break_after(kind: &str) -> bool {
    matches!(
        kind,
        "paragraph"
            | "heading"
            | "listItem"
            | "taskItem"
            | "blockquote"
            | "codeBlock"
            | "tableRow"
            | "horizontalRule"
            | "hardBreak"
    )
}

/// Walks TipTap JSON collecting every `text` leaf, one block per line.
///
/// Whitespace runs are collapsed while writing, so indexing a document builds
/// one buffer instead of `raw` + `normalize(raw)` + a lowercased copy of both.
fn collect_text(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_text(item, out);
            }
        }
        Value::Object(map) => {
            let kind = map.get("type").and_then(Value::as_str).unwrap_or("");
            if kind == "image" {
                push_normalized(out, " [图片] ");
            }
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                push_normalized(out, text);
            }
            if let Some(content) = map.get("content") {
                collect_text(content, out);
            }
            if break_after(kind) {
                push_normalized(out, " ");
            }
        }
        _ => {}
    }
}

/// Appends `text` with every whitespace run collapsed to a single space.
fn push_normalized(out: &mut String, text: &str) {
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
    }
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// Byte range of characters `[start, end)` in `text`, without building a
/// `Vec<char>` of the whole document (4 bytes per character, per search hit).
fn char_window(text: &str, start: usize, end: usize) -> (usize, usize) {
    let mut from = text.len();
    let mut to = text.len();
    for (count, (byte, _)) in text.char_indices().enumerate() {
        if count == start {
            from = byte;
        }
        if count == end {
            to = byte;
            break;
        }
    }
    if start == 0 {
        from = 0;
    }
    (from, to)
}

fn snippet_around(text: &str, text_lower: &str, terms: &[String]) -> String {
    let mut at: Option<(usize, usize)> = None;
    for term in terms {
        if let Some(pos) = text_lower.find(term.as_str()) {
            at = Some(match at {
                Some((best, _)) if best <= pos => (best, term.len()),
                _ => (pos, term.len()),
            });
        }
    }
    let Some((pos, len)) = at else {
        return String::new();
    };

    // `pos` is a byte offset in the lowercased copy; lowercasing can change
    // byte lengths, so the window is expressed in character counts instead.
    let char_start = text_lower[..pos].chars().count();
    let total = text.chars().count();
    let end_of_match = (char_start + text_lower[pos..pos + len].chars().count()).min(total);
    let start = char_start.saturating_sub(48);
    let end = (end_of_match + 88).min(total);

    let (from, to) = char_window(text, start, end);
    let mut out = String::with_capacity(to.saturating_sub(from) + 8);
    if start > 0 {
        out.push('…');
    }
    out.push_str(&text[from..to]);
    if end < total {
        out.push('…');
    }
    out
}

/// Filters parsed out of the raw query string.
///
/// Supported, in any order:
/// `path:项目`, `title:周报`,
/// `updated:>7d` / `updated:<30d` / `updated:7d` (within the last week),
/// `updated:2025-01-01`, and `"quoted phrase"` for a term with spaces.
#[derive(Debug, Default, Clone)]
struct Query {
    terms: Vec<String>,
    title_terms: Vec<String>,
    path: Option<String>,
    updated_after: Option<u64>,
    updated_before: Option<u64>,
}

impl Query {
    fn is_empty(&self) -> bool {
        self.terms.is_empty()
            && self.title_terms.is_empty()
            && self.path.is_none()
            && self.updated_after.is_none()
            && self.updated_before.is_none()
    }

    /// Every free-text term, used for the "match whole phrase" bonus.
    fn phrase(&self) -> Option<String> {
        if self.terms.is_empty() {
            return None;
        }
        Some(self.terms.join(" "))
    }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_relative_days(value: &str) -> Option<u64> {
    let text = value.trim().to_ascii_lowercase();
    let (digits, unit) = text.split_at(text.len().checked_sub(1)?);
    let amount: u64 = digits.parse().ok()?;
    let ms = match unit {
        "m" => 60 * 1000,
        "h" => 60 * 60 * 1000,
        "d" => 24 * 60 * 60 * 1000,
        "w" => 7 * 24 * 60 * 60 * 1000,
        "y" => 365 * 24 * 60 * 60 * 1000,
        _ => return None,
    };
    Some(amount * ms)
}

/// `>7d`, `<2025-01-01`, `7d` → (after, before)
fn parse_updated(value: &str) -> Option<(Option<u64>, Option<u64>)> {
    let now = crate::models::now_ms();
    let text = value.trim();
    let (op, rest) = if let Some(rest) = text.strip_prefix(">=") {
        (">=", rest)
    } else if let Some(rest) = text.strip_prefix('>') {
        (">", rest)
    } else if let Some(rest) = text.strip_prefix("<=") {
        ("<=", rest)
    } else if let Some(rest) = text.strip_prefix('<') {
        ("<", rest)
    } else {
        ("=", text)
    };

    // a calendar date (local midnight is close enough for a filter)
    if let Some((y, rest)) = rest.split_once('-') {
        if let Some((m, d)) = rest.split_once('-') {
            if let (Ok(y), Ok(m), Ok(d)) = (y.parse::<i64>(), m.parse::<i64>(), d.parse::<i64>()) {
                if (1900..=3000).contains(&y) {
                    let ms = (days_from_civil(y, m, d) * 86_400) as i64 * 1000;
                    let ms = ms.max(0) as u64;
                    return Some(match op {
                        ">" => (Some(ms), None),
                        ">=" | "=" => (Some(ms), None),
                        "<" => (None, Some(ms)),
                        "<=" => (None, Some(ms)),
                        _ => (None, None),
                    });
                }
            }
        }
    }

    let span = parse_relative_days(rest)?;
    Some(match op {
        ">" => (Some(now.saturating_sub(span)), None),
        ">=" => (Some(now.saturating_sub(span)), None),
        "<" => (None, Some(now.saturating_sub(span))),
        "<=" => (None, Some(now.saturating_sub(span))),
        // bare `7d` means "within the last 7 days"
        _ => (Some(now.saturating_sub(span)), None),
    })
}

fn parse_query(raw: &str) -> Query {
    let mut q = Query::default();
    let mut words: Vec<String> = Vec::new();
    let chars: Vec<char> = raw.chars().collect();
    let mut i = 0usize;
    let mut buf = String::new();
    let flush = |buf: &mut String, words: &mut Vec<String>| {
        if !buf.is_empty() {
            words.push(std::mem::take(buf));
        }
    };

    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            flush(&mut buf, &mut words);
            let mut j = i + 1;
            let mut phrase = String::new();
            while j < chars.len() && chars[j] != '"' {
                phrase.push(chars[j]);
                j += 1;
            }
            if !phrase.trim().is_empty() {
                words.push(phrase.trim().to_string());
            }
            i = j + 1;
            continue;
        }
        if c.is_whitespace() {
            flush(&mut buf, &mut words);
            i += 1;
            continue;
        }
        buf.push(c);
        i += 1;
    }
    flush(&mut buf, &mut words);

    for word in words {
        let (key, value) = match word.split_once(':') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.to_string()),
            None => (String::new(), word.clone()),
        };
        match key.as_str() {
            "path" | "in" | "folder" => {
                let path = value.trim().to_lowercase();
                if !path.is_empty() {
                    q.path = Some(path);
                }
            }
            "title" => {
                let term = value.trim().to_lowercase();
                if !term.is_empty() {
                    q.title_terms.push(term);
                }
            }
            "updated" | "before" | "after" => {
                if let Some((after, before)) = parse_updated(&value) {
                    if after.is_some() {
                        q.updated_after = after;
                    }
                    if before.is_some() {
                        q.updated_before = before;
                    }
                }
            }
            _ => {
                let term = word.trim().to_lowercase();
                if !term.is_empty() {
                    q.terms.push(term);
                }
            }
        }
    }
    q
}

/// `A / B` chain of folder names, lowercased, for `path:` filters.
///
/// `index` is built once per search; the previous version walked the node list
/// with `find()` for every ancestor of every document (quadratic, with a fresh
/// string vector per document).
fn breadcrumb(index: &HashMap<&str, &crate::models::Node>, id: &str) -> String {
    let mut names: Vec<&str> = Vec::new();
    let mut cursor = index.get(id).copied();
    let mut guard = 0;
    while let Some(node) = cursor {
        if node.builtin.is_none() {
            names.push(node.name.as_str());
        }
        cursor = node
            .parent_id
            .as_deref()
            .and_then(|pid| index.get(pid).copied());
        guard += 1;
        if guard > 64 {
            break;
        }
    }
    names.reverse();
    names.join(" / ").to_lowercase()
}

#[tauri::command]
pub async fn search_docs<R: Runtime>(
    app: AppHandle<R>,
    query: String,
) -> AppResult<Vec<SearchHit>> {
    let paths = Paths::new(workspace_root(&app)?);
    let ws = workspace::load_shared(&paths).await?;
    let q = parse_query(query.trim());
    let query_lower = query.trim().to_lowercase();

    // one parent index for the whole query: folder filters no longer scan the
    // node list once per ancestor, and breadcrumbs are only built when a
    // `path:` filter actually asks for one
    let index: HashMap<&str, &crate::models::Node> =
        ws.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // trash (and everything below it) is not searchable
    let docs: Vec<&crate::models::Node> = ws
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Doc && !workspace::in_trash(&ws.nodes, &n.id))
        .collect();

    // (id, title, text, lowercased text, updatedAt)
    let mut bodies: Vec<(String, String, Arc<str>, Arc<str>, u64)> =
        Vec::with_capacity(docs.len());
    for node in docs {
        let id = node.id.as_str().to_string();
        // folder filters are answered from the tree alone: no need to read the
        // body of a document that is not in the requested folder
        if let Some(path) = &q.path {
            if !breadcrumb(&index, &node.id).contains(path.as_str()) {
                continue;
            }
        }
        let Ok(file) = paths.doc_file(&id) else {
            continue;
        };
        let Ok(meta) = tokio::fs::metadata(&file).await else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(node.updated_at);
        let len = meta.len();

        let cached = match cache().lock() {
            Ok(map) => map.get(&id, mtime, len),
            Err(_) => None,
        };

        let (text, text_lower) = match cached {
            Some(pair) => pair,
            None => {
                let (text, text_lower) = match read_json::<DocFile>(&file).await {
                    Ok(doc) => {
                        let mut raw = String::new();
                        collect_text(&doc.content, &mut raw);
                        let text = Arc::<str>::from(raw.trim());
                        let text_lower = Arc::<str>::from(lower(&text));
                        (text, text_lower)
                    }
                    Err(_) => (Arc::<str>::from(""), Arc::<str>::from("")),
                };
                if let Ok(mut map) = cache().lock() {
                    map.insert(id.clone(), mtime, len, text.clone(), text_lower.clone());
                }
                (text, text_lower)
            }
        };

        let updated_at = mtime.max(node.updated_at);
        if let Some(after) = q.updated_after {
            if updated_at < after {
                continue;
            }
        }
        if let Some(before) = q.updated_before {
            if updated_at > before {
                continue;
            }
        }

        bodies.push((id, node.name.clone(), text, text_lower, updated_at));
    }

    // nothing but filters (or nothing at all) -> recent documents
    if q.is_empty() || (q.terms.is_empty() && q.title_terms.is_empty()) {
        let mut recent = bodies;
        recent.sort_by(|a, b| b.4.cmp(&a.4));
        recent.truncate(24);
        return Ok(recent
            .into_iter()
            .map(|(id, title, text, _lower, updated_at)| SearchHit {
                snippet: text.chars().take(96).collect::<String>(),
                id,
                title,
                title_match: false,
                updated_at,
            })
            .collect());
    }

    /// Subsequence match with a gap penalty: `nvn` matches `novion`.
    ///
    /// Only titles go through this — over a whole document almost any short
    /// sequence of characters would hit, and the result would stop meaning
    /// anything.
    fn fuzzy_score(haystack: &str, needle: &str) -> Option<usize> {
        if needle.is_empty() {
            return None;
        }
        let mut iter = haystack.chars().enumerate();
        let mut last: Option<usize> = None;
        let mut gaps = 0usize;
        for target in needle.chars() {
            let mut found = false;
            for (index, candidate) in iter.by_ref() {
                if candidate == target {
                    if let Some(previous) = last {
                        gaps += index.saturating_sub(previous + 1);
                    }
                    last = Some(index);
                    found = true;
                    break;
                }
            }
            if !found {
                return None;
            }
        }
        Some(gaps)
    }

    let mut hits: Vec<(i64, SearchHit)> = Vec::new();
    for (id, title, text, text_lower, updated_at) in bodies {
        let title_lower = lower(&title);

        let mut score = 0i64;
        let mut title_match = false;
        let mut all_terms = true;

        for term in &q.title_terms {
            if title_lower.contains(term.as_str()) {
                title_match = true;
                score += 120;
            } else if let Some(gaps) = fuzzy_score(&title_lower, term) {
                // "nvn" still finds "Novion"; the gap count keeps the better
                // match on top without turning search into anything goes
                title_match = true;
                score += (80 - gaps as i64).max(20);
            } else {
                all_terms = false;
                break;
            }
        }
        if !all_terms {
            continue;
        }

        for term in &q.terms {
            let in_title = title_lower.contains(term.as_str());
            let in_text = text_lower.contains(term.as_str());
            if in_title {
                title_match = true;
                score += if title_lower == *term { 400 } else { 120 };
            }
            if in_text {
                score += 40;
            }
            if !in_title && !in_text {
                // a title may be abbreviated while typing; body text may not,
                // otherwise a short subsequence would match almost every note
                if let Some(gaps) = fuzzy_score(&title_lower, term) {
                    title_match = true;
                    score += (80 - gaps as i64).max(20);
                } else {
                    all_terms = false;
                    break;
                }
            }
        }
        if !all_terms {
            continue;
        }

        if let Some(phrase) = q.phrase() {
            if q.terms.len() > 1 && title_lower.contains(&phrase) {
                score += 260;
            }
            if text_lower.contains(&phrase) {
                score += 80;
            }
        }
        if !query_lower.is_empty() && text_lower.contains(&query_lower) {
            score += 60;
        }
        // mild recency tie-breaker (newer first, ~1 point per day)
        score += (updated_at / 86_400_000).min(20_000) as i64;

        hits.push((
            score,
            SearchHit {
                id,
                title,
                snippet: if title_match && text.is_empty() {
                    String::new()
                } else {
                    snippet_around(&text, &text_lower, &q.terms)
                },
                title_match,
                updated_at,
            },
        ));
    }

    hits.sort_by(|a, b| b.0.cmp(&a.0));
    hits.truncate(40);
    Ok(hits.into_iter().map(|(_, hit)| hit).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(cache: &TextCache, id: &str, text: &str) -> Option<(Arc<str>, Arc<str>)> {
        cache.get(id, 1, text.len() as u64)
    }

    #[test]
    fn cached_text_is_reused_only_while_the_file_is_unchanged() {
        let mut cache = TextCache::default();
        cache.insert(
            "d_a".to_string(),
            1,
            10,
            Arc::from("Hello"),
            Arc::from("hello"),
        );
        assert!(cache.get("d_a", 1, 10).is_some());
        // a newer mtime or a different size invalidates the entry
        assert!(cache.get("d_a", 2, 10).is_none());
        assert!(cache.get("d_a", 1, 11).is_none());
        assert!(entry(&cache, "d_missing", "x").is_none());
    }

    #[test]
    fn cache_stays_within_its_byte_budget() {
        let mut cache = TextCache::default();
        let chunk = 256 * 1024;
        let text: Arc<str> = Arc::from("a".repeat(chunk).as_str());
        let lower = text.clone();
        for i in 0..64 {
            cache.insert(format!("d_{i}"), 1, chunk as u64, text.clone(), lower.clone());
        }
        assert!(
            cache.bytes <= MAX_CACHE_BYTES,
            "cache grew to {} bytes",
            cache.bytes
        );
        assert!(cache.entries.len() < 64, "nothing was evicted");
        // the newest entries are the ones that survive
        assert!(cache.get("d_63", 1, chunk as u64).is_some());
    }

    #[test]
    fn an_oversized_document_is_never_pinned() {
        let mut cache = TextCache::default();
        let big: Arc<str> = Arc::from("x".repeat(MAX_CACHE_BYTES).as_str());
        cache.insert("d_big".to_string(), 1, 1, big.clone(), big);
        assert!(cache.entries.is_empty());
        assert_eq!(cache.bytes, 0);
    }

    #[test]
    fn query_parses_filters_out_of_the_text() {
        let q = parse_query(r#"报告 path:项目 title:周报 updated:>7d"#);
        assert_eq!(q.terms, vec!["报告"]);
        assert_eq!(q.path.as_deref(), Some("项目"));
        assert_eq!(q.title_terms, vec!["周报"]);
        assert!(q.updated_after.is_some());
        assert!(q.updated_before.is_none());
    }

    #[test]
    fn quoted_phrases_stay_one_term() {
        let q = parse_query(r#""季度 总结" 附注"#);
        assert_eq!(q.terms, vec!["季度 总结", "附注"]);
    }

    #[test]
    fn updated_filters_accept_spans_and_dates() {
        let (after, before) = parse_updated(">7d").unwrap();
        assert!(after.is_some() && before.is_none());
        let (after, before) = parse_updated("<30d").unwrap();
        assert!(after.is_none() && before.is_some());
        // a bare span means "within"
        let (after, before) = parse_updated("3d").unwrap();
        assert!(after.is_some() && before.is_none());
        let (after, _) = parse_updated("2025-01-01").unwrap();
        assert_eq!(after, Some(1_735_689_600_000));
    }

    #[test]
    fn a_query_of_only_filters_is_not_empty() {
        assert!(!parse_query("path:项目").is_empty());
        assert!(parse_query("   ").is_empty());
    }

    #[test]
    fn plain_text_is_collected_per_block() {
        let content = json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 1 }, "content": [
                    { "type": "text", "text": "标题" } ] },
                { "type": "image", "attrs": { "src": "assets/a.png" } },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "正文  " } ] }
            ]
        });
        let mut raw = String::new();
        collect_text(&content, &mut raw);
        let text = raw.trim();
        assert!(text.contains("标题"), "{text}");
        assert!(text.contains("[图片]"), "{text}");
        assert!(text.contains("正文"), "{text}");
        assert!(!text.contains("  "), "{text}");
    }

    #[test]
    fn snippets_are_cut_on_character_boundaries() {
        // CJK text: every character is three bytes, so a byte-offset window
        // would panic on a non-boundary slice
        let text = format!("{}关键词{}", "前".repeat(200), "后".repeat(400));
        let lower = text.to_lowercase();
        let snippet = snippet_around(&text, &lower, &["关键词".to_string()]);
        assert!(snippet.contains("关键词"), "{snippet}");
        assert!(snippet.starts_with('…') && snippet.ends_with('…'), "{snippet}");
        // 48 chars before + match + 88 after, plus two ellipses
        assert!(snippet.chars().count() <= 48 + 3 + 88 + 2, "{snippet}");
    }

    #[test]
    fn a_match_at_the_start_has_no_leading_ellipsis() {
        let text = "关键词就在开头";
        let snippet = snippet_around(text, &text.to_lowercase(), &["关键词".to_string()]);
        assert_eq!(snippet, text);
    }

    #[test]
    fn char_window_clamps_to_the_end_of_the_text() {
        let text = "abc";
        assert_eq!(char_window(text, 0, 3), (0, text.len()));
        assert_eq!(char_window(text, 0, 99), (0, text.len()));
        assert_eq!(char_window(text, 1, 2), (1, 2));
    }
}
