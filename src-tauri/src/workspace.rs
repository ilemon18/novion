use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Runtime};

use crate::atomic::{read_json, write_json_atomic};
use crate::error::{AppError, AppResult};
use crate::models::{
    empty_doc, now_ms, Builtin, CreatedFolder, DocFile, Node, NodeKind, Workspace,
};
use crate::paths::{short_id, workspace_root, Paths};

/// Stable ids for the two system folders so they survive any workspace rewrite.
pub const COMPLETED_ID: &str = "f_completed";
pub const TRASH_ID: &str = "f_trash";

pub async fn load(paths: &Paths) -> AppResult<Workspace> {
    let file = paths.workspace_file();
    let mut ws = if !tokio::fs::try_exists(&file)
        .await
        .map_err(|e| AppError::io("检查 workspace.json 失败", e))?
    {
        Workspace::default()
    } else {
        read_json::<Workspace>(&file).await?
    };
    ensure_builtin(&mut ws);
    Ok(ws)
}

/// Adds the two system folders when they are missing (fresh or migrated file).
/// Returns `true` when the workspace changed and should be persisted.
pub fn ensure_builtin(ws: &mut Workspace) -> bool {
    let wanted = [
        (COMPLETED_ID, "已归档", Builtin::Completed, 1u8),
        (TRASH_ID, "回收站", Builtin::Trash, 2u8),
    ];
    let mut changed = false;
    for (id, name, kind, slot) in wanted {
        match find_mut(&mut ws.nodes, &id) {
            Some(node) => {
                // keep the node coherent even if the file was hand-edited
                if node.builtin != Some(kind) || node.kind != NodeKind::Folder {
                    node.builtin = Some(kind);
                    node.kind = NodeKind::Folder;
                    node.parent_id = None;
                    changed = true;
                }
            }
            None => {
                let mut node = Node::new(
                    id.to_string(),
                    NodeKind::Folder,
                    name.to_string(),
                    None,
                    i64::MAX - 10 + slot as i64,
                );
                node.builtin = Some(kind);
                ws.nodes.push(node);
                changed = true;
            }
        }
    }

    // Copy migration: this folder used to be called 「已完成」. Only the old
    // default is renamed, so a workspace that was hand-edited keeps its name.
    if let Some(node) = find_mut(&mut ws.nodes, COMPLETED_ID) {
        if node.name == "已完成" {
            node.name = "已归档".to_string();
            node.updated_at = now_ms();
            changed = true;
        }
    }

    changed
}

pub async fn save(paths: &Paths, ws: &Workspace) -> AppResult<()> {
    write_json_atomic(&paths.workspace_file(), ws).await?;
    // the tree that is now on disk is exactly `ws`: remember it instead of
    // making the next reader parse the file again
    if let Ok(meta) = tokio::fs::metadata(paths.workspace_file()).await {
        remember_snapshot(paths, stamp_of(&meta), Arc::new(ws.clone()));
    }
    Ok(())
}

// ------------------------------------------------------- shared snapshot

/// A parsed `workspace.json` plus the (mtime, size) it was parsed from.
struct Snapshot {
    mtime: u64,
    len: u64,
    ws: Arc<Workspace>,
}

/// Read-only commands (`search`, `backlinks`, export, Notion) all need the tree.
/// Re-parsing it per call made a search keystroke decode the whole workspace;
/// this hands out an `Arc` while the file is unchanged.
static SNAPSHOT: OnceLock<Mutex<HashMap<PathBuf, Snapshot>>> = OnceLock::new();

fn snapshots() -> &'static Mutex<HashMap<PathBuf, Snapshot>> {
    SNAPSHOT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stamp_of(meta: &std::fs::Metadata) -> (u64, u64) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (mtime, meta.len())
}

fn remember_snapshot(paths: &Paths, (mtime, len): (u64, u64), ws: Arc<Workspace>) {
    if let Ok(mut map) = snapshots().lock() {
        // a storage switch leaves the other root behind: keep the map tiny
        if map.len() > 4 && !map.contains_key(&paths.root) {
            map.clear();
        }
        map.insert(paths.root.clone(), Snapshot { mtime, len, ws });
    }
}

/// The workspace tree, reused while `workspace.json` is unchanged.
///
/// Callers must treat the result as immutable; mutations go through [`load`]
/// + [`save`], and `save` refreshes this snapshot.
pub async fn load_shared(paths: &Paths) -> AppResult<Arc<Workspace>> {
    let file = paths.workspace_file();
    let stamp = tokio::fs::metadata(&file).await.ok().map(|m| stamp_of(&m));
    if let Some((mtime, len)) = stamp {
        let hit = snapshots().lock().ok().and_then(|map| {
            map.get(&paths.root)
                .filter(|entry| entry.mtime == mtime && entry.len == len)
                .map(|entry| entry.ws.clone())
        });
        if let Some(ws) = hit {
            return Ok(ws);
        }
    }
    let ws = Arc::new(load(paths).await?);
    if let Some(stamp) = stamp {
        remember_snapshot(paths, stamp, ws.clone());
    }
    Ok(ws)
}

/// Looks a node up by id. Borrowed on purpose: the tree holds every node and
/// the commands only ever read a couple of fields, so cloning the node (five
/// `String`s) on each lookup was pure allocation churn.
fn find<'a>(nodes: &'a [Node], id: &str) -> Option<&'a Node> {
    nodes.iter().find(|n| n.id == id)
}

fn find_mut<'a>(nodes: &'a mut [Node], id: &str) -> Option<&'a mut Node> {
    nodes.iter_mut().find(|n| n.id == id)
}

/// `id -> index` for a single workspace snapshot.
fn id_index(nodes: &[Node]) -> std::collections::HashMap<&str, usize> {
    nodes
        .iter()
        .enumerate()
        .map(|(i, node)| (node.id.as_str(), i))
        .collect()
}

/// Siblings of one parent in display order: pinned documents first (newest pin
/// first), then the manual order. Drag & drop, `renumber` and the sidebar all
/// rely on this single ordering.
fn siblings(nodes: &[Node], parent: Option<&str>) -> Vec<String> {
    let mut list: Vec<&Node> = nodes
        .iter()
        .filter(|n| n.parent_id.as_deref() == parent && n.builtin.is_none())
        .collect();
    list.sort_by(|a, b| {
        let a_pinned = a.pinned_at.is_some();
        let b_pinned = b.pinned_at.is_some();
        b_pinned
            .cmp(&a_pinned)
            .then(b.pinned_at.unwrap_or(0).cmp(&a.pinned_at.unwrap_or(0)))
            .then(a.order.cmp(&b.order))
            .then(a.created_at.cmp(&b.created_at))
    });
    list.into_iter().map(|n| n.id.clone()).collect()
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

/// A node is trashed when it is the trash subtree root or lives under one.
pub(crate) fn in_trash(nodes: &[Node], id: &str) -> bool {
    let mut cursor = find(nodes, id);
    let mut guard = 0;
    while let Some(node) = cursor {
        if node.trashed_at.is_some() || node.builtin == Some(Builtin::Trash) {
            return true;
        }
        cursor = node.parent_id.as_deref().and_then(|p| find(nodes, p));
        guard += 1;
        if guard > 128 {
            break;
        }
    }
    false
}

fn renumber(ws: &mut Workspace, parent: Option<&str>) {
    let ids = siblings(&ws.nodes, parent);
    // a map lookup instead of a linear scan per sibling (was O(n^2) and
    // allocated a fresh id string per comparison); the positions are resolved
    // first so the borrow ends before the nodes are written
    let positions: Vec<Option<usize>> = {
        let index = id_index(&ws.nodes);
        ids.iter()
            .map(|id| index.get(id.as_str()).copied())
            .collect()
    };
    for (i, at) in positions.into_iter().enumerate() {
        if let Some(at) = at {
            ws.nodes[at].order = i as i64;
        }
    }
}
fn subtree_ids(nodes: &[Node], root: &str) -> Vec<String> {
    // children index first, then a BFS: the previous version scanned the whole
    // node list once per visited node
    let mut kids: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    for node in nodes {
        if let Some(parent) = node.parent_id.as_deref() {
            kids.entry(parent).or_default().push(node.id.as_str());
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut queue: Vec<&str> = vec![root];
    while let Some(current) = queue.pop() {
        out.push(current.to_string());
        if let Some(children) = kids.get(current) {
            queue.extend(children.iter().copied());
        }
    }
    out
}

fn is_descendant(nodes: &[Node], ancestor: &str, id: &str) -> bool {
    let mut cursor = find(nodes, id);
    let mut guard = 0;
    while let Some(node) = cursor {
        if node.parent_id.as_deref() == Some(ancestor) {
            return true;
        }
        cursor = node.parent_id.as_deref().and_then(|p| find(nodes, p));
        guard += 1;
        if guard > 128 {
            break;
        }
    }
    false
}

fn validate_parent(nodes: &[Node], parent: Option<&str>) -> AppResult<()> {
    if let Some(pid) = parent {
        let node = find(nodes, pid).ok_or_else(|| AppError::not_found("父级不存在"))?;
        if node.kind != NodeKind::Folder {
            return Err(AppError::invalid("父级必须是文件夹"));
        }
        if node.builtin.is_some() {
            return Err(AppError::invalid("该分组由系统维护，不能手动放入内容"));
        }
    }
    Ok(())
}

fn clean_name(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(160).collect()
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub async fn get_workspace_root<R: Runtime>(app: AppHandle<R>) -> AppResult<String> {
    Ok(workspace_root(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn ensure_workspace<R: Runtime>(
    app: AppHandle<R>,
    language: Option<String>,
) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    paths.ensure_dirs().await?;

    let file = paths.workspace_file();
    let exists = tokio::fs::try_exists(&file)
        .await
        .map_err(|e| AppError::io("检查 workspace.json 失败", e))?;

    if !exists {
        let now = now_ms();
        let doc_id = format!("d_{}", short_id());
        // the first-run note follows the interface language chosen at boot
        let title = welcome_title(language.as_deref().unwrap_or("en"));
        let mut ws = Workspace {
            version: 1,
            updated_at: now,
            nodes: vec![Node::new(
                doc_id.clone(),
                NodeKind::Doc,
                title.to_string(),
                None,
                0,
            )],
        };
        ensure_builtin(&mut ws);
        save(&paths, &ws).await?;

        let doc = DocFile {
            id: doc_id,
            title: title.to_string(),
            created_at: now,
            updated_at: now,
            schema_version: 1,
            content: sample_content(language.as_deref().unwrap_or("en"))?,
        };
        write_json_atomic(&paths.doc_file(&doc.id)?, &doc).await?;
        ws.updated_at = now;
        return Ok(ws);
    }

    // migrated files gain the two system folders on first open
    let mut ws = load(&paths).await?;
    if ensure_builtin(&mut ws) {
        save(&paths, &ws).await?;
    }
    Ok(ws)
}

#[tauri::command]
pub async fn create_folder<R: Runtime>(
    app: AppHandle<R>,
    parent_id: Option<String>,
    name: String,
) -> AppResult<CreatedFolder> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    validate_parent(&ws.nodes, parent_id.as_deref())?;

    let now = now_ms();
    let order = next_order(&ws.nodes, parent_id.as_deref());
    let folder_id = format!("f_{}", short_id());
    ws.nodes.push(Node::new(
        folder_id.clone(),
        NodeKind::Folder,
        clean_name(&name, "New folder"),
        parent_id.clone(),
        order,
    ));
    ws.updated_at = now;
    save(&paths, &ws).await?;
    Ok(CreatedFolder {
        workspace: ws,
        folder_id,
    })
}

#[tauri::command]
pub async fn rename_folder<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    name: String,
) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    let node = find(&ws.nodes, &id).ok_or_else(|| AppError::not_found("文件夹不存在"))?;
    if node.kind != NodeKind::Folder {
        return Err(AppError::invalid("目标不是文件夹"));
    }
    if node.builtin.is_some() {
        return Err(AppError::invalid("系统分组不能重命名"));
    }
    let clean = clean_name(&name, "New folder");
    if let Some(target) = find_mut(&mut ws.nodes, &id) {
        target.name = clean;
        target.updated_at = now_ms();
    }
    ws.updated_at = now_ms();
    save(&paths, &ws).await?;
    Ok(ws)
}

#[tauri::command]
pub async fn delete_folder<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    let node = find(&ws.nodes, &id).ok_or_else(|| AppError::not_found("文件夹不存在"))?;
    if node.kind != NodeKind::Folder {
        return Err(AppError::invalid("目标不是文件夹"));
    }
    if node.builtin.is_some() {
        return Err(AppError::invalid("系统分组不能删除"));
    }

    trash_node(&mut ws, &id);
    save(&paths, &ws).await?;
    Ok(ws)
}

/// Deletes are recoverable: the node and its subtree are parked in 回收站.
fn trash_node(ws: &mut Workspace, id: &str) {
    let Some(node) = find(&ws.nodes, id) else { return };
    let old_parent = node.parent_id.clone();
    let now = now_ms();
    let order = next_order(&ws.nodes, Some(TRASH_ID));
    if let Some(target) = find_mut(&mut ws.nodes, &id) {
        if target.trashed_at.is_none() {
            target.origin_parent = Some(old_parent.clone().unwrap_or_default());
        }
        target.parent_id = Some(TRASH_ID.to_string());
        target.order = order;
        target.trashed_at = Some(now);
        target.completed_at = None;
        target.pinned_at = None;
        target.updated_at = now;
    }
    if let Some(pid) = old_parent {
        renumber(ws, Some(&pid));
    }
    ws.updated_at = now;
}

/// Where a stored node should go back to; `None` falls back to the root.
fn restore_parent_of(nodes: &[Node], node: &Node) -> Option<String> {
    let origin = node.origin_parent.clone().unwrap_or_default();
    if origin.is_empty() {
        return None;
    }
    let parent = find(nodes, &origin)?;
    if parent.kind != NodeKind::Folder || parent.builtin == Some(Builtin::Trash) {
        return None;
    }
    if parent.builtin.is_none() && in_trash(nodes, &parent.id) {
        return None;
    }
    Some(parent.id.clone())
}

fn unarchive(ws: &mut Workspace, id: &str) -> AppResult<()> {
    let node = find(&ws.nodes, id).ok_or_else(|| AppError::not_found("节点不存在"))?;
    let parent = restore_parent_of(&ws.nodes, &node);
    let order = next_order(&ws.nodes, parent.as_deref());
    let now = now_ms();
    if let Some(target) = find_mut(&mut ws.nodes, &id) {
        target.parent_id = parent.clone();
        target.order = order;
        target.trashed_at = None;
        target.completed_at = None;
        target.origin_parent = None;
        target.updated_at = now;
    }
    if let Some(pid) = parent {
        renumber(ws, Some(&pid));
    }
    ws.updated_at = now;
    Ok(())
}

#[tauri::command]
pub async fn restore_node<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    unarchive(&mut ws, &id)?;
    save(&paths, &ws).await?;
    Ok(ws)
}

#[tauri::command]
pub async fn set_completed<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    completed: bool,
) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    let node = find(&ws.nodes, &id).ok_or_else(|| AppError::not_found("文档不存在"))?;
    if node.kind != NodeKind::Doc {
        return Err(AppError::invalid("只有文档可以归档"));
    }

    if !completed {
        unarchive(&mut ws, &id)?;
    } else {
        if in_trash(&ws.nodes, &id) {
            return Err(AppError::invalid("回收站中的文档不能归档"));
        }
        let old_parent = node.parent_id.clone();
        let now = now_ms();
        let order = next_order(&ws.nodes, Some(COMPLETED_ID));
        if let Some(target) = find_mut(&mut ws.nodes, &id) {
            if old_parent.as_deref() != Some(COMPLETED_ID) {
                target.origin_parent = Some(old_parent.clone().unwrap_or_default());
            }
            target.parent_id = Some(COMPLETED_ID.to_string());
            target.order = order;
            target.completed_at = Some(now);
            target.pinned_at = None;
            target.updated_at = now;
        }
        if let Some(pid) = old_parent {
            renumber(&mut ws, Some(&pid));
        }
        ws.updated_at = now;
    }

    save(&paths, &ws).await?;
    Ok(ws)
}

/// Pins a document to the top of its folder (only documents can be pinned).
#[tauri::command]
pub async fn set_pinned<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    pinned: bool,
) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    let node = find(&ws.nodes, &id).ok_or_else(|| AppError::not_found("文档不存在"))?;
    if node.kind != NodeKind::Doc {
        return Err(AppError::invalid("只有文档可以置顶"));
    }
    if in_trash(&ws.nodes, &id) {
        return Err(AppError::invalid("回收站中的文档不能置顶"));
    }

    let now = now_ms();
    if let Some(target) = find_mut(&mut ws.nodes, &id) {
        target.pinned_at = if pinned { Some(now) } else { None };
        target.updated_at = now;
    }
    ws.updated_at = now;
    save(&paths, &ws).await?;
    Ok(ws)
}

#[tauri::command]
pub async fn purge_node<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    let node = find(&ws.nodes, &id).ok_or_else(|| AppError::not_found("节点不存在"))?;
    if node.builtin.is_some() {
        return Err(AppError::invalid("系统分组不能删除"));
    }
    if !in_trash(&ws.nodes, &id) {
        return Err(AppError::invalid("只有回收站中的内容可以永久删除"));
    }

    let doomed = subtree_ids(&ws.nodes, &id);
    let doc_files: Vec<String> = ws
        .nodes
        .iter()
        .filter(|n| doomed.contains(&n.id) && n.kind == NodeKind::Doc)
        .map(|n| n.id.clone())
        .collect();
    ws.nodes.retain(|n| !doomed.contains(&n.id));
    ws.updated_at = now_ms();
    save(&paths, &ws).await?;

    let orphaned = purge_doc_files(&paths, &doc_files).await;
    crate::assets::remove_assets(&paths, &orphaned).await;
    Ok(ws)
}

#[tauri::command]
pub async fn empty_trash<R: Runtime>(app: AppHandle<R>) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;

    let mut doomed = vec![TRASH_ID.to_string()];
    for child in siblings(&ws.nodes, Some(TRASH_ID)) {
        doomed.extend(subtree_ids(&ws.nodes, &child));
    }
    doomed.remove(0); // keep the trash folder itself

    let doc_files: Vec<String> = ws
        .nodes
        .iter()
        .filter(|n| doomed.contains(&n.id) && n.kind == NodeKind::Doc)
        .map(|n| n.id.clone())
        .collect();
    ws.nodes.retain(|n| !doomed.contains(&n.id));
    ws.updated_at = now_ms();
    save(&paths, &ws).await?;

    let orphaned = purge_doc_files(&paths, &doc_files).await;
    crate::assets::remove_assets(&paths, &orphaned).await;
    Ok(ws)
}

/// Deletes the document files and returns the asset refs that no longer belong
/// to any document (the caller removes the actual image files).
async fn purge_doc_files(paths: &Paths, doc_ids: &[String]) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    for doc_id in doc_ids {
        let Ok(file) = paths.doc_file(doc_id) else {
            continue;
        };
        if let Ok(doc) = read_json::<DocFile>(&file).await {
            candidates.extend(crate::assets::collect_asset_refs(&doc.content));
        }
        let _ = tokio::fs::remove_file(&file).await;
        crate::history::purge(paths, doc_id).await;
    }
    candidates.sort();
    candidates.dedup();

    // one scan answers every candidate (this used to parse the whole docs/
    // folder once per candidate ref)
    let still_used = crate::assets::refs_used_elsewhere(paths, "").await;
    candidates
        .into_iter()
        .filter(|rel| !still_used.contains(rel))
        .collect()
}

#[tauri::command]
pub async fn create_doc<R: Runtime>(
    app: AppHandle<R>,
    parent_id: Option<String>,
    title: String,
) -> AppResult<crate::models::CreatedDoc> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    validate_parent(&ws.nodes, parent_id.as_deref())?;

    let now = now_ms();
    let id = format!("d_{}", short_id());
    // an empty title renders as the "Untitled" placeholder in the UI
    let name = title.trim().chars().take(160).collect::<String>();
    let order = next_order(&ws.nodes, parent_id.as_deref());

    ws.nodes.push(Node::new(
        id.clone(),
        NodeKind::Doc,
        name.clone(),
        parent_id.clone(),
        order,
    ));
    ws.updated_at = now;
    save(&paths, &ws).await?;

    let doc = DocFile {
        id: id.clone(),
        title: name,
        created_at: now,
        updated_at: now,
        schema_version: 1,
        content: empty_doc(),
    };
    write_json_atomic(&paths.doc_file(&id)?, &doc).await?;

    Ok(crate::models::CreatedDoc {
        workspace: ws,
        doc_id: id,
    })
}

#[tauri::command]
pub async fn rename_doc<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    title: String,
) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    let clean = clean_name(&title, "Untitled");

    if let Some(node) = find_mut(&mut ws.nodes, &id) {
        if node.kind != NodeKind::Doc {
            return Err(AppError::invalid("目标不是文档"));
        }
        node.name = clean.clone();
        node.updated_at = now_ms();
    } else {
        return Err(AppError::not_found("文档不存在"));
    }
    ws.updated_at = now_ms();
    save(&paths, &ws).await?;

    // keep the document file's mirrored title in sync (best effort)
    let file = paths.doc_file(&id)?;
    if tokio::fs::try_exists(&file).await.unwrap_or(false) {
        if let Ok(mut doc) = read_json::<DocFile>(&file).await {
            doc.title = clean;
            let _ = write_json_atomic(&file, &doc).await;
        }
    }
    Ok(ws)
}

#[tauri::command]
pub async fn delete_doc<R: Runtime>(app: AppHandle<R>, id: String) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;
    let node = find(&ws.nodes, &id).ok_or_else(|| AppError::not_found("文档不存在"))?;
    if node.kind != NodeKind::Doc {
        return Err(AppError::invalid("目标不是文档"));
    }
    trash_node(&mut ws, &id);
    save(&paths, &ws).await?;
    Ok(ws)
}

#[tauri::command]
pub async fn move_node<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    parent_id: Option<String>,
    index: i64,
) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = load(&paths).await?;

    let node = find(&ws.nodes, &id).ok_or_else(|| AppError::not_found("节点不存在"))?;
    if node.builtin.is_some() {
        return Err(AppError::invalid("系统分组不能移动"));
    }
    validate_parent(&ws.nodes, parent_id.as_deref())?;
    if parent_id.as_deref() == Some(id.as_str()) {
        return Err(AppError::invalid("不能移动到自身内部"));
    }
    if let Some(pid) = parent_id.as_deref() {
        if is_descendant(&ws.nodes, &id, pid) {
            return Err(AppError::invalid("不能移动到自己的子层级"));
        }
    }

    let old_parent = node.parent_id.clone();
    let mut order = siblings(&ws.nodes, parent_id.as_deref());
    order.retain(|x| x != &id);
    let at = (index.max(0) as usize).min(order.len());
    order.insert(at, id.clone());

    if let Some(target) = find_mut(&mut ws.nodes, &id) {
        target.parent_id = parent_id.clone();
        target.updated_at = now_ms();
        // dragging out of 已归档 / 回收站 clears that state
        if parent_id.as_deref() != Some(TRASH_ID) {
            target.trashed_at = None;
        }
        if parent_id.as_deref() != Some(COMPLETED_ID) {
            target.completed_at = None;
        }
        if parent_id.as_deref() != Some(COMPLETED_ID) && parent_id.as_deref() != Some(TRASH_ID) {
            target.origin_parent = None;
        }
    }
    for (i, sid) in order.iter().enumerate() {
        if let Some(n) = find_mut(&mut ws.nodes, sid) {
            n.order = i as i64;
        }
    }
    if old_parent != parent_id {
        renumber(&mut ws, old_parent.as_deref());
    }
    renumber(&mut ws, parent_id.as_deref());

    ws.updated_at = now_ms();
    save(&paths, &ws).await?;
    Ok(ws)
}

/// Restores a whole workspace snapshot (the front end's undo stack).
///
/// Only the tree is replaced — document bodies are untouched, so undoing a
/// rename, move, archive or "move to trash" is a single `workspace.json`
/// write. Deleting from the trash is not undoable on purpose: those files are
/// gone and a resurrected node would point at nothing.
#[tauri::command]
pub async fn restore_workspace<R: Runtime>(
    app: AppHandle<R>,
    workspace: Workspace,
) -> AppResult<Workspace> {
    let paths = Paths::new(workspace_root(&app)?);
    let mut ws = workspace;
    ensure_builtin(&mut ws);
    ws.version = 1;
    ws.updated_at = now_ms();
    save(&paths, &ws).await?;
    Ok(ws)
}

// ---------------------------------------------------------------- sample

/// The first-run note is a real document, shipped as JSON so its shape can be
/// edited without rebuilding the block tree in code. The body has no heading of
/// its own: the document title already sits above the editor and names the node.
fn welcome_title(language: &str) -> &'static str {
    match language {
        "zh-CN" => "欢迎使用 Novion",
        "zh-TW" => "歡迎使用 Novion",
        "ja" => "Novion へようこそ",
        "es" => "Te damos la bienvenida a Novion",
        _ => "Welcome to Novion",
    }
}

fn sample_content(language: &str) -> AppResult<serde_json::Value> {
    let raw = match language {
        "zh-CN" => include_str!("../assets/welcome/zh-CN.json"),
        "zh-TW" => include_str!("../assets/welcome/zh-TW.json"),
        "ja" => include_str!("../assets/welcome/ja.json"),
        "es" => include_str!("../assets/welcome/es.json"),
        _ => include_str!("../assets/welcome/en.json"),
    };
    serde_json::from_str(raw).map_err(|err| AppError::json("内置欢迎文档格式无效", err))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, kind: NodeKind, parent: Option<&str>, order: i64) -> Node {
        Node::new(
            id.to_string(),
            kind,
            id.to_string(),
            parent.map(str::to_string),
            order,
        )
    }

    fn tree() -> Workspace {
        let mut ws = Workspace::default();
        ws.nodes = vec![
            node("d_a", NodeKind::Doc, None, 2),
            node("d_b", NodeKind::Doc, None, 0),
            node("d_c", NodeKind::Doc, None, 1),
            node("f_in", NodeKind::Folder, None, 3),
            node("d_in", NodeKind::Doc, Some("f_in"), 0),
        ];
        ws
    }

    #[test]
    fn siblings_put_pinned_documents_first_then_manual_order() {
        let mut ws = tree();
        assert_eq!(siblings(&ws.nodes, None), vec!["d_b", "d_c", "d_a", "f_in"]);

        // newest pin wins over the manual order
        find_mut(&mut ws.nodes, "d_a").unwrap().pinned_at = Some(10);
        find_mut(&mut ws.nodes, "d_c").unwrap().pinned_at = Some(20);
        assert_eq!(siblings(&ws.nodes, None), vec!["d_c", "d_a", "d_b", "f_in"]);
    }

    #[test]
    fn renumber_rewrites_orders_in_display_order() {
        let mut ws = tree();
        find_mut(&mut ws.nodes, "d_a").unwrap().pinned_at = Some(5);
        renumber(&mut ws, None);
        assert_eq!(find(&ws.nodes, "d_a").unwrap().order, 0);
        assert_eq!(find(&ws.nodes, "d_b").unwrap().order, 1);
        assert_eq!(find(&ws.nodes, "d_c").unwrap().order, 2);
        assert_eq!(find(&ws.nodes, "f_in").unwrap().order, 3);
    }

    #[test]
    fn subtree_ids_walks_nested_folders() {
        let mut ws = tree();
        ws.nodes.push(node("f_deep", NodeKind::Folder, Some("f_in"), 0));
        ws.nodes
            .push(node("d_deep", NodeKind::Doc, Some("f_deep"), 0));

        let mut ids = subtree_ids(&ws.nodes, "f_in");
        ids.sort();
        assert_eq!(ids, vec!["d_deep", "d_in", "f_deep", "f_in"]);
        assert_eq!(subtree_ids(&ws.nodes, "d_a"), vec!["d_a"]);
    }

    #[test]
    fn nodes_below_the_trash_folder_are_trashed() {
        let mut ws = tree();
        ws.nodes.push(node("f_trash_sys", NodeKind::Folder, None, 0));
        find_mut(&mut ws.nodes, "f_trash_sys").unwrap().builtin = Some(Builtin::Trash);
        ws.nodes
            .push(node("d_gone", NodeKind::Doc, Some("f_trash_sys"), 0));

        assert!(!in_trash(&ws.nodes, "d_a"));
        assert!(in_trash(&ws.nodes, "d_gone"));
        assert!(in_trash(&ws.nodes, "f_trash_sys"));
    }

    #[test]
    fn ensure_builtin_renames_the_legacy_completed_folder() {
        let mut ws = tree();
        ensure_builtin(&mut ws);
        // pretend this workspace was written before the rename
        find_mut(&mut ws.nodes, COMPLETED_ID).unwrap().name = "已完成".to_string();
        assert!(ensure_builtin(&mut ws));
        assert_eq!(find(&ws.nodes, COMPLETED_ID).unwrap().name, "已归档");
        assert!(!ensure_builtin(&mut ws), "second pass must be a no-op");

        // a hand-picked name is left alone
        find_mut(&mut ws.nodes, COMPLETED_ID).unwrap().name = "我的归档".to_string();
        assert!(!ensure_builtin(&mut ws));
        assert_eq!(find(&ws.nodes, COMPLETED_ID).unwrap().name, "我的归档");
    }

    #[test]
    fn ensure_builtin_repairs_hand_edited_system_folders() {
        let mut ws = tree();
        assert!(ensure_builtin(&mut ws));
        assert_eq!(find(&ws.nodes, COMPLETED_ID).unwrap().kind, NodeKind::Folder);
        assert!(!ensure_builtin(&mut ws), "second pass must be a no-op");
    }

    #[test]
    fn every_welcome_document_parses() {
        for language in ["en", "zh-CN", "zh-TW", "ja", "es"] {
            let doc = sample_content(language).expect("embedded welcome document parses");
            let blocks = doc["content"]
                .as_array()
                .unwrap_or_else(|| panic!("{language} has no blocks"));
            assert!(blocks.len() > 20, "{language} welcome document is too thin");
            assert_eq!(blocks[0]["type"], "paragraph");
            assert!(!welcome_title(language).is_empty());
        }
    }
}
