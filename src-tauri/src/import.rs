//! Markdown import: a folder of `.md` files (Obsidian vault, Notion export,
//! plain folder of notes) becomes part of the workspace tree.
//!
//! The import is deliberately *additive*: nothing is overwritten, every source
//! file becomes a new document, folders become folders. Local images referenced
//! by a document are copied into `assets/` and their `src` is rewritten to the
//! portable `assets/<id>.<ext>` form the editor already understands.
//!
//! All new nodes are written with a single `workspace.json` write at the end —
//! importing 500 notes must not cost 500 whole-file rewrites.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::atomic::write_json_atomic;
use crate::error::{AppError, AppResult};
use crate::markdown;
use crate::models::{empty_doc, now_ms, DocFile, Node, NodeKind, Workspace};
use crate::paths::{short_id, workspace_root, Paths};

/// Guards against a runaway folder (a home directory picked by accident).
const MAX_FILES: usize = 3000;

/// Parses pasted Markdown without importing a file.
#[tauri::command]
pub fn parse_markdown_body(text: String) -> serde_json::Value {
    markdown::parse_markdown_body(&text)
}
const MAX_DEPTH: usize = 24;
/// One document bigger than this is skipped instead of read into memory.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStats {
    pub docs: usize,
    pub folders: usize,
    pub assets: usize,
    pub skipped: usize,
    pub failed: usize,
    /// folder the import created (empty when importing into an existing folder)
    pub target_name: String,
    /// first few errors, shown in the toast when the import was partial
    pub messages: Vec<String>,
    /// documents created from JSON that was not a Novion document (kept as text)
    pub plain_text: usize,
}

/// Opens the native folder picker. Returns `None` when the user cancels.
///
/// This used to shell out to `osascript`, which only exists on macOS. The
/// dialog plugin asks the same system picker on macOS and uses IFileDialog on
/// Windows, so the import flow works identically on both.
#[tauri::command]
pub async fn pick_import_folder<R: Runtime>(app: AppHandle<R>) -> AppResult<Option<String>> {
    // the dialog blocks until the user answers: keep it off the async workers
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择要导入的 Markdown 文件夹")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| AppError::new("pick_failed", format!("选择器中断：{e}")))?;

    let Some(path) = picked else {
        return Ok(None); // cancelled
    };
    let path = path
        .into_path()
        .map_err(|e| AppError::new("pick_failed", format!("没有选择文件夹：{e}")))?;
    let text = path.to_string_lossy().trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }
    Ok(Some(text))
}

/// Imports a Markdown folder (or a single `.md` file).
///
/// `source` is normally the path returned by [`pick_import_folder`]; the frontend
/// may also pass a folder that was dropped onto the window.
#[tauri::command]
pub async fn import_markdown<R: Runtime>(
    app: AppHandle<R>,
    source: String,
    parent_id: Option<String>,
) -> AppResult<ImportStats> {
    let paths = Paths::new(workspace_root(&app)?);
    let root = PathBuf::from(source.trim());
    if !root.exists() {
        return Err(AppError::not_found("导入路径不存在"));
    }
    let mut ws = crate::workspace::load(&paths).await?;
    let stats = import_path(&paths, &mut ws, &root, parent_id.as_deref()).await?;
    finish(&paths, &mut ws, stats).await
}

/// Imports Markdown that was dropped onto the window as text (no file path is
/// exposed by the webview for a dropped file).
#[tauri::command]
pub async fn import_markdown_text<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    text: String,
    parent_id: Option<String>,
) -> AppResult<ImportStats> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = crate::workspace::load(&paths).await?;

    let title = clean_title(&name);
    let parsed = markdown::parse_markdown(&text);
    let mut stats = ImportStats::default();
    let node = add_doc(
        &paths,
        &mut ws,
        parent_id.as_deref(),
        parsed.title.unwrap_or(title),
        parsed.content,
    )
    .await?;
    stats.docs += 1;
    let _ = node;
    finish(&paths, &mut ws, stats).await
}

/// Imports a document that was exported as JSON (`export_doc(…, "json")`).
///
/// A dropped `.json` file is either a Novion document — the `DocFile` written by
/// the exporter — or something else entirely. A recognisable document keeps its
/// blocks and its title; anything else still becomes a document, with the raw
/// text kept paragraph by paragraph, so dropping the wrong file never loses
/// content and never fails.
#[tauri::command]
pub async fn import_json_text<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    text: String,
    parent_id: Option<String>,
) -> AppResult<ImportStats> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = crate::workspace::load(&paths).await?;

    let parsed = parse_json_document(&name, &text);
    let mut stats = ImportStats::default();
    add_doc(
        &paths,
        &mut ws,
        parent_id.as_deref(),
        parsed.title,
        parsed.content,
    )
    .await?;
    stats.docs += 1;
    if parsed.plain_text {
        stats.plain_text += 1;
    }
    finish(&paths, &mut ws, stats).await
}

struct ParsedJson {
    title: String,
    content: serde_json::Value,
    /// the file was not a Novion document and survives as plain paragraphs
    plain_text: bool,
}

/// Larger files are never handed to the JSON parser: they are kept as text.
const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;

/// Plain-text fallback never grows past this, otherwise a multi-megabyte file
/// would turn into an editor document that is slow to open for no benefit.
const MAX_PLAIN_TEXT_CHARS: usize = 200_000;

fn parse_json_document(name: &str, text: &str) -> ParsedJson {
    let fallback = clean_title(name);
    if text.len() > MAX_JSON_BYTES {
        return ParsedJson {
            title: fallback,
            content: plain_text_doc(text),
            plain_text: true,
        };
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return ParsedJson {
            title: fallback,
            content: plain_text_doc(text),
            plain_text: true,
        };
    };

    let Some(content) = document_content(&value) else {
        return ParsedJson {
            title: fallback,
            content: plain_text_doc(text),
            plain_text: true,
        };
    };

    // the exported title is the document's own name; the file name is only a
    // fallback for exports that carry an empty one
    let title = value
        .get("title")
        .and_then(|title| title.as_str())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(|title| title.chars().take(160).collect::<String>())
        .unwrap_or(fallback);

    ParsedJson {
        title,
        content,
        plain_text: false,
    }
}

/// Extracts the blocks from either shape the exporter and the editor use:
/// `{ id, title, …, content: { type: "doc", content: [...] } }` or a bare
/// `{ type: "doc", content: [...] }`. Everything else is `None`.
fn document_content(value: &serde_json::Value) -> Option<serde_json::Value> {
    let outer = value.as_object()?;
    let inner = match outer.get("content") {
        Some(inner) if inner.is_object() => inner,
        _ => value, // a bare TipTap document
    };
    let inner = inner.as_object()?;

    match inner.get("type").and_then(|kind| kind.as_str()) {
        Some("doc") => {}
        _ => return None,
    }

    let blocks: Vec<serde_json::Value> = inner
        .get("content")
        .and_then(|blocks| blocks.as_array())?
        .iter()
        .filter(|block| {
            block
                .get("type")
                .and_then(|kind| kind.as_str())
                .is_some_and(|kind| !kind.is_empty())
        })
        .cloned()
        .collect();

    Some(if blocks.is_empty() {
        empty_doc()
    } else {
        serde_json::json!({ "type": "doc", "content": blocks })
    })
}

/// The raw text as readable paragraphs: one per line, blank lines kept as empty
/// paragraphs, long files cut off with a marker instead of freezing the editor.
fn plain_text_doc(text: &str) -> serde_json::Value {
    if text.trim().is_empty() {
        return empty_doc();
    }
    let truncated = text.chars().count() > MAX_PLAIN_TEXT_CHARS;
    let body: String = if truncated {
        text.chars().take(MAX_PLAIN_TEXT_CHARS).collect()
    } else {
        text.to_string()
    };

    let mut blocks: Vec<serde_json::Value> = body
        .lines()
        .map(|line| {
            if line.trim().is_empty() {
                serde_json::json!({ "type": "paragraph" })
            } else {
                serde_json::json!({
                    "type": "paragraph",
                    "content": [{ "type": "text", "text": line }]
                })
            }
        })
        .collect();
    if truncated {
        blocks.push(serde_json::json!({
            "type": "paragraph",
            "content": [{ "type": "text", "text": "…" }]
        }));
    }

    serde_json::json!({ "type": "doc", "content": blocks })
}

async fn finish(
    paths: &Paths,
    ws: &mut Workspace,
    stats: ImportStats,
) -> AppResult<ImportStats> {
    if stats.docs == 0 && stats.folders == 0 {
        return Ok(stats);
    }
    ws.updated_at = now_ms();
    crate::workspace::save(paths, ws).await?;
    Ok(stats)
}

// ------------------------------------------------------------------- walk

/// One Markdown file found on disk, with the folder chain it came from.
struct Found {
    file: PathBuf,
    /// folder names below the import root (empty for a flat import)
    dirs: Vec<String>,
}

fn collect_markdown(root: &Path) -> Vec<Found> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, Vec<String>, usize)> = vec![(root.to_path_buf(), Vec::new(), 0)];

    while let Some((dir, chain, depth)) = stack.pop() {
        if depth > MAX_DEPTH || out.len() >= MAX_FILES {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        // sorted so the import order matches what the user sees in Finder
        let mut items: Vec<_> = entries.filter_map(Result::ok).collect();
        items.sort_by_key(|entry| entry.file_name());

        for entry in items {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                // attachments folders never hold notes worth importing
                if is_attachment_dir(&name) {
                    continue;
                }
                let mut next = chain.clone();
                next.push(name);
                stack.push((path, next, depth + 1));
            } else if kind.is_file() && is_markdown(&path) {
                out.push(Found {
                    file: path,
                    dirs: chain.clone(),
                });
            }
        }
    }
    out
}

fn is_attachment_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "node_modules" | ".git" | "attachments" | "assets" | "files" | "images"
    )
}

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown") | Some("mdx")
    )
}

fn clean_title(name: &str) -> String {
    let stem = name
        .rsplit_once('.')
        .map(|(head, _)| head)
        .unwrap_or(name)
        .trim();
    let title = stem.trim();
    if title.is_empty() {
        "Untitled".to_string()
    } else {
        title.chars().take(160).collect()
    }
}

// ----------------------------------------------------------------- import

async fn import_path(
    paths: &Paths,
    ws: &mut Workspace,
    root: &Path,
    parent_id: Option<&str>,
) -> AppResult<ImportStats> {
    let mut stats = ImportStats::default();
    paths.ensure_dirs().await?;

    // a single file becomes one document under the current parent
    if root.is_file() {
        if !is_markdown(root) {
            return Err(AppError::invalid("只支持导入 .md / .markdown 文件"));
        }
        let title = clean_title(&root.file_name().unwrap_or_default().to_string_lossy());
        import_file(paths, ws, root, title, parent_id, &mut stats).await?;
        return Ok(stats);
    }

    let found = collect_markdown(root);
    if found.is_empty() {
        return Err(AppError::not_found("这个文件夹里没有 Markdown 文件"));
    }

    let folder_name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "导入的笔记".to_string());
    stats.target_name = folder_name.clone();

    let folder_id = add_folder(ws, parent_id, &folder_name);
    stats.folders += 1;

    // folder chain (below the import root) -> node id, created on first use
    let mut dirs: HashMap<Vec<String>, String> = HashMap::new();
    let mut created: Vec<(String, Option<String>, String, Vec<String>)> = Vec::new();

    for item in found {
        let mut parent = folder_id.clone();
        let mut chain: Vec<String> = Vec::new();
        for dir in &item.dirs {
            chain.push(dir.clone());
            parent = match dirs.get(&chain) {
                Some(id) => id.clone(),
                None => {
                    let id = add_folder(ws, Some(&parent), dir);
                    dirs.insert(chain.clone(), id.clone());
                    created.push((id.clone(), Some(parent.clone()), dir.clone(), chain.clone()));
                    // the new folder becomes the parent for the next level —
                    // returning the previous parent flattened the whole tree
                    id
                }
            };
        }

        let title = clean_title(&item.file.file_name().unwrap_or_default().to_string_lossy());
        if let Err(err) = import_file(paths, ws, &item.file, title, Some(&parent), &mut stats).await
        {
            stats.failed += 1;
            if stats.messages.len() < 5 {
                stats.messages.push(err.message);
            }
        }
    }
    stats.folders += created.len();

    // second pass: `[[wiki links]]` now have ids to point at
    resolve_links(paths, ws).await;

    Ok(stats)
}

fn add_folder(ws: &mut Workspace, parent: Option<&str>, name: &str) -> String {
    let id = format!("f_{}", short_id());
    let order = ws
        .nodes
        .iter()
        .filter(|n| n.parent_id.as_deref() == parent)
        .map(|n| n.order)
        .max()
        .map(|o| o + 1)
        .unwrap_or(0);
    let mut node = Node::new(
        id.clone(),
        NodeKind::Folder,
        name.to_string(),
        parent.map(str::to_string),
        order,
    );
    node.updated_at = now_ms();
    ws.nodes.push(node);
    id
}

async fn add_doc(
    paths: &Paths,
    ws: &mut Workspace,
    parent: Option<&str>,
    title: String,
    mut content: serde_json::Value,
) -> AppResult<String> {
    let id = format!("d_{}", short_id());
    let order = ws
        .nodes
        .iter()
        .filter(|n| n.parent_id.as_deref() == parent)
        .map(|n| n.order)
        .max()
        .map(|o| o + 1)
        .unwrap_or(0);

    let node = Node::new(
        id.clone(),
        NodeKind::Doc,
        title.clone(),
        parent.map(str::to_string),
        order,
    );
    ws.nodes.push(node);

    if content.get("content").is_none() {
        content = empty_doc();
    }
    let now = now_ms();
    let doc = DocFile {
        id: id.clone(),
        title,
        created_at: now,
        updated_at: now,
        schema_version: 1,
        content,
    };
    write_json_atomic(&paths.doc_file(&id)?, &doc).await?;
    Ok(id)
}

async fn import_file(
    paths: &Paths,
    ws: &mut Workspace,
    file: &Path,
    fallback_title: String,
    parent: Option<&str>,
    stats: &mut ImportStats,
) -> AppResult<()> {
    let meta = std::fs::metadata(file).map_err(|e| AppError::io("读取文件失败", e))?;
    if meta.len() > MAX_FILE_BYTES {
        stats.skipped += 1;
        return Err(AppError::invalid(format!(
            "{} 超过 8MB，已跳过",
            file.file_name().unwrap_or_default().to_string_lossy()
        )));
    }
    let raw = std::fs::read_to_string(file).map_err(|e| AppError::io("读取 Markdown 失败", e))?;
    let mut parsed = markdown::parse_markdown(&raw);

    // images referenced next to the .md file move into assets/
    copy_local_images(paths, file, &mut parsed.content, stats).await;

    let title = parsed.title.clone().unwrap_or(fallback_title);
    add_doc(paths, ws, parent, title, parsed.content).await?;
    stats.docs += 1;
    Ok(())
}

/// Copies every image a document points at into `assets/` and rewrites `src`.
async fn copy_local_images(
    paths: &Paths,
    md_file: &Path,
    content: &mut serde_json::Value,
    stats: &mut ImportStats,
) {
    let refs = markdown::collect_local_images(content);
    if refs.is_empty() {
        return;
    }
    let base = md_file.parent().unwrap_or(Path::new("."));
    let mut map: HashMap<String, String> = HashMap::new();

    for (src, _alt) in refs {
        if map.contains_key(&src) {
            continue;
        }
        if src.starts_with("http://")
            || src.starts_with("https://")
            || src.starts_with("data:")
            || src.starts_with("assets/")
        {
            continue;
        }
        let decoded = percent_decode(&src);
        // wiki embeds (`![[photo.png]]`) carry no folder, but the file may sit
        // next to the note or in an attachments/ folder beside it
        let candidates = [
            base.join(&decoded),
            base.join("attachments").join(&decoded),
            base.join("assets").join(&decoded),
            base.join("files").join(&decoded),
            base.join("images").join(&decoded),
        ];
        let Some(found) = candidates.iter().find(|p| p.is_file()) else {
            continue;
        };
        let ext = crate::paths::extension_of(&decoded);
        let rel = format!("assets/img_{}.{ext}", short_id());
        let Ok(target) = paths.asset_file(&rel) else { continue };
        if tokio::fs::copy(found, &target).await.is_ok() {
            map.insert(src, rel);
            stats.assets += 1;
        }
    }

    if !map.is_empty() {
        markdown::rewrite_image_srcs(content, &map);
    }
}

fn percent_decode(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Rewrites `[[name]]` links to `novion://doc/<id>` once the ids exist.
async fn resolve_links(paths: &Paths, ws: &Workspace) {
    let mut lookup: HashMap<String, String> = HashMap::new();
    for node in ws.nodes.iter().filter(|n| n.kind == NodeKind::Doc) {
        if node.name.trim().is_empty() {
            continue;
        }
        lookup
            .entry(node.name.trim().to_lowercase())
            .or_insert_with(|| node.id.clone());
    }
    if lookup.is_empty() {
        return;
    }

    for node in ws.nodes.iter().filter(|n| n.kind == NodeKind::Doc) {
        let Ok(file) = paths.doc_file(&node.id) else { continue };
        let Ok(mut doc) = crate::atomic::read_json::<DocFile>(&file).await else {
            continue;
        };
        if markdown::resolve_wiki_links(&mut doc.content, &lookup) {
            let _ = write_json_atomic(&file, &doc).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths() -> Paths {
        Paths::new(std::env::temp_dir().join(format!("novion-import-{}", short_id())))
    }

    #[tokio::test]
    async fn imports_a_folder_tree_with_notes_and_images() {
        let paths = temp_paths();
        paths.ensure_dirs().await.unwrap();
        let src = paths.root.join("vault");
        tokio::fs::create_dir_all(src.join("子目录")).await.unwrap();
        tokio::fs::write(
            src.join("第一篇.md"),
            "# 第一篇\n\n正文 [[第二篇]]\n\n![图](shot.png)\n",
        )
        .await
        .unwrap();
        tokio::fs::write(src.join("子目录").join("第二篇.md"), "第二篇的正文\n")
            .await
            .unwrap();
        tokio::fs::write(src.join("shot.png"), b"png-bytes").await.unwrap();

        let mut ws = Workspace::default();
        let stats = import_path(&paths, &mut ws, &src, None).await.unwrap();

        assert_eq!(stats.docs, 2, "{stats:?}");
        assert_eq!(stats.assets, 1, "{stats:?}");
        assert_eq!(stats.folders, 2, "root folder + 子目录: {stats:?}");

        // the image landed in assets/ and the body points at it
        let doc_node = ws
            .nodes
            .iter()
            .find(|n| n.name == "第一篇")
            .expect("imported document");
        let file = paths.doc_file(&doc_node.id).unwrap();
        let text = tokio::fs::read_to_string(&file).await.unwrap();
        assert!(text.contains("assets/img_"), "{text}");
        assert!(
            text.contains(&format!("novion://doc/{}", ws.nodes.iter().find(|n| n.name == "第二篇").unwrap().id)),
            "wiki link resolved: {text}"
        );

        // the nested note lives in the imported sub folder
        let sub = ws.nodes.iter().find(|n| n.name == "子目录").unwrap();
        assert!(ws
            .nodes
            .iter()
            .any(|n| n.name == "第二篇" && n.parent_id.as_deref() == Some(sub.id.as_str())));

        let _ = tokio::fs::remove_dir_all(&paths.root).await;
    }

    #[tokio::test]
    async fn imports_an_exported_document_json() {
        let paths = temp_paths();
        paths.ensure_dirs().await.unwrap();
        let mut ws = Workspace::default();

        let text = serde_json::json!({
            "id": "d_old",
            "title": "周报",
            "createdAt": 1,
            "updatedAt": 2,
            "schemaVersion": 1,
            "content": {
                "type": "doc",
                "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "正文" }] }
                ]
            }
        })
        .to_string();

        let parsed = parse_json_document("周报.json", &text);
        assert!(!parsed.plain_text);
        assert_eq!(parsed.title, "周报");
        add_doc(&paths, &mut ws, None, parsed.title, parsed.content)
            .await
            .unwrap();

        let node = ws.nodes.last().expect("new document node");
        assert_eq!(node.name, "周报");
        // the exported id is never reused, so two copies can coexist
        assert_ne!(node.id, "d_old");
        let doc = crate::atomic::read_json::<DocFile>(&paths.doc_file(&node.id).unwrap())
            .await
            .unwrap();
        assert_eq!(doc.content["content"][0]["type"], "paragraph");
        assert_eq!(doc.content["content"][0]["content"][0]["text"], "正文");

        let _ = tokio::fs::remove_dir_all(&paths.root).await;
    }

    #[test]
    fn json_without_a_title_falls_back_to_the_file_name() {
        let text = serde_json::json!({
            "content": { "type": "doc", "content": [{ "type": "paragraph" }] }
        })
        .to_string();
        let parsed = parse_json_document("随手记.json", &text);
        assert_eq!(parsed.title, "随手记");
        assert!(!parsed.plain_text);
    }

    #[test]
    fn foreign_json_keeps_its_text() {
        // valid JSON, but not a Novion document
        let parsed = parse_json_document("data.json", "{\n  \"a\": 1\n}");
        assert!(parsed.plain_text);
        assert_eq!(parsed.title, "data");
        let blocks = parsed.content["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 3, "one paragraph per line: {blocks:?}");
        assert_eq!(blocks[1]["content"][0]["text"], "  \"a\": 1");

        // broken JSON is kept the same way
        let broken = parse_json_document("broken.json", "{ not json");
        assert!(broken.plain_text);
        assert_eq!(broken.content["content"][0]["content"][0]["text"], "{ not json");
    }

    #[test]
    fn empty_json_becomes_an_empty_document() {
        let parsed = parse_json_document("empty.json", "");
        assert!(parsed.plain_text);
        assert_eq!(parsed.content["type"], "doc");
        assert_eq!(parsed.content["content"][0]["type"], "paragraph");
    }

    #[test]
    fn percent_encoded_image_names_are_decoded() {
        assert_eq!(percent_decode("a%20b%2Fc.png"), "a b/c.png");
        assert_eq!(percent_decode("普通.png"), "普通.png");
    }

    #[test]
    fn attachment_folders_are_not_walked() {
        assert!(is_attachment_dir("attachments"));
        assert!(!is_attachment_dir("notes"));
    }
}

