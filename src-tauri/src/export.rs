//! Markdown / HTML / JSON export and full-workspace backup.
//!
//! Everything is written into `~/Downloads/Novion` so the user never has to
//! pick a folder, and every export is self-contained: rendered Markdown points
//! at `assets/` next to the file, and the full backup additionally keeps a
//! byte-exact copy of `workspace.json` + `docs/` + `assets/` so a workspace can
//! be restored by hand without this app.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::atomic::{read_json, write_atomic, write_json_atomic};
use crate::error::{AppError, AppResult};
use crate::markdown;
use crate::models::{now_ms, Builtin, DocFile, NodeKind, Workspace};
use crate::paths::{export_root, workspace_root, Paths};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// file for a single document, folder for a workspace backup
    pub path: String,
    pub files: usize,
    pub bytes: u64,
    pub assets: usize,
    pub format: String,
}

// ------------------------------------------------------------------- helpers

/// Characters Windows forbids in a file name are already mapped to `-`; these
/// names are additionally reserved by the OS and cannot be created at all.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_reserved_name(name: &str) -> bool {
    // Windows reserves the stem regardless of extension: `CON.md` fails too.
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    RESERVED_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// File-system safe name: separators become dashes, everything else is kept so
/// Chinese titles stay readable.
fn safe_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            ch if ch.is_control() => ' ',
            ch => ch,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let bounded: String = trimmed.chars().take(80).collect();
    let bounded = bounded.trim().to_string();
    if bounded.is_empty() {
        fallback.to_string()
    } else {
        bounded
    }
}

/// Escapes a Windows device name (`CON`, `NUL`, `COM1`…) so the file can be
/// created at all.
fn escape_reserved(mut name: String) -> String {
    if is_reserved_name(&name) {
        name.insert(0, '_');
    }
    name
}

/// Trims `stem` so `dir/stem.ext` stays inside a conservative path budget.
///
/// Windows still enforces MAX_PATH (260) unless the app opts into long paths;
/// this app does not, so a deep sidebar tree with long CJK titles would
/// otherwise make `create_dir_all` / `File::create` fail with
/// `ERROR_PATH_NOT_FOUND`. The budget leaves room for a ` (N)` dedupe suffix.
fn fit_stem(dir: &Path, stem: &str, ext: &str) -> String {
    let budget: usize = if cfg!(windows) { 220 } else { 900 };
    let used = dir.to_string_lossy().chars().count() + 1 + ext.chars().count() + 1;
    let room = budget.saturating_sub(used).max(8);
    if stem.chars().count() <= room {
        return stem.to_string();
    }
    stem.chars().take(room).collect::<String>().trim_end().to_string()
}

/// `2025-11-04 18-31-07` in the machine's local time.
///
/// This used to shell out to `date`, which does not exist on Windows; `chrono`
/// reads the platform's own time zone on every OS.
fn local_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H-%M-%S").to_string()
}

/// Appends ` (2)`, ` (3)`… until the path is free.
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let stem = fit_stem(dir, stem, ext);
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    candidate
}

async fn file_size(path: &Path) -> u64 {
    tokio::fs::metadata(path)
        .await
        .map(|m| m.len())
        .unwrap_or(0)
}

async fn create_dir(dir: &Path) -> AppResult<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::io(&format!("创建目录 {} 失败", dir.display()), e))
}

/// Copies the assets referenced by one document into `dest`.
async fn copy_assets(paths: &Paths, dest: &Path, refs: &[String]) -> (usize, u64) {
    let mut copied = 0;
    let mut bytes = 0;
    for rel in refs {
        let Ok(src) = paths.asset_file(rel) else { continue };
        if !tokio::fs::try_exists(&src).await.unwrap_or(false) {
            continue;
        }
        let Some(name) = src.file_name() else { continue };
        let target = dest.join(name);
        if tokio::fs::try_exists(&target).await.unwrap_or(false) {
            continue;
        }
        if create_dir(dest).await.is_err() {
            continue;
        }
        if tokio::fs::copy(&src, &target).await.is_ok() {
            copied += 1;
            bytes += file_size(&target).await;
        }
    }
    (copied, bytes)
}

/// Recursive copy used for the byte-exact `raw/` backup.
async fn copy_tree(src: &Path, dest: &Path) -> AppResult<(usize, u64)> {
    let mut files = 0;
    let mut bytes = 0;
    let mut stack = vec![(src.to_path_buf(), dest.to_path_buf())];

    while let Some((from, to)) = stack.pop() {
        if !tokio::fs::try_exists(&from).await.unwrap_or(false) {
            continue;
        }
        create_dir(&to).await?;
        let mut reader = tokio::fs::read_dir(&from)
            .await
            .map_err(|e| AppError::io(&format!("读取目录 {} 失败", from.display()), e))?;
        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|e| AppError::io("遍历目录失败", e))?
        {
            let target = to.join(entry.file_name());
            let kind = entry
                .file_type()
                .await
                .map_err(|e| AppError::io("读取文件类型失败", e))?;
            if kind.is_dir() {
                stack.push((entry.path(), target));
            } else if kind.is_file() {
                tokio::fs::copy(entry.path(), &target)
                    .await
                    .map_err(|e| AppError::io("复制文件失败", e))?;
                files += 1;
                bytes += file_size(&target).await;
            }
        }
    }
    Ok((files, bytes))
}

// ------------------------------------------------------------- single export

#[tauri::command]
pub async fn export_doc<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    format: String,
) -> AppResult<ExportResult> {
    let paths = Paths::new(workspace_root(&app)?);
    let file = paths.doc_file(&id)?;
    if !tokio::fs::try_exists(&file).await.unwrap_or(false) {
        return Err(AppError::not_found("文档文件不存在"));
    }
    let doc = read_json::<DocFile>(&file).await?;

    let ws = crate::workspace::load_shared(&paths).await.ok();
    let title = ws
        .as_ref()
        .and_then(|ws| ws.nodes.iter().find(|n| n.id == id))
        .map(|n| n.name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| doc.title.clone());
    let title = if title.trim().is_empty() {
        "Untitled".to_string()
    } else {
        title
    };

    let root = export_root(&app);
    create_dir(&root).await?;
    let stem = escape_reserved(safe_name(&title, "Untitled"));
    let format = format.trim().to_ascii_lowercase();

    // Bytes, not a `String`: a JSON export used to serialise into a `Vec<u8>`,
    // convert it lossily into a `String` and then back into bytes when writing
    // — three copies of the whole document for one file.
    let (target, payload): (PathBuf, Vec<u8>) = match format.as_str() {
        "md" | "markdown" => {
            let body = markdown::to_markdown(&doc.content, "");
            (
                unique_path(&root, &stem, "md"),
                format!("# {title}\n\n{body}").into_bytes(),
            )
        }
        "html" => {
            let page = markdown::html_document(&title, &doc.content);
            (unique_path(&root, &stem, "html"), page.into_bytes())
        }
        "json" => {
            let json = serde_json::to_vec_pretty(&doc)
                .map_err(|e| AppError::json("序列化文档失败", e))?;
            (unique_path(&root, &stem, "json"), json)
        }
        other => {
            return Err(AppError::invalid(format!(
                "不支持的导出格式：{other}（可用 md / html / json）"
            )))
        }
    };

    // images are referenced as `assets/x.png`; put them next to the export so
    // the file stays readable when it is moved together with that folder
    let (assets, asset_bytes) = if format == "md" || format == "html" {
        copy_assets(
            &paths,
            &root.join("assets"),
            &crate::assets::collect_asset_refs(&doc.content),
        )
        .await
    } else {
        (0, 0)
    };

    write_atomic(&target, &payload).await?;
    Ok(ExportResult {
        path: target.to_string_lossy().to_string(),
        files: 1,
        bytes: file_size(&target).await + asset_bytes,
        assets,
        format,
    })
}

// ---------------------------------------------------------- workspace backup

#[tauri::command]
pub async fn export_workspace<R: Runtime>(app: AppHandle<R>) -> AppResult<ExportResult> {
    let paths = Paths::new(workspace_root(&app)?);
    let ws = crate::workspace::load_shared(&paths).await?;

    let root = export_root(&app);
    create_dir(&root).await?;
    let dir = root.join(format!("备份-{}", local_stamp()));
    create_dir(&dir).await?;

    // 1. byte-exact copy of the source of truth
    let raw = dir.join("raw");
    create_dir(&raw).await?;
    let mut files = 0;
    let mut bytes = 0;
    if tokio::fs::try_exists(&paths.workspace_file()).await.unwrap_or(false) {
        let target = raw.join("workspace.json");
        tokio::fs::copy(paths.workspace_file(), &target)
            .await
            .map_err(|e| AppError::io("备份 workspace.json 失败", e))?;
        files += 1;
        bytes += file_size(&target).await;
    }
    for sub in ["docs", "assets"] {
        let (f, b) = copy_tree(&paths.root.join(sub), &raw.join(sub)).await?;
        files += f;
        bytes += b;
    }

    // 2. readable Markdown mirror of the tree
    let md_root = dir.join("markdown");
    create_dir(&md_root).await?;
    let mirror = mirror_workspace(&paths, &ws, &md_root).await?;
    files += mirror.files;
    bytes += mirror.bytes;

    let manifest = serde_json::json!({
        "app": "Novion",
        "formatVersion": 1,
        "exportedAt": now_ms(),
        "source": paths.root.to_string_lossy(),
        "docs": ws.nodes.iter().filter(|n| n.kind == NodeKind::Doc).count(),
        "files": files,
        "bytes": bytes,
        "layout": {
            "raw": "逐字节副本：workspace.json + docs/ + assets/",
            "markdown": "按目录结构导出的 .md 文件，图片在 markdown/assets/"
        }
    });
    write_json_atomic(&dir.join("manifest.json"), &manifest).await?;
    write_atomic(&dir.join("README.txt"), README.as_bytes()).await?;
    files += 2;

    Ok(ExportResult {
        path: dir.to_string_lossy().to_string(),
        files,
        bytes,
        assets: mirror.assets,
        format: "backup".to_string(),
    })
}

const README: &str = "\
Novion 备份
===========

raw/
  逐字节副本：workspace.json（目录树）、docs/（每篇文档的 TipTap JSON）、
  assets/（图片）。把整个 raw/ 复制回 Novion 的数据目录（默认是系统
  “文档”下的 Novion 文件夹）即可还原工作区。

markdown/
  按文件夹结构导出的 Markdown，适合阅读、搜索或迁移到别的工具。
  图片在 markdown/assets/ 下，相对路径已经处理好在任意子目录打开。

manifest.json
  本次导出的时间、来源目录与文件统计。
";

struct Mirror {
    files: usize,
    bytes: u64,
    assets: usize,
}

/// Writes one `.md` per document, mirroring the sidebar tree.
async fn mirror_workspace(
    paths: &Paths,
    ws: &Workspace,
    md_root: &Path,
) -> AppResult<Mirror> {
    let mut children: HashMap<Option<String>, Vec<&crate::models::Node>> = HashMap::new();
    for node in &ws.nodes {
        children.entry(node.parent_id.clone()).or_default().push(node);
    }
    for list in children.values_mut() {
        list.sort_by(|a, b| a.order.cmp(&b.order).then(a.name.cmp(&b.name)));
    }

    // (parent id, target dir, depth) — the trash subtree is never mirrored
    let mut stack: Vec<(Option<String>, PathBuf, usize)> = vec![(None, md_root.to_path_buf(), 0)];
    let mut used: HashSet<String> = HashSet::new();
    let mut files = 0;
    let mut bytes = 0;

    while let Some((parent, dir, depth)) = stack.pop() {
        let Some(list) = children.get(&parent) else { continue };
        for node in list.clone() {
            if node.builtin == Some(Builtin::Trash) || node.trashed_at.is_some() {
                continue;
            }
            match node.kind {
                NodeKind::Folder => {
                    let name = match node.builtin {
                        Some(Builtin::Completed) => "已归档".to_string(),
                        _ => escape_reserved(safe_name(&node.name, "未命名文件夹")),
                    };
                    let name = fit_stem(&dir, &name, "");
                    let next = dir.join(name);
                    create_dir(&next).await?;
                    stack.push((Some(node.id.clone()), next, depth + 1));
                }
                NodeKind::Doc => {
                    let Ok(file) = paths.doc_file(&node.id) else { continue };
                    let Ok(doc) = read_json::<DocFile>(&file).await else {
                        continue;
                    };
                    let stem = escape_reserved(safe_name(&node.name, "Untitled"));
                    let stem = fit_stem(&dir, &stem, "md");
                    let key = format!("{}/{}", dir.to_string_lossy(), stem.to_lowercase());
                    let stem = if used.insert(key) {
                        stem
                    } else {
                        format!("{stem} ({})", crate::paths::short_id())
                    };
                    let prefix = "../".repeat(depth);
                    let body = markdown::to_markdown(&doc.content, &prefix);
                    let title = if node.name.trim().is_empty() {
                        "Untitled"
                    } else {
                        node.name.as_str()
                    };
                    let payload = format!("# {title}\n\n{body}");
                    let target = unique_path(&dir, &stem, "md");
                    write_atomic(&target, payload.as_bytes()).await?;
                    files += 1;
                    bytes += file_size(&target).await;
                }
            }
        }
    }

    let asset_dir = md_root.join("assets");
    let (asset_files, asset_bytes) = copy_tree(&paths.assets_dir(), &asset_dir).await?;
    files += asset_files;
    bytes += asset_bytes;
    Ok(Mirror {
        files,
        bytes,
        assets: asset_files,
    })
}

// ------------------------------------------------------------------- reveal

/// Shows an exported file or folder in Finder. Only paths under the export /
/// workspace roots are accepted, so this cannot be used to open arbitrary files.
#[tauri::command]
pub async fn reveal_path<R: Runtime>(app: AppHandle<R>, path: String) -> AppResult<()> {
    fn canon(path: &Path) -> PathBuf {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    }

    let target = canon(Path::new(path.trim()));
    if !target.exists() {
        return Err(AppError::not_found("路径不存在"));
    }

    let mut allowed: Vec<PathBuf> = vec![canon(&export_root(&app))];
    for extra in [
        app.path().download_dir().ok(),
        app.path().document_dir().ok(),
        workspace_root(&app).ok(),
    ]
    .into_iter()
    .flatten()
    {
        allowed.push(canon(&extra));
    }
    if !allowed.iter().any(|root| target.starts_with(root)) {
        return Err(AppError::invalid("只能打开导出目录中的文件"));
    }

    // The plugin canonicalises internally (`dunce` on Windows strips the
    // `\\?\` prefix), so it can reveal either a file or a folder.
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| AppError::wrap("打开文件位置失败", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Node;
    use serde_json::json;

    #[test]
    fn names_lose_path_separators() {
        assert_eq!(safe_name("a/b:c", "x"), "a-b-c");
        assert_eq!(safe_name("   ", "未命名"), "未命名");
        assert_eq!(safe_name("...", "未命名"), "未命名");
        assert_eq!(safe_name("正常标题", "x"), "正常标题");
    }

    #[test]
    fn reserved_windows_names_are_escaped() {
        // A document titled "CON" cannot be created on Windows at all.
        assert_eq!(escape_reserved("CON".to_string()), "_CON");
        assert_eq!(escape_reserved("nul".to_string()), "_nul");
        assert_eq!(escape_reserved("com1".to_string()), "_com1");
        // Only the reserved stem is a problem, whatever the extension.
        assert_eq!(escape_reserved("CON.md".to_string()), "_CON.md");
        assert_eq!(escape_reserved("console".to_string()), "console");
        assert_eq!(escape_reserved("COM10".to_string()), "COM10");
    }

    #[test]
    fn long_names_fit_the_path_budget() {
        let dir = Path::new("/tmp/novion");
        // Longer than either budget (220 on Windows, 900 elsewhere).
        let stem = "长".repeat(1200);
        let fitted = fit_stem(dir, &stem, "md");
        assert!(fitted.chars().count() < 1200);
        assert!(!fitted.is_empty());
        // A short name is returned untouched.
        assert_eq!(fit_stem(dir, "short", "md"), "short");
    }

    fn temp_paths() -> Paths {
        let root = std::env::temp_dir().join(format!(
            "novion-export-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Paths::new(root)
    }

    #[tokio::test]
    async fn mirror_mirrors_the_tree_and_keeps_images_relative() {
        let paths = temp_paths();
        paths.ensure_dirs().await.unwrap();

        let doc = DocFile {
            id: "d_a".to_string(),
            title: "第一篇".to_string(),
            created_at: 1,
            updated_at: 2,
            schema_version: 1,
            content: json!({
                "type": "doc",
                "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "正文" }] },
                    { "type": "image", "attrs": { "src": "assets/img_x.png" } }
                ]
            }),
        };
        write_json_atomic(&paths.doc_file(&doc.id).unwrap(), &doc)
            .await
            .unwrap();
        tokio::fs::write(paths.assets_dir().join("img_x.png"), b"png")
            .await
            .unwrap();

        let folder = Node::new(
            "f_sub".to_string(),
            NodeKind::Folder,
            "子目录".to_string(),
            None,
            0,
        );
        let doc_node = Node::new(
            "d_a".to_string(),
            NodeKind::Doc,
            "第一篇".to_string(),
            Some("f_sub".to_string()),
            0,
        );
        let trash = {
            let mut node = Node::new(
                "f_trash".to_string(),
                NodeKind::Folder,
                "回收站".to_string(),
                None,
                1,
            );
            node.builtin = Some(Builtin::Trash);
            node
        };
        let ws = Workspace {
            version: 1,
            updated_at: 3,
            nodes: vec![folder, doc_node, trash],
        };

        let md_root = paths.root.join("markdown");
        let mirror = mirror_workspace(&paths, &ws, &md_root).await.unwrap();

        let file = md_root.join("子目录").join("第一篇.md");
        let text = tokio::fs::read_to_string(&file).await.unwrap();
        assert!(text.starts_with("# 第一篇\n\n正文"), "{text}");
        // one folder deep → images are reached through ../assets
        assert!(text.contains("../assets/img_x.png"), "{text}");
        assert!(md_root.join("assets").join("img_x.png").exists());
        assert_eq!(mirror.assets, 1);
        assert!(!md_root.join("回收站").exists());

        let _ = tokio::fs::remove_dir_all(&paths.root).await;
    }
}
