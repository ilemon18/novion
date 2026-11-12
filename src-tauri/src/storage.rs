use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::atomic::{read_json, write_json_atomic};
use crate::config::{self, Storage};
use crate::error::{AppError, AppResult};
use crate::models::{now_ms, DocFile, Node, NodeKind, Workspace};
use crate::paths::{icloud_available, icloud_root, local_root, Paths};
use crate::workspace;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SwitchMode {
    /// Union both sides; a conflicting doc keeps the newer one and the other is
    /// preserved as "（本机副本）".
    Merge,
    /// Overwrite the target with this machine's data (the target is backed up).
    KeepLocal,
    /// Adopt the target data as-is (this machine's data is backed up).
    UseTarget,
}

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SwitchStats {
    pub docs_copied: usize,
    pub docs_merged: usize,
    pub copies_renamed: usize,
    pub assets_copied: usize,
    pub backup_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageState {
    pub storage: Storage,
    pub active_root: String,
    pub local_root: String,
    pub icloud_root: String,
    /// False on Windows: iCloud Drive only exists on macOS, so the UI hides the
    /// card entirely instead of offering a switch that can never succeed.
    pub icloud_supported: bool,
    pub icloud_available: bool,
    pub local_ready: bool,
    pub icloud_ready: bool,
    pub local_docs: usize,
    pub icloud_docs: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    pub storage: Storage,
    pub root: String,
    pub workspace: Workspace,
    pub stats: SwitchStats,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    done: usize,
    total: usize,
}

fn emit<R: Runtime>(app: &AppHandle<R>, phase: &'static str, done: usize, total: usize) {
    let _ = app.emit("storage:progress", Progress { phase, done, total });
}

async fn count_docs(root: &Path) -> usize {
    let mut count = 0;
    if let Ok(mut dir) = tokio::fs::read_dir(root.join("docs")).await {
        while let Ok(Some(entry)) = dir.next_entry().await {
            if entry.file_name().to_string_lossy().ends_with(".json") {
                count += 1;
            }
        }
    }
    count
}

async fn ready(root: &Path) -> bool {
    tokio::fs::try_exists(root.join("workspace.json"))
        .await
        .unwrap_or(false)
}

#[tauri::command]
pub async fn get_storage_state<R: Runtime>(app: AppHandle<R>) -> AppResult<StorageState> {
    let local = local_root(&app)?;
    let icloud = icloud_root(&app)?;
    let active = crate::paths::workspace_root(&app)?;
    Ok(StorageState {
        storage: config::current(&app),
        active_root: active.to_string_lossy().to_string(),
        local_root: local.to_string_lossy().to_string(),
        icloud_root: icloud.to_string_lossy().to_string(),
        icloud_supported: cfg!(target_os = "macos"),
        icloud_available: icloud_available(&app),
        local_ready: ready(&local).await,
        icloud_ready: ready(&icloud).await,
        local_docs: count_docs(&local).await,
        icloud_docs: count_docs(&icloud).await,
    })
}

// ------------------------------------------------------------------ copying

/// Recursively copies `from` into `to`, overwriting files with the same name.
/// Skips dotfiles, temp files and iCloud placeholders.
pub fn copy_tree<'a>(
    from: &'a Path,
    to: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<usize>> + Send + 'a>> {
    Box::pin(async move {
        tokio::fs::create_dir_all(to)
            .await
            .map_err(|e| AppError::io(&format!("创建目录 {} 失败", to.display()), e))?;
        let mut dir = match tokio::fs::read_dir(from).await {
            Ok(dir) => dir,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(AppError::io(&format!("读取目录 {} 失败", from.display()), e)),
        };
        let mut written = 0;
        while let Some(entry) = dir
            .next_entry()
            .await
            .map_err(|e| AppError::io("遍历目录失败", e))?
        {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();
            if name_str.starts_with('.') || name_str.ends_with(".icloud") || name_str.ends_with(".tmp")
            {
                continue;
            }
            let src = entry.path();
            let dst = to.join(&name);
            let file_type = entry
                .file_type()
                .await
                .map_err(|e| AppError::io("读取文件类型失败", e))?;
            if file_type.is_dir() {
                written += copy_tree(&src, &dst).await?;
            } else {
                tokio::fs::copy(&src, &dst)
                    .await
                    .map_err(|e| AppError::io(&format!("复制 {} 失败", src.display()), e))?;
                written += 1;
            }
        }
        Ok(written)
    })
}

/// Moves `dir` out of the way so a switch never destroys data.
async fn backup_dir(dir: &Path, tag: &str) -> AppResult<Option<PathBuf>> {
    if !tokio::fs::try_exists(dir).await.unwrap_or(false) {
        return Ok(None);
    }
    let Some(parent) = dir.parent() else {
        return Ok(None);
    };
    let base = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Novion".to_string());
    let target = parent.join(format!("{base}.backup-{tag}-{}", now_ms()));
    if tokio::fs::rename(dir, &target).await.is_ok() {
        return Ok(Some(target));
    }
    // cross-volume fallback: copy and leave the original in place
    copy_tree(dir, &target).await?;
    Ok(Some(target))
}

// ------------------------------------------------------------------- merge

fn find_node(nodes: &[Node], id: &str) -> Option<Node> {
    nodes.iter().find(|n| n.id == id).cloned()
}

fn next_order(nodes: &[Node], parent: Option<&str>) -> i64 {
    nodes
        .iter()
        .filter(|n| n.parent_id.as_deref() == parent && n.builtin.is_none())
        .map(|n| n.order)
        .max()
        .map(|o| o + 1)
        .unwrap_or(0)
}

/// Makes sure the folder chain above `id` exists in `dst`, keeping source ids.
fn ensure_ancestors(src: &[Node], dst: &mut Workspace, id: Option<&str>) {
    let mut chain: Vec<Node> = Vec::new();
    let mut cursor = id.and_then(|id| find_node(src, id));
    let mut guard = 0;
    while let Some(node) = cursor {
        chain.push(node.clone());
        cursor = node.parent_id.as_deref().and_then(|p| find_node(src, p));
        guard += 1;
        if guard > 128 {
            break;
        }
    }
    chain.reverse();

    for node in chain {
        if find_node(&dst.nodes, &node.id).is_some() {
            continue;
        }
        // builtin folders already exist on the target side
        if node.builtin.is_some() {
            continue;
        }
        let mut copy = Node::new(
            node.id.clone(),
            node.kind,
            node.name.clone(),
            node.parent_id.clone(),
            next_order(&dst.nodes, node.parent_id.as_deref()),
        );
        copy.created_at = node.created_at;
        copy.updated_at = node.updated_at;
        dst.nodes.push(copy);
    }
}

fn unique_name(nodes: &[Node], base: &str) -> String {
    let mut candidate = format!("{base}（本机副本）");
    let mut i = 2;
    while nodes.iter().any(|n| n.name == candidate) {
        candidate = format!("{base}（本机副本 {i}）");
        i += 1;
    }
    candidate
}

fn rewrite_asset_refs(content: &Value, map: &[(String, String)]) -> Value {
    if map.is_empty() {
        return content.clone();
    }
    fn walk(value: &Value, map: &[(String, String)]) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(|v| walk(v, map)).collect()),
            Value::Object(obj) => {
                let is_image = obj.get("type").and_then(Value::as_str) == Some("image");
                let mut out = serde_json::Map::new();
                for (key, val) in obj {
                    if is_image && key == "attrs" {
                        if let Value::Object(attrs) = val {
                            let mut attrs_out = serde_json::Map::new();
                            for (attr_key, attr_val) in attrs {
                                if let Some(text) = attr_val.as_str() {
                                    if let Some((from, to)) =
                                        map.iter().find(|(from, _)| text.contains(from.as_str()))
                                    {
                                        attrs_out.insert(
                                            attr_key.clone(),
                                            Value::String(text.replace(from.as_str(), to.as_str())),
                                        );
                                        continue;
                                    }
                                }
                                attrs_out.insert(attr_key.clone(), walk(attr_val, map));
                            }
                            out.insert(key.clone(), Value::Object(attrs_out));
                            continue;
                        }
                    }
                    out.insert(key.clone(), walk(val, map));
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    walk(content, map)
}

/// Copies `bytes` to `assets/<name>`, picking a free `_copy` name when the
/// target already holds a *different* file under the same name.
async fn place_asset(to: &Paths, rel: &str, bytes: &[u8]) -> AppResult<Option<String>> {
    let dst_file = to.asset_file(rel)?;
    if let Ok(existing) = tokio::fs::read(&dst_file).await {
        if existing == bytes {
            return Ok(None);
        }
        let (stem, ext) = rel.rsplit_once('.').unwrap_or((rel, "png"));
        for i in 1..100 {
            let candidate = if i == 1 {
                format!("{stem}_copy.{ext}")
            } else {
                format!("{stem}_copy{i}.{ext}")
            };
            let Ok(path) = to.asset_file(&candidate) else {
                continue;
            };
            match tokio::fs::read(&path).await {
                Ok(existing) => {
                    if existing == bytes {
                        return Ok(Some(candidate));
                    }
                }
                Err(_) => {
                    tokio::fs::write(&path, bytes)
                        .await
                        .map_err(|e| AppError::io("写入图片失败", e))?;
                    return Ok(Some(candidate));
                }
            }
        }
        return Ok(None);
    }
    tokio::fs::write(&dst_file, bytes)
        .await
        .map_err(|e| AppError::io("写入图片失败", e))?;
    Ok(None)
}

/// Copies one document plus the images it references into the target.
async fn copy_doc_with_assets(
    from: &Paths,
    to: &Paths,
    doc: &DocFile,
    new_id: Option<&str>,
    new_title: Option<&str>,
    stats: &mut SwitchStats,
) -> AppResult<DocFile> {
    let mut renames: Vec<(String, String)> = Vec::new();

    for rel in crate::assets::collect_asset_refs(&doc.content) {
        let Ok(src_file) = from.asset_file(&rel) else {
            continue;
        };
        let Ok(bytes) = tokio::fs::read(&src_file).await else {
            continue;
        };
        match place_asset(to, &rel, &bytes).await {
            Ok(Some(renamed)) => renames.push((rel, renamed)),
            Ok(None) => stats.assets_copied += 1,
            Err(_) => {}
        }
    }

    let content = rewrite_asset_refs(&doc.content, &renames);
    let id = new_id.unwrap_or(&doc.id).to_string();
    let out = DocFile {
        id: id.clone(),
        title: new_title
            .map(|t| t.to_string())
            .unwrap_or_else(|| doc.title.clone()),
        created_at: doc.created_at,
        updated_at: now_ms(),
        schema_version: 1,
        content,
    };
    write_json_atomic(&to.doc_file(&id)?, &out).await?;
    Ok(out)
}

fn docs_differ(a: &DocFile, b: &DocFile) -> bool {
    a.content != b.content || a.title != b.title
}

/// Unions the source workspace into the target one.
async fn merge_into<R: Runtime>(app: &AppHandle<R>, from: &Paths, to: &Paths) -> AppResult<SwitchStats> {
    let src_ws = workspace::load(from).await?;
    let mut dst_ws = workspace::load(to).await?;
    let mut stats = SwitchStats::default();

    let folders: Vec<Node> = src_ws
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Folder && n.builtin.is_none())
        .cloned()
        .collect();
    let docs: Vec<Node> = src_ws
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Doc)
        .cloned()
        .collect();
    let total = folders.len() + docs.len();
    emit(app, "merge", 0, total);

    for (index, folder) in folders.iter().enumerate() {
        ensure_ancestors(&src_ws.nodes, &mut dst_ws, Some(&folder.id));
        emit(app, "merge", index + 1, total);
    }

    for (index, node) in docs.iter().enumerate() {
        let done = folders.len() + index + 1;
        ensure_ancestors(&src_ws.nodes, &mut dst_ws, node.parent_id.as_deref());

        let src_doc = match read_json::<DocFile>(&from.doc_file(&node.id)?).await {
            Ok(doc) => doc,
            Err(_) => {
                emit(app, "merge", done, total);
                continue;
            }
        };

        match find_node(&dst_ws.nodes, &node.id) {
            None => {
                let mut copy = Node::new(
                    node.id.clone(),
                    NodeKind::Doc,
                    node.name.clone(),
                    node.parent_id.clone(),
                    next_order(&dst_ws.nodes, node.parent_id.as_deref()),
                );
                copy.created_at = node.created_at;
                copy.updated_at = node.updated_at;
                dst_ws.nodes.push(copy);
                copy_doc_with_assets(from, to, &src_doc, None, None, &mut stats).await?;
                stats.docs_copied += 1;
            }
            Some(existing) => {
                let dst_doc = read_json::<DocFile>(&to.doc_file(&existing.id)?)
                    .await
                    .ok();
                let target_newer = match &dst_doc {
                    Some(other) => {
                        existing.updated_at >= node.updated_at
                            && other.updated_at >= src_doc.updated_at
                    }
                    None => false,
                };

                if !target_newer {
                    copy_doc_with_assets(from, to, &src_doc, None, None, &mut stats).await?;
                    if let Some(target) = dst_ws.nodes.iter_mut().find(|n| n.id == existing.id) {
                        target.name = node.name.clone();
                        target.updated_at = node.updated_at.max(existing.updated_at);
                    }
                    stats.docs_merged += 1;
                } else if dst_doc.as_ref().is_some_and(|other| docs_differ(&src_doc, other)) {
                    let new_id = format!("d_{}", crate::paths::short_id());
                    let title = unique_name(&dst_ws.nodes, &node.name);
                    let mut copy = Node::new(
                        new_id.clone(),
                        NodeKind::Doc,
                        title.clone(),
                        node.parent_id.clone(),
                        next_order(&dst_ws.nodes, node.parent_id.as_deref()),
                    );
                    copy.created_at = node.created_at;
                    dst_ws.nodes.push(copy);
                    copy_doc_with_assets(from, to, &src_doc, Some(&new_id), Some(&title), &mut stats)
                        .await?;
                    stats.copies_renamed += 1;
                }
            }
        }
        emit(app, "merge", done, total);
    }

    dst_ws.updated_at = now_ms();
    workspace::save(to, &dst_ws).await?;
    Ok(stats)
}

// ------------------------------------------------------------------ switch

#[tauri::command]
pub async fn set_storage<R: Runtime>(
    app: AppHandle<R>,
    target: Storage,
    mode: SwitchMode,
) -> AppResult<SwitchResult> {
    let local = local_root(&app)?;
    let icloud = icloud_root(&app)?;
    let (from_root, to_root) = match target {
        Storage::Local => (icloud.clone(), local.clone()),
        Storage::Icloud => (local.clone(), icloud.clone()),
    };

    if target == Storage::Icloud && !icloud_available(&app) {
        return Err(AppError::new(
            "icloud_unavailable",
            "未检测到 iCloud 云盘，请先在系统设置里登录 iCloud 并开启「iCloud 云盘」",
        ));
    }

    // step 1: already on the requested storage — nothing to move
    if config::current(&app) == target {
        let paths = Paths::new(to_root.clone());
        paths.ensure_dirs().await?;
        let mut ws = workspace::load(&paths).await?;
        if workspace::ensure_builtin(&mut ws) {
            workspace::save(&paths, &ws).await?;
        }
        return Ok(SwitchResult {
            storage: target,
            root: to_root.to_string_lossy().to_string(),
            workspace: ws,
            stats: SwitchStats::default(),
        });
    }

    let from = Paths::new(from_root.clone());
    let to = Paths::new(to_root.clone());
    to.ensure_dirs().await?;

    let mut stats = SwitchStats::default();

    // step 2: the target holds no workspace yet — a plain copy has no conflicts
    if !ready(&to_root).await {
        emit(&app, "copy", 0, 1);
        copy_tree(&from_root, &to_root).await?;
        stats.docs_copied = count_docs(&to_root).await;
        emit(&app, "copy", 1, 1);
    } else {
        // step 3: both sides carry data — follow the user's choice
        match mode {
            SwitchMode::UseTarget => {
                stats.backup_path = backup_dir(&from_root, "before-switch")
                    .await?
                    .map(|p| p.to_string_lossy().to_string());
            }
            SwitchMode::KeepLocal => {
                stats.backup_path = backup_dir(&to_root, "before-switch")
                    .await?
                    .map(|p| p.to_string_lossy().to_string());
                to.ensure_dirs().await?;
                copy_tree(&from_root, &to_root).await?;
                stats.docs_copied = count_docs(&to_root).await;
            }
            SwitchMode::Merge => {
                // keep the target manifest around before the merge rewrites it
                let manifest = to_root.join("workspace.json");
                if tokio::fs::try_exists(&manifest).await.unwrap_or(false) {
                    let backup = to_root.join(format!("workspace.backup-{}.json", now_ms()));
                    let _ = tokio::fs::copy(&manifest, &backup).await;
                }
                let merged = merge_into(&app, &from, &to).await?;
                stats.docs_copied = merged.docs_copied;
                stats.docs_merged = merged.docs_merged;
                stats.copies_renamed = merged.copies_renamed;
                stats.assets_copied = merged.assets_copied;
            }
        }
    }

    // step 4: persist the choice, widen the asset scope, hand back the tree
    config::set(&app, target)?;
    app.asset_protocol_scope()
        .allow_directory(&to_root, true)
        .map_err(|e| AppError::new("asset_scope", format!("放行资源目录失败：{e}")))?;

    // a freshly created target may have no manifest yet (or an old one without
    // the system folders); make sure the switched-to tree is usable
    let mut ws = workspace::load(&to).await?;
    if workspace::ensure_builtin(&mut ws) {
        workspace::save(&to, &ws).await?;
    }
    Ok(SwitchResult {
        storage: target,
        root: to_root.to_string_lossy().to_string(),
        workspace: ws,
        stats,
    })
}

#[tauri::command]
pub async fn reveal_storage_folder<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    let root = crate::paths::workspace_root(&app)?;
    let path = if root.exists() {
        root
    } else {
        root.parent().map(|p| p.to_path_buf()).unwrap_or(root)
    };
    // `open_path` opens the folder itself (Finder window / Explorer window),
  // which is what "show the data folder" used to do with `open <dir>`.
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::wrap("打开数据目录失败", e))?;
    Ok(())
}
