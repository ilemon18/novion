//! One-way, incremental Notion mirror.
//!
//! The local workspace is authoritative: folders and documents are pushed to
//! Notion, while edits made only in Notion are deliberately ignored. The run is
//! sequential (Notion allows roughly three requests per second), reports
//! progress through `notion:progress`, and keeps going when one node fails.
//!
//! The remote tree mirrors the local one: nodes that go to 回收站 are moved to
//! the Notion trash (and kept mapped so a later restore reuses the same page),
//! pages found in the Notion trash are restored instead of duplicated, and the
//! 已归档 subtree is always synced into its own folder page.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};

use crate::atomic::read_json;
use crate::error::{AppError, AppResult};
use crate::models::{now_ms, DocFile, Node, NodeKind, Workspace};
use crate::notion::{self, FolderLink, NotionClient, PageLink};
use crate::notion_blocks::{self, BlockNode, ASSET_MARKER};
use crate::paths::{workspace_root, Paths};
use crate::workspace::{self, COMPLETED_ID, TRASH_ID};

/// Notion accepts at most 100 children per request.
const MAX_BLOCKS: usize = 100;
/// Single-part upload limit; anything bigger degrades to a text placeholder.
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFailure {
    pub doc_id: String,
    pub title: String,
    pub message: String,
}

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub folders_created: usize,
    pub pages_created: usize,
    pub pages_updated: usize,
    /// pages that were verified as already up to date
    pub pages_verified: usize,
    pub pages_restored: usize,
    pub pages_trashed: usize,
    pub folders_restored: usize,
    pub folders_trashed: usize,
    pub images_uploaded: usize,
    pub images_failed: usize,
    pub failures: Vec<SyncFailure>,
    pub last_sync_at: u64,
    pub parent_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    done: usize,
    total: usize,
    current: String,
}

fn emit<R: Runtime>(
    app: &AppHandle<R>,
    phase: &'static str,
    done: usize,
    total: usize,
    current: &str,
) {
    let _ = app.emit(
        "notion:progress",
        Progress {
            phase,
            done,
            total,
            current: current.to_string(),
        },
    );
}

// ------------------------------------------------------------------ hashing

/// Stable 128-bit fingerprint of a document body.
///
/// Not cryptographic: it only answers "did this body change since the last
/// sync?", and two independently seeded FNV variants make an accidental
/// collision far less likely than a timestamp comparison alone.
pub fn content_hash(content: &Value) -> String {
    let text = serde_json::to_string(content).unwrap_or_default();
    let mut a: u64 = 0xcbf2_9ce4_8422_2325;
    let mut b: u64 = 0x8422_2325_cbf2_9ce4;
    for byte in text.as_bytes() {
        a ^= u64::from(*byte);
        a = a.wrapping_mul(0x0000_0100_0000_01b3);
        b ^= u64::from(*byte).wrapping_add(0x9e37_79b9_7f4a_7c15);
        b = b.rotate_left(9).wrapping_mul(0x94d0_49bb_1331_11eb);
    }
    format!("{a:016x}{b:016x}")
}

// --------------------------------------------------------------- traversal

/// Same ordering as the sidebar: pinned first (newest pin first), then `order`.
/// Built-in folders are never returned; `已归档` is appended explicitly.
fn ordered_children(ws: &Workspace, parent: Option<&str>) -> Vec<Node> {
    let mut list: Vec<&Node> = ws
        .nodes
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
    list.into_iter().cloned().collect()
}

fn walk_scope(ws: &Workspace, parent: Option<&str>, out: &mut Vec<Node>) {
    for node in ordered_children(ws, parent) {
        if node.id == TRASH_ID {
            continue;
        }
        out.push(node.clone());
        if node.kind == NodeKind::Folder {
            walk_scope(ws, Some(&node.id), out);
        }
    }

    if parent.is_none() {
        // `已归档` always mirrors into its own folder page; 回收站 never does.
        if let Some(completed) = ws.nodes.iter().find(|node| node.id == COMPLETED_ID) {
            out.push(completed.clone());
            walk_scope(ws, Some(COMPLETED_ID), out);
        }
    }
}

/// Every node a run keeps in sync, in stable tree order. The trash root and all
/// of its descendants are excluded; the archived root is always included.
fn scope_nodes(ws: &Workspace) -> Vec<Node> {
    let mut out = Vec::new();
    walk_scope(ws, None, &mut out);
    out
}

// ------------------------------------------------------------------ images

fn mime_for(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        _ => "image/png",
    }
}

fn image_block(upload_id: &str) -> Value {
    json!({
        "object": "block",
        "type": "image",
        "image": { "type": "file_upload", "file_upload": { "id": upload_id } }
    })
}

struct ImageUploads {
    /// workspace-relative path → uploaded file id (None once it failed)
    done: HashMap<String, Option<String>>,
    uploaded: usize,
    failed: usize,
}

impl ImageUploads {
    fn new() -> Self {
        Self {
            done: HashMap::new(),
            uploaded: 0,
            failed: 0,
        }
    }

    /// Uploads every referenced image once; failures are remembered, not fatal.
    async fn upload_all(&mut self, client: &NotionClient, paths: &Paths, refs: &[String]) {
        for rel in refs {
            if self.done.contains_key(rel) {
                continue;
            }
            match self.upload_one(client, paths, rel).await {
                Ok(id) => {
                    self.uploaded += 1;
                    self.done.insert(rel.clone(), Some(id));
                }
                Err(_) => {
                    self.failed += 1;
                    self.done.insert(rel.clone(), None);
                }
            }
        }
    }

    async fn upload_one(
        &mut self,
        client: &NotionClient,
        paths: &Paths,
        rel: &str,
    ) -> Result<String, String> {
        let file = paths.asset_file(rel).map_err(|err| err.message)?;
        let meta = tokio::fs::metadata(&file)
            .await
            .map_err(|_| "Local file is gone".to_string())?;
        if meta.len() > MAX_IMAGE_BYTES {
            return Err("Larger than the 20 MB per-image limit".to_string());
        }
        let bytes = tokio::fs::read(&file)
            .await
            .map_err(|err| format!("Read failed: {err}"))?;
        let filename = rel.rsplit('/').next().unwrap_or(rel).to_string();
        let mime = mime_for(&filename);

        let created = client
            .post(
                "/file_uploads",
                json!({ "filename": filename, "content_type": mime }),
            )
            .await
            .map_err(|err| err.message)?;
        let upload_url = created
            .get("upload_url")
            .and_then(Value::as_str)
            .ok_or_else(|| "Notion did not return an upload URL".to_string())?
            .to_string();
        let id = created
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Notion did not return an upload id".to_string())?
            .to_string();

        client
            .upload_bytes(&upload_url, &filename, mime, bytes)
            .await
            .map_err(|err| err.message)?;
        Ok(id)
    }
}

fn collect_asset_refs(nodes: &[BlockNode], out: &mut Vec<String>) {
    for node in nodes {
        if node.block.get("type").and_then(Value::as_str) == Some("image") {
            if let Some(rel) = node
                .block
                .pointer(&format!("/image/{ASSET_MARKER}"))
                .and_then(Value::as_str)
            {
                if !out.iter().any(|existing| existing == rel) {
                    out.push(rel.to_string());
                }
            }
        }
        collect_asset_refs(&node.children, out);
    }
}

fn apply_asset_results(nodes: &mut [BlockNode], uploads: &ImageUploads) {
    for node in nodes.iter_mut() {
        if node.block.get("type").and_then(Value::as_str) == Some("image") {
            if let Some(rel) = node
                .block
                .pointer(&format!("/image/{ASSET_MARKER}"))
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
                match uploads.done.get(&rel) {
                    Some(Some(id)) => node.block = image_block(id),
                    _ => {
                        node.block =
                            notion_blocks::placeholder(&format!("Image not synced: {name}"));
                    }
                }
            }
        }
        apply_asset_results(&mut node.children, uploads);
    }
}

// ------------------------------------------------------------------ writing

/// Appends blocks to a page/block, walking children level by level because
/// Notion nests at most two levels per request.
async fn append_tree(
    client: &NotionClient,
    parent_id: &str,
    blocks: &[BlockNode],
) -> AppResult<()> {
    let mut queue: Vec<(String, &[BlockNode])> = vec![(parent_id.to_string(), blocks)];
    while let Some((parent, level)) = queue.pop() {
        if level.is_empty() {
            continue;
        }
        let mut created: Vec<String> = Vec::with_capacity(level.len());
        for chunk in level.chunks(MAX_BLOCKS) {
            let values: Vec<Value> = chunk.iter().map(|node| node.block.clone()).collect();
            let response = client
                .patch(
                    &format!("/blocks/{parent}/children"),
                    json!({ "children": values }),
                )
                .await?;
            let results = response
                .get("results")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    AppError::new(
                        "notion_append_failed",
                        "Notion returned no block results; the content may be incomplete",
                    )
                })?;
            if results.len() != chunk.len() {
                return Err(AppError::new(
                    "notion_append_failed",
                    "Notion returned a different number of blocks than were sent; the content may be incomplete",
                ));
            }
            created.extend(
                results
                    .iter()
                    .filter_map(|item| item.get("id").and_then(Value::as_str))
                    .map(str::to_string),
            );
        }
        if created.len() != level.len() {
            return Err(AppError::new(
                "notion_append_failed",
                "Notion did not return ids for every appended block",
            ));
        }
        for (node, id) in level.iter().zip(created) {
            if !node.children.is_empty() {
                queue.push((id, node.children.as_slice()));
            }
        }
    }
    Ok(())
}

/// Deletes every direct child of a page before a body rewrite.
async fn clear_children(client: &NotionClient, page_id: &str) -> AppResult<usize> {
    let mut removed = 0;
    for _ in 0..64 {
        let response = client
            .get(&format!("/blocks/{page_id}/children?page_size=100"))
            .await?;
        let ids: Vec<String> = response
            .get("results")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|item| item.get("id").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if ids.is_empty() {
            break;
        }
        for id in ids {
            client.delete(&format!("/blocks/{id}")).await?;
            removed += 1;
        }
    }
    Ok(removed)
}

async fn create_page(client: &NotionClient, parent_page: &str, title: &str) -> AppResult<String> {
    let body = json!({
        "parent": { "type": "page_id", "page_id": parent_page },
        "properties": { "title": notion::title_property(title) }
    });
    let page = client.post("/pages", body).await?;
    page.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::new(
                "notion_create_failed",
                "Notion did not return the new page id",
            )
        })
}

async fn rename_page(client: &NotionClient, page_id: &str, title: &str) -> AppResult<()> {
    client
        .patch(
            &format!("/pages/{page_id}"),
            json!({ "properties": { "title": notion::title_property(title) } }),
        )
        .await?;
    Ok(())
}

/// Three-way remote state: a trashed page is not a missing page — restoring it
/// keeps its URL and children instead of creating a duplicate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemotePage {
    Active,
    Trashed,
    Missing,
}

async fn remote_page_state(client: &NotionClient, page_id: &str) -> AppResult<RemotePage> {
    match client.get(&format!("/pages/{page_id}")).await {
        Ok(page) => Ok(if notion::page_is_archived(&page) {
            RemotePage::Trashed
        } else {
            RemotePage::Active
        }),
        Err(err) if err.code == "notion_not_found" => Ok(RemotePage::Missing),
        Err(err) => Err(err),
    }
}

fn target_title(cfg: &notion::NotionConfig) -> &str {
    if cfg.parent_page_title.trim().is_empty() {
        cfg.parent_page_id.as_str()
    } else {
        cfg.parent_page_title.as_str()
    }
}

fn target_locked_error(cfg: &notion::NotionConfig) -> AppError {
    AppError::new(
        "notion_target_locked",
        format!(
            "Notion 同步目标页「{}」仍在回收站里，自动恢复没有成功（通常是集成缺少权限）。请在 Notion 里恢复它，或在设置里重新选择同步页面。",
            target_title(cfg)
        ),
    )
}

/// Check the target before creating any children. A target (or ancestor) in
/// the Notion trash is restored instead of failing the whole run.
async fn ensure_sync_target(client: &NotionClient, cfg: &notion::NotionConfig) -> AppResult<()> {
    match client.get(&format!("/pages/{}", cfg.parent_page_id)).await {
        Ok(page) => {
            let Some(location) = client.archived_location(&page).await? else {
                return Ok(());
            };
            let is_page = location.get("object").and_then(Value::as_str) == Some("page");
            let id = location
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(cfg.parent_page_id.as_str())
                .to_string();
            if !is_page {
                return Err(target_locked_error(cfg));
            }
            client
                .restore_page(&id)
                .await
                .map_err(|_| target_locked_error(cfg))?;
            Ok(())
        }
        Err(err) if err.code == "notion_not_found" => Err(AppError::new(
            "notion_target_missing",
            format!(
                "Notion 同步目标页「{}」找不到。请确认页面仍存在且已分享给集成，或在设置里重新选择同步页面。",
                target_title(cfg)
            ),
        )),
        Err(err) => Err(err),
    }
}

// -------------------------------------------------------------- decisions

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct FolderPlan {
    create: bool,
    restore: bool,
    rename: bool,
    move_page: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct DocPlan {
    create: bool,
    restore: bool,
    rename: bool,
    move_page: bool,
    rewrite_body: bool,
    /// A legacy link has no body fingerprint. Record the current body without
    /// rewriting Notion unless the local document was modified after the last
    /// known push.
    baseline: bool,
}

fn plan_folder(
    link: Option<&FolderLink>,
    remote: RemotePage,
    title: &str,
    parent_page_id: &str,
) -> FolderPlan {
    let Some(link) = link else {
        return FolderPlan {
            create: true,
            ..FolderPlan::default()
        };
    };
    if remote == RemotePage::Missing {
        return FolderPlan {
            create: true,
            ..FolderPlan::default()
        };
    }
    FolderPlan {
        create: false,
        restore: remote == RemotePage::Trashed,
        rename: !link.title.is_empty() && link.title != title,
        move_page: !link.parent_page_id.is_empty() && link.parent_page_id != parent_page_id,
    }
}

fn plan_doc(
    link: Option<&PageLink>,
    remote: RemotePage,
    title: &str,
    parent_page_id: &str,
    local_hash: &str,
    doc_updated_at: u64,
) -> DocPlan {
    let Some(link) = link else {
        return DocPlan {
            create: true,
            ..DocPlan::default()
        };
    };
    if remote == RemotePage::Missing {
        return DocPlan {
            create: true,
            ..DocPlan::default()
        };
    }

    let legacy = link.local_hash.is_empty();
    let legacy_changed = legacy && doc_updated_at > link.doc_updated_at;
    DocPlan {
        create: false,
        restore: remote == RemotePage::Trashed,
        rename: !link.title.is_empty() && link.title != title,
        move_page: !link.parent_page_id.is_empty() && link.parent_page_id != parent_page_id,
        // An incomplete write is repaired on the same page instead of being
        // replaced by a duplicate.
        rewrite_body: !link.ok || (!legacy && link.local_hash != local_hash) || legacy_changed,
        baseline: link.ok && legacy && !legacy_changed,
    }
}

// --------------------------------------------------------------------- run

struct Ctx<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    client: &'a NotionClient,
    paths: &'a Paths,
    ws: Workspace,
    cfg: notion::NotionConfig,
    stats: SyncStats,
    uploads: ImageUploads,
    done: usize,
    total: usize,
}

impl<'a, R: Runtime> Ctx<'a, R> {
    fn tick(&mut self, phase: &'static str, current: &str) {
        self.done += 1;
        emit(self.app, phase, self.done, self.total, current);
    }

    fn fail(&mut self, id: &str, title: &str, message: impl Into<String>) {
        self.stats.failures.push(SyncFailure {
            doc_id: id.to_string(),
            title: title.to_string(),
            message: message.into(),
        });
    }

    /// A locked root blocks every new top-level node. Other failures are
    /// recorded against the node and the run keeps going.
    fn fail_creation(
        &mut self,
        id: &str,
        title: &str,
        parent: &str,
        err: AppError,
    ) -> AppResult<()> {
        let root_blocked = parent == self.cfg.parent_page_id
            && matches!(
                err.code.as_str(),
                "notion_archived" | "notion_restore_failed" | "notion_target_locked"
            );
        if root_blocked {
            return Err(target_locked_error(&self.cfg));
        }
        self.fail(id, title, err.message);
        Ok(())
    }
}

/// Creates a child page, healing a parent that was trashed after its own check
/// (a user can empty the Notion trash while a sync is running).
async fn create_page_healing(
    client: &NotionClient,
    parent_page_id: &str,
    title: &str,
) -> AppResult<String> {
    match create_page(client, parent_page_id, title).await {
        Ok(id) => Ok(id),
        Err(err) if err.code == "notion_archived" => {
            client.restore_page(parent_page_id).await?;
            create_page(client, parent_page_id, title).await
        }
        Err(err) => Err(err),
    }
}

async fn create_folder_page<R: Runtime>(
    ctx: &mut Ctx<'_, R>,
    folder: &Node,
    notion_parent: &str,
) -> AppResult<Option<String>> {
    // A stale mapping must never make a later run skip the replacement.
    ctx.cfg.folders.remove(&folder.id);
    let page_id = match create_page_healing(ctx.client, notion_parent, &folder.name).await {
        Ok(id) => id,
        Err(err) => {
            ctx.fail_creation(&folder.id, &folder.name, notion_parent, err)?;
            return Ok(None);
        }
    };
    ctx.cfg.folders.insert(
        folder.id.clone(),
        FolderLink {
            page_id: page_id.clone(),
            parent_page_id: notion_parent.to_string(),
            title: folder.name.clone(),
            in_trash: false,
        },
    );
    ctx.stats.folders_created += 1;
    Ok(Some(page_id))
}

async fn sync_folder<R: Runtime>(
    ctx: &mut Ctx<'_, R>,
    folder: &Node,
    notion_parent: &str,
) -> AppResult<Option<String>> {
    let existing = ctx.cfg.folders.get(&folder.id).cloned();
    let remote = match &existing {
        Some(link) => match remote_page_state(ctx.client, &link.page_id).await {
            Ok(state) => state,
            Err(err) => {
                ctx.fail(&folder.id, &folder.name, err.message);
                return Ok(None);
            }
        },
        None => RemotePage::Missing,
    };
    let plan = plan_folder(existing.as_ref(), remote, &folder.name, notion_parent);

    if plan.create {
        return create_folder_page(ctx, folder, notion_parent).await;
    }

    let mut link = existing.expect("non-create folder plan has a link");
    let page_id = link.page_id.clone();

    if plan.restore {
        match ctx.client.restore_page(&page_id).await {
            Ok(()) => {
                link.in_trash = false;
                ctx.stats.folders_restored += 1;
            }
            Err(_) => {
                // The old page cannot be brought back; recreate the folder so
                // its subtree still mirrors locally.
                return create_folder_page(ctx, folder, notion_parent).await;
            }
        }
    }

    if plan.rename {
        match rename_page(ctx.client, &page_id, &folder.name).await {
            Ok(()) => link.title = folder.name.clone(),
            Err(err) => ctx.fail(&folder.id, &folder.name, err.message),
        }
    }
    if plan.move_page {
        match ctx.client.move_page(&page_id, notion_parent).await {
            Ok(_) => link.parent_page_id = notion_parent.to_string(),
            Err(err) => ctx.fail(&folder.id, &folder.name, err.message),
        }
    }

    // Legacy folder mappings were just a page id. Establish the title/parent
    // baseline once so later local changes can be detected without a remote read.
    if link.title.is_empty() {
        link.title = folder.name.clone();
    }
    if link.parent_page_id.is_empty() {
        link.parent_page_id = notion_parent.to_string();
    }
    ctx.cfg.folders.insert(folder.id.clone(), link);
    Ok(Some(page_id))
}

async fn prepare_blocks<R: Runtime>(ctx: &mut Ctx<'_, R>, content: &Value) -> Vec<BlockNode> {
    let mut blocks = notion_blocks::convert_doc(content);
    let mut refs = Vec::new();
    collect_asset_refs(&blocks, &mut refs);
    ctx.uploads.upload_all(ctx.client, ctx.paths, &refs).await;
    apply_asset_results(&mut blocks, &ctx.uploads);
    blocks
}

async fn create_doc_page<R: Runtime>(
    ctx: &mut Ctx<'_, R>,
    node: &Node,
    title: &str,
    notion_parent: &str,
    content: &Value,
    local_hash: &str,
    doc_updated_at: u64,
) -> AppResult<()> {
    // Drop a stale or incomplete mapping before creating its replacement.
    ctx.cfg.pages.remove(&node.id);
    let blocks = prepare_blocks(ctx, content).await;
    let page_id = match create_page_healing(ctx.client, notion_parent, title).await {
        Ok(id) => id,
        Err(err) => {
            ctx.fail_creation(&node.id, title, notion_parent, err)?;
            return Ok(());
        }
    };
    if let Err(err) = append_tree(ctx.client, &page_id, &blocks).await {
        ctx.cfg.pages.insert(
            node.id.clone(),
            PageLink {
                page_id,
                parent_page_id: notion_parent.to_string(),
                title: title.to_string(),
                doc_updated_at: 0,
                synced_at: now_ms(),
                ok: false,
                local_hash: String::new(),
                in_trash: false,
            },
        );
        ctx.fail(&node.id, title, err.message);
        return Ok(());
    }
    ctx.cfg.pages.insert(
        node.id.clone(),
        PageLink {
            page_id,
            parent_page_id: notion_parent.to_string(),
            title: title.to_string(),
            doc_updated_at,
            synced_at: now_ms(),
            ok: true,
            local_hash: local_hash.to_string(),
            in_trash: false,
        },
    );
    ctx.stats.pages_created += 1;
    Ok(())
}

async fn sync_doc<R: Runtime>(
    ctx: &mut Ctx<'_, R>,
    node: &Node,
    notion_parent: &str,
) -> AppResult<()> {
    let title = node.name.clone();
    let file = match ctx.paths.doc_file(&node.id) {
        Ok(file) => file,
        Err(err) => {
            ctx.fail(&node.id, &title, err.message);
            return Ok(());
        }
    };
    let doc = match read_json::<DocFile>(&file).await {
        Ok(doc) => doc,
        Err(err) => {
            ctx.fail(&node.id, &title, err.message);
            return Ok(());
        }
    };
    let effective_title = if title.trim().is_empty() {
        doc.title.clone()
    } else {
        title
    };
    let local_hash = content_hash(&doc.content);
    let existing = ctx.cfg.pages.get(&node.id).cloned();
    let remote = match &existing {
        Some(link) => match remote_page_state(ctx.client, &link.page_id).await {
            Ok(state) => state,
            Err(err) => {
                ctx.fail(&node.id, &effective_title, err.message);
                return Ok(());
            }
        },
        None => RemotePage::Missing,
    };
    let plan = plan_doc(
        existing.as_ref(),
        remote,
        &effective_title,
        notion_parent,
        &local_hash,
        doc.updated_at,
    );

    if plan.create {
        return create_doc_page(
            ctx,
            node,
            &effective_title,
            notion_parent,
            &doc.content,
            &local_hash,
            doc.updated_at,
        )
        .await;
    }

    let mut link = existing.expect("non-create document plan has a link");
    let page_id = link.page_id.clone();
    let mut changed = false;
    let mut restored = false;

    // A page sitting in the Notion trash is restored in place so its URL and
    // children survive; only an unrestorable page is replaced.
    if plan.restore {
        match ctx.client.restore_page(&page_id).await {
            Ok(()) => {
                link.in_trash = false;
                restored = true;
            }
            Err(_) => {
                return create_doc_page(
                    ctx,
                    node,
                    &effective_title,
                    notion_parent,
                    &doc.content,
                    &local_hash,
                    doc.updated_at,
                )
                .await;
            }
        }
    }

    if plan.rename {
        match rename_page(ctx.client, &page_id, &effective_title).await {
            Ok(()) => {
                link.title = effective_title.clone();
                changed = true;
            }
            Err(err) => ctx.fail(&node.id, &effective_title, err.message),
        }
    }

    if plan.move_page {
        match ctx.client.move_page(&page_id, notion_parent).await {
            Ok(_) => {
                link.parent_page_id = notion_parent.to_string();
                changed = true;
            }
            Err(err) => ctx.fail(&node.id, &effective_title, err.message),
        }
    }

    if plan.rewrite_body {
        let blocks = prepare_blocks(ctx, &doc.content).await;
        let outcome = async {
            clear_children(ctx.client, &page_id).await?;
            append_tree(ctx.client, &page_id, &blocks).await
        }
        .await;
        match outcome {
            Ok(()) => {
                link.local_hash = local_hash;
                link.doc_updated_at = doc.updated_at;
                link.ok = true;
                link.in_trash = false;
                changed = true;
            }
            Err(err) => {
                link.ok = false;
                ctx.fail(&node.id, &effective_title, err.message);
            }
        }
    } else if plan.baseline {
        // No remote write: establish the fingerprint needed by future runs.
        link.local_hash = local_hash;
        link.doc_updated_at = doc.updated_at;
    }

    // Backfill caches added after the original one-way sync shipped. Empty
    // values mean "unknown", so they must not trigger a rename or move.
    if link.title.is_empty() {
        link.title = effective_title.clone();
    }
    if link.parent_page_id.is_empty() {
        link.parent_page_id = notion_parent.to_string();
    }

    if changed {
        link.synced_at = now_ms();
        ctx.stats.pages_updated += 1;
    } else if restored {
        link.synced_at = now_ms();
        ctx.stats.pages_restored += 1;
    } else {
        ctx.stats.pages_verified += 1;
    }
    ctx.cfg.pages.insert(node.id.clone(), link);
    Ok(())
}

async fn sync_tree<R: Runtime>(ctx: &mut Ctx<'_, R>) -> AppResult<()> {
    let mut queue: Vec<(String, Option<String>)> = vec![(ctx.cfg.parent_page_id.clone(), None)];
    let mut seen_folders: HashSet<String> = HashSet::new();

    while let Some((notion_parent, ws_parent)) = queue.pop() {
        for node in ordered_children(&ctx.ws, ws_parent.as_deref()) {
            match node.kind {
                NodeKind::Folder => {
                    if seen_folders.insert(node.id.clone()) {
                        if let Some(page_id) = sync_folder(ctx, &node, &notion_parent).await? {
                            queue.push((page_id, Some(node.id.clone())));
                        }
                    }
                    ctx.tick("folders", &node.name);
                }
                NodeKind::Doc => {
                    sync_doc(ctx, &node, &notion_parent).await?;
                    ctx.tick("docs", &node.name);
                }
            }
        }

        if ws_parent.is_none() {
            // `ordered_children` deliberately omits built-in system folders.
            // 已归档 always mirrors into its own folder page; 回收站 is never
            // queued, so none of its descendants are touched here (the cleanup
            // pass trashes their mapped pages instead).
            if let Some(completed) = ctx
                .ws
                .nodes
                .iter()
                .find(|node| node.id == COMPLETED_ID)
                .cloned()
            {
                if seen_folders.insert(completed.id.clone()) {
                    if let Some(page_id) = sync_folder(ctx, &completed, &notion_parent).await? {
                        queue.push((page_id, Some(completed.id.clone())));
                    }
                }
                ctx.tick("folders", &completed.name);
            }
        }
    }
    Ok(())
}

/// Moves pages of deleted or trashed local nodes to the Notion trash.
///
/// Nodes that still exist in 回收站 keep their mapping (flagged `in_trash`) so
/// restoring them later reuses the same Notion page. Purged nodes lose theirs.
async fn cleanup_removed<R: Runtime>(
    ctx: &mut Ctx<'_, R>,
    scope: &HashSet<String>,
) -> AppResult<()> {
    let docs: Vec<(String, PageLink)> = ctx
        .cfg
        .pages
        .iter()
        .filter(|(id, _)| !scope.contains(id.as_str()))
        .map(|(id, link)| (id.clone(), link.clone()))
        .collect();
    for (id, mut link) in docs {
        let node = ctx.ws.nodes.iter().find(|node| node.id == id);
        let Some(node) = node else {
            // Permanently deleted: archive the page and forget the mapping.
            if !link.in_trash {
                emit(ctx.app, "cleanup", ctx.done, ctx.total, &link.title);
                if let Err(err) = ctx.client.set_page_trashed(&link.page_id, true).await {
                    ctx.fail(&id, &link.title, err.message);
                    continue;
                }
                ctx.stats.pages_trashed += 1;
            }
            ctx.cfg.pages.remove(&id);
            continue;
        };
        let title = if node.name.trim().is_empty() {
            link.title.clone()
        } else {
            node.name.clone()
        };
        if !workspace::in_trash(&ctx.ws.nodes, &node.id) {
            // Outside the scope for an unexpected reason: never archive blindly.
            continue;
        }
        if link.in_trash {
            // Already trashed by a previous run, but its page may have been
            // restored by hand in Notion; the local trash still wins.
            match remote_page_state(ctx.client, &link.page_id).await {
                Ok(RemotePage::Active) => {
                    emit(ctx.app, "cleanup", ctx.done, ctx.total, &title);
                    if let Err(err) = ctx.client.set_page_trashed(&link.page_id, true).await {
                        ctx.fail(&id, &title, err.message);
                    } else {
                        ctx.stats.pages_trashed += 1;
                    }
                }
                Ok(_) => {}
                Err(err) => ctx.fail(&id, &title, err.message),
            }
            continue;
        }
        emit(ctx.app, "cleanup", ctx.done, ctx.total, &title);
        match ctx.client.set_page_trashed(&link.page_id, true).await {
            Ok(()) => {
                link.in_trash = true;
                link.synced_at = now_ms();
                ctx.cfg.pages.insert(id, link);
                ctx.stats.pages_trashed += 1;
            }
            Err(err) => ctx.fail(&id, &title, err.message),
        }
    }

    let folders: Vec<(String, FolderLink)> = ctx
        .cfg
        .folders
        .iter()
        .filter(|(id, _)| !scope.contains(id.as_str()))
        .map(|(id, link)| (id.clone(), link.clone()))
        .collect();
    for (id, mut link) in folders {
        let node = ctx.ws.nodes.iter().find(|node| node.id == id);
        let Some(node) = node else {
            if !link.in_trash {
                emit(ctx.app, "cleanup", ctx.done, ctx.total, &link.title);
                if let Err(err) = ctx.client.set_page_trashed(&link.page_id, true).await {
                    ctx.fail(&id, &link.title, err.message);
                    continue;
                }
                ctx.stats.folders_trashed += 1;
            }
            ctx.cfg.folders.remove(&id);
            continue;
        };
        let title = if node.name.trim().is_empty() {
            link.title.clone()
        } else {
            node.name.clone()
        };
        if !workspace::in_trash(&ctx.ws.nodes, &node.id) {
            continue;
        }
        if link.in_trash {
            match remote_page_state(ctx.client, &link.page_id).await {
                Ok(RemotePage::Active) => {
                    emit(ctx.app, "cleanup", ctx.done, ctx.total, &title);
                    if let Err(err) = ctx.client.set_page_trashed(&link.page_id, true).await {
                        ctx.fail(&id, &title, err.message);
                    } else {
                        ctx.stats.folders_trashed += 1;
                    }
                }
                Ok(_) => {}
                Err(err) => ctx.fail(&id, &title, err.message),
            }
            continue;
        }
        emit(ctx.app, "cleanup", ctx.done, ctx.total, &title);
        match ctx.client.set_page_trashed(&link.page_id, true).await {
            Ok(()) => {
                link.in_trash = true;
                ctx.cfg.folders.insert(id, link);
                ctx.stats.folders_trashed += 1;
            }
            Err(err) => ctx.fail(&id, &title, err.message),
        }
    }
    Ok(())
}

// ------------------------------------------------------------------- entry

fn validate(cfg: &notion::NotionConfig) -> AppResult<()> {
    if cfg.token().is_none() {
        return Err(AppError::new(
            "notion_no_token",
            "Notion is not connected: paste an integration token first",
        ));
    }
    if cfg.parent_page_id.is_empty() {
        return Err(AppError::new(
            "notion_no_parent",
            "No sync target yet: paste a Notion page link and press “Check page”",
        ));
    }
    Ok(())
}

async fn build_ctx<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    client: &'a NotionClient,
    paths: &'a Paths,
) -> AppResult<Ctx<'a, R>> {
    let cfg = notion::snapshot(app);
    validate(&cfg)?;
    let ws = workspace::load_shared(paths).await?.as_ref().clone();
    let total = scope_nodes(&ws).len();
    Ok(Ctx {
        app,
        client,
        paths,
        ws,
        cfg,
        stats: SyncStats::default(),
        uploads: ImageUploads::new(),
        done: 0,
        total,
    })
}

#[tauri::command]
pub async fn notion_sync_docs<R: Runtime>(app: AppHandle<R>) -> AppResult<SyncStats> {
    let client = NotionClient::from_app(&app)?;
    let paths = Paths::new(workspace_root(&app)?);
    paths.ensure_dirs().await?;
    let mut ctx = build_ctx(&app, &client, &paths).await?;
    ensure_sync_target(&client, &ctx.cfg).await?;
    let scope: HashSet<String> = scope_nodes(&ctx.ws)
        .into_iter()
        .map(|node| node.id)
        .collect();
    emit(&app, "folders", 0, ctx.total, "");
    let outcome = async {
        sync_tree(&mut ctx).await?;
        cleanup_removed(&mut ctx, &scope).await
    }
    .await;
    // Keep successful mappings even when a later write discovers a blocked
    // target, so retrying after recovery does not duplicate earlier pages.
    let stats = finish(ctx).await?;
    outcome?;
    Ok(stats)
}

/// Persists the page mapping and builds final statistics.
async fn finish<R: Runtime>(mut ctx: Ctx<'_, R>) -> AppResult<SyncStats> {
    let now = now_ms();
    ctx.cfg.last_sync_at = now;
    notion::save(ctx.app, &ctx.cfg).await?;
    notion::remember(ctx.app, &ctx.cfg);

    let mut stats = std::mem::take(&mut ctx.stats);
    stats.last_sync_at = now;
    stats.parent_url = notion::page_url(&ctx.cfg.parent_page_id);
    stats.images_uploaded = ctx.uploads.uploaded;
    stats.images_failed = ctx.uploads.failed;
    emit(
        ctx.app,
        "done",
        stats.pages_created
            + stats.pages_updated
            + stats.pages_restored
            + stats.pages_verified
            + stats.pages_trashed
            + stats.folders_trashed,
        ctx.total,
        "",
    );
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc_link(title: &str, parent: &str, hash: &str) -> PageLink {
        PageLink {
            page_id: "page-1".to_string(),
            parent_page_id: parent.to_string(),
            title: title.to_string(),
            doc_updated_at: 10,
            synced_at: 10,
            ok: true,
            local_hash: hash.to_string(),
            in_trash: false,
        }
    }

    #[test]
    fn hashes_stable_and_sensitive() {
        let a = json!({ "type": "doc", "content": [{ "type": "text", "text": "a" }] });
        let b = json!({ "type": "doc", "content": [{ "type": "text", "text": "b" }] });
        assert_eq!(content_hash(&a), content_hash(&a.clone()));
        assert_ne!(content_hash(&a), content_hash(&b));
    }

    #[test]
    fn document_plans_cover_create_skip_and_each_change() {
        let link = doc_link("Title", "parent-a", "hash-a");

        assert_eq!(
            plan_doc(None, RemotePage::Missing, "Title", "parent-a", "hash-a", 10),
            DocPlan {
                create: true,
                ..DocPlan::default()
            }
        );
        assert_eq!(
            plan_doc(
                Some(&link),
                RemotePage::Active,
                "Title",
                "parent-a",
                "hash-a",
                10
            ),
            DocPlan::default()
        );
        assert_eq!(
            plan_doc(
                Some(&link),
                RemotePage::Active,
                "Title",
                "parent-a",
                "hash-b",
                20
            ),
            DocPlan {
                rewrite_body: true,
                ..DocPlan::default()
            }
        );
        assert_eq!(
            plan_doc(
                Some(&link),
                RemotePage::Active,
                "Renamed",
                "parent-a",
                "hash-a",
                10
            ),
            DocPlan {
                rename: true,
                ..DocPlan::default()
            }
        );
        assert_eq!(
            plan_doc(
                Some(&link),
                RemotePage::Active,
                "Title",
                "parent-b",
                "hash-a",
                10
            ),
            DocPlan {
                move_page: true,
                ..DocPlan::default()
            }
        );
        assert_eq!(
            plan_doc(
                Some(&link),
                RemotePage::Active,
                "Renamed",
                "parent-b",
                "hash-b",
                20
            ),
            DocPlan {
                rename: true,
                move_page: true,
                rewrite_body: true,
                ..DocPlan::default()
            }
        );
    }

    #[test]
    fn document_plan_restores_trashed_pages_in_place() {
        let link = doc_link("Title", "parent-a", "hash-a");
        assert_eq!(
            plan_doc(
                Some(&link),
                RemotePage::Trashed,
                "Title",
                "parent-a",
                "hash-a",
                10
            ),
            DocPlan {
                restore: true,
                ..DocPlan::default()
            }
        );
        // A restored page with local edits is restored *and* rewritten.
        assert_eq!(
            plan_doc(
                Some(&link),
                RemotePage::Trashed,
                "Title",
                "parent-a",
                "hash-b",
                20
            ),
            DocPlan {
                restore: true,
                rewrite_body: true,
                ..DocPlan::default()
            }
        );
    }

    #[test]
    fn document_plan_recreates_only_missing_pages_and_repairs_incomplete_ones() {
        let mut link = doc_link("Title", "parent-a", "hash-a");
        link.ok = false;
        // An incomplete write is repaired on the same page, not duplicated.
        assert_eq!(
            plan_doc(
                Some(&link),
                RemotePage::Active,
                "Title",
                "parent-a",
                "hash-a",
                10
            ),
            DocPlan {
                rewrite_body: true,
                ..DocPlan::default()
            }
        );
        assert!(
            plan_doc(
                Some(&link),
                RemotePage::Missing,
                "Title",
                "parent-a",
                "hash-a",
                10
            )
            .create
        );
    }

    #[test]
    fn document_plan_backfills_legacy_links() {
        let mut link = doc_link("", "", "");
        link.doc_updated_at = 10;
        assert_eq!(
            plan_doc(
                Some(&link),
                RemotePage::Active,
                "Title",
                "parent-a",
                "hash-a",
                10
            ),
            DocPlan {
                baseline: true,
                ..DocPlan::default()
            }
        );
        assert!(
            plan_doc(
                Some(&link),
                RemotePage::Active,
                "Title",
                "parent-a",
                "hash-a",
                11
            )
            .rewrite_body
        );
    }

    fn workspace() -> Workspace {
        let mut completed = Node::new(
            COMPLETED_ID.to_string(),
            NodeKind::Folder,
            "Archived".to_string(),
            None,
            1,
        );
        completed.builtin = Some(crate::models::Builtin::Completed);
        let mut trash = Node::new(
            TRASH_ID.to_string(),
            NodeKind::Folder,
            "Trash".to_string(),
            None,
            2,
        );
        trash.builtin = Some(crate::models::Builtin::Trash);
        Workspace {
            version: 1,
            updated_at: 0,
            nodes: vec![
                Node::new(
                    "d_active".to_string(),
                    NodeKind::Doc,
                    "Active".to_string(),
                    None,
                    0,
                ),
                completed,
                trash,
                Node::new(
                    "d_archived".to_string(),
                    NodeKind::Doc,
                    "Archived note".to_string(),
                    Some(COMPLETED_ID.to_string()),
                    0,
                ),
                Node::new(
                    "d_trashed".to_string(),
                    NodeKind::Doc,
                    "Trashed note".to_string(),
                    Some(TRASH_ID.to_string()),
                    0,
                ),
            ],
        }
    }

    #[test]
    fn scope_always_includes_archive_and_excludes_trash() {
        let ws = workspace();
        let ids: Vec<String> = scope_nodes(&ws).into_iter().map(|node| node.id).collect();
        assert!(ids.contains(&"d_active".to_string()));
        assert!(ids.contains(&COMPLETED_ID.to_string()));
        assert!(ids.contains(&"d_archived".to_string()));
        assert!(!ids.contains(&"d_trashed".to_string()));
        assert!(!ids.contains(&TRASH_ID.to_string()));
        // active note, archived folder, archived note
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn folder_plans_cover_create_skip_rename_move_and_restore() {
        let link = FolderLink {
            page_id: "folder-page".to_string(),
            parent_page_id: "root".to_string(),
            title: "Folder".to_string(),
            in_trash: false,
        };
        assert!(plan_folder(None, RemotePage::Missing, "Folder", "root").create);
        assert_eq!(
            plan_folder(Some(&link), RemotePage::Active, "Folder", "root"),
            FolderPlan::default()
        );
        assert_eq!(
            plan_folder(Some(&link), RemotePage::Trashed, "Folder", "root"),
            FolderPlan {
                restore: true,
                ..FolderPlan::default()
            }
        );
        assert_eq!(
            plan_folder(Some(&link), RemotePage::Active, "Renamed", "root"),
            FolderPlan {
                rename: true,
                ..FolderPlan::default()
            }
        );
        assert_eq!(
            plan_folder(Some(&link), RemotePage::Active, "Folder", "other"),
            FolderPlan {
                move_page: true,
                ..FolderPlan::default()
            }
        );
    }
}
