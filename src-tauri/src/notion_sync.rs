//! Two-way Notion sync.
//!
//! Local folders become child pages, local documents become pages whose body is
//! the document. A run can push, pull, or do both; when both sides changed since
//! the last successful sync the document is reported as a conflict instead of
//! being overwritten.
//!
//! The run is strictly sequential (Notion allows ~3 requests/second), reports
//! progress through the `notion:progress` event and never aborts on a single
//! document: failures are collected and returned so the UI can list them.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};

use crate::atomic::{read_json, write_json_atomic};
use crate::error::{AppError, AppResult};
use crate::models::{now_ms, DocFile, Node, NodeKind, Workspace};
use crate::notion::{self, NotionClient, PageLink};
use crate::notion_blocks::{self, BlockNode, ASSET_MARKER};
use crate::paths::{short_id, workspace_root, Paths};
use crate::workspace::{self, COMPLETED_ID};

/// Notion accepts at most 100 children per request.
const MAX_BLOCKS: usize = 100;
/// Single-part upload limit; anything bigger degrades to a text placeholder.
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// Recursion guard for block trees and page nesting.
const MAX_DEPTH: usize = 12;
/// Upper bound for one run, so a mis-mapped target page cannot import forever.
const MAX_IMPORTS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    /// Create only what is missing; documents already synced are skipped.
    #[default]
    NewOnly,
    /// Also rewrite the body of documents changed since the last sync.
    Overwrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncDirection {
    /// Local changes go to Notion; remote edits are left alone.
    #[default]
    Push,
    /// Notion changes come back; local edits are left alone.
    Pull,
    /// Both directions, with conflicts decided by `conflict_policy`.
    Both,
}

impl SyncDirection {
    fn pushes(self) -> bool {
        matches!(self, SyncDirection::Push | SyncDirection::Both)
    }

    fn pulls(self) -> bool {
        matches!(self, SyncDirection::Pull | SyncDirection::Both)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    /// Report the document and let the user decide.
    #[default]
    Ask,
    /// Local wins: the Notion body is rewritten.
    Local,
    /// Notion wins: the local body is replaced.
    Remote,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOptions {
    #[serde(default)]
    pub include_completed: bool,
    #[serde(default)]
    pub mode: SyncMode,
    #[serde(default)]
    pub direction: SyncDirection,
    #[serde(default)]
    pub conflict_policy: ConflictPolicy,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFailure {
    pub doc_id: String,
    pub title: String,
    pub message: String,
}

/// A document both sides changed since the last sync.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub doc_id: String,
    pub title: String,
    pub page_id: String,
    pub url: String,
}

#[derive(Debug, Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncStats {
    pub folders_created: usize,
    pub pages_created: usize,
    pub pages_updated: usize,
    pub pages_skipped: usize,
    pub pages_pulled: usize,
    pub pages_imported: usize,
    pub conflicts: Vec<SyncConflict>,
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

fn emit<R: Runtime>(app: &AppHandle<R>, phase: &'static str, done: usize, total: usize, current: &str) {
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
/// collision far less likely than the timestamp comparison it replaces.
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

fn next_order(ws: &Workspace, parent: Option<&str>) -> i64 {
    ws.nodes
        .iter()
        .filter(|n| n.parent_id.as_deref() == parent)
        .map(|n| n.order + 1)
        .max()
        .unwrap_or(0)
}

fn count_scope(ws: &Workspace, parent: Option<&str>, include_completed: bool) -> usize {
    let mut total = 0;
    let mut queue = vec![parent.map(|p| p.to_string())];
    while let Some(current) = queue.pop() {
        for node in ordered_children(ws, current.as_deref()) {
            total += 1;
            if node.kind == NodeKind::Folder {
                queue.push(Some(node.id.clone()));
            }
        }
        if current.is_none() && include_completed {
            total += 1; // the 「已归档」 page itself
            total += ordered_children(ws, Some(COMPLETED_ID)).len();
        }
    }
    total
}

// ------------------------------------------------------------------ images

fn mime_for(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
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
                        node.block = notion_blocks::placeholder(&format!("Image not synced: {name}"));
                    }
                }
            }
        }
        apply_asset_results(&mut node.children, uploads);
    }
}

impl ImageUploads {
    /// Uploads every referenced image once; failures are remembered, not fatal.
    async fn upload_all(
        &mut self,
        client: &NotionClient,
        paths: &Paths,
        refs: &[String],
    ) {
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
        let file = paths
            .asset_file(rel)
            .map_err(|err| err.message)?;
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

// ------------------------------------------------------------------ writing

/// Appends blocks to a page/block, walking children level by level because
/// Notion nests at most two levels per request.
async fn append_tree(client: &NotionClient, parent_id: &str, blocks: &[BlockNode]) -> AppResult<()> {
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
                .cloned()
                .unwrap_or_default();
            for item in &results {
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    created.push(id.to_string());
                }
            }
        }
        if created.len() != level.len() {
            return Err(AppError::new(
                "notion_append_failed",
                "Notion returned a different number of blocks than were sent; the content may have been truncated",
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

/// Deletes every direct child of a page (used by "overwrite").
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
        .ok_or_else(|| AppError::new("notion_create_failed", "Notion did not return the new page id"))
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

// ------------------------------------------------------------------ reading

/// Fetches a page's metadata: `(last_edited_time, title)`.
///
/// `Ok(None)` means the page no longer exists (deleted or un-shared), which the
/// caller treats as "rebuild it" rather than as an error.
async fn remote_page_meta(
    client: &NotionClient,
    page_id: &str,
) -> AppResult<Option<(String, String)>> {
    match client.get(&format!("/pages/{page_id}")).await {
        Ok(page) => {
            let edited = page
                .get("last_edited_time")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Ok(Some((edited, notion::page_title(&page))))
        }
        Err(err) if err.code == "notion_not_found" => Ok(None),
        Err(err) => Err(err),
    }
}

/// Reads a page's whole block tree, attaching each block's children inline.
async fn fetch_blocks(
    client: &NotionClient,
    block_id: &str,
    depth: usize,
) -> AppResult<Vec<Value>> {
    if depth > MAX_DEPTH {
        return Ok(Vec::new());
    }
    let mut out: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let url = match &cursor {
            Some(c) => format!("/blocks/{block_id}/children?page_size=100&start_cursor={c}"),
            None => format!("/blocks/{block_id}/children?page_size=100"),
        };
        let response = client.get(&url).await?;
        let results = response
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for mut block in results {
            let has_children = block
                .get("has_children")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if has_children {
                if let Some(id) = block.get("id").and_then(Value::as_str).map(str::to_string) {
                    let kids = Box::pin(fetch_blocks(client, &id, depth + 1)).await?;
                    block["children"] = Value::Array(kids);
                }
            }
            out.push(block);
        }
        let more = response
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let next = response
            .get("next_cursor")
            .and_then(Value::as_str)
            .map(str::to_string);
        match (more, next) {
            (true, Some(next)) => cursor = Some(next),
            _ => break,
        }
    }
    Ok(out)
}

// --------------------------------------------------------------------- run

struct Ctx<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    client: &'a NotionClient,
    paths: &'a Paths,
    ws: Workspace,
    cfg: notion::NotionConfig,
    options: SyncOptions,
    stats: SyncStats,
    uploads: ImageUploads,
    done: usize,
    total: usize,
    ws_dirty: bool,
    imported: usize,
}

impl<'a, R: Runtime> Ctx<'a, R> {
    fn tick(&mut self, phase: &'static str, current: &str) {
        self.done += 1;
        emit(self.app, phase, self.done, self.total, current);
    }

    fn node(&self, id: &str) -> Option<&Node> {
        self.ws.nodes.iter().find(|n| n.id == id)
    }

    fn node_name(&self, id: &str) -> String {
        self.node(id).map(|n| n.name.clone()).unwrap_or_default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Skip,
    Push,
    Pull,
    Baseline,
    Conflict,
}

/// Creates or reuses the Notion page for a folder and returns its page id.
async fn ensure_folder_page<R: Runtime>(
    ctx: &mut Ctx<'_, R>,
    folder: &Node,
    notion_parent: &str,
) -> AppResult<String> {
    if let Some(page) = ctx.cfg.folders.get(&folder.id).cloned() {
        // keep the local name authoritative: a rename in Novion should reach
        // Notion on the next push
        if ctx.options.direction.pushes() {
            let _ = rename_page(ctx.client, &page, &folder.name).await;
        }
        return Ok(page); // created by a previous run; keep the user's edits
    }
    let page = create_page(ctx.client, notion_parent, &folder.name).await?;
    ctx.cfg.folders.insert(folder.id.clone(), page.clone());
    ctx.stats.folders_created += 1;
    Ok(page)
}

fn decide(
    has_link: bool,
    local_changed: bool,
    remote_changed: bool,
    direction: SyncDirection,
    policy: ConflictPolicy,
) -> Decision {
    if !has_link {
        return if direction.pushes() {
            Decision::Push
        } else {
            Decision::Skip
        };
    }
    if direction == SyncDirection::Push {
        // legacy single-direction behaviour is decided by the caller
        return Decision::Skip;
    }
    match (local_changed, remote_changed) {
        (false, false) => Decision::Skip,
        (true, false) => {
            if direction.pushes() {
                Decision::Push
            } else {
                Decision::Skip
            }
        }
        (false, true) => {
            if direction.pulls() {
                Decision::Pull
            } else {
                Decision::Skip
            }
        }
        (true, true) => match policy {
            ConflictPolicy::Local => {
                if direction.pushes() {
                    Decision::Push
                } else {
                    Decision::Conflict
                }
            }
            ConflictPolicy::Remote => {
                if direction.pulls() {
                    Decision::Pull
                } else {
                    Decision::Conflict
                }
            }
            ConflictPolicy::Ask => Decision::Conflict,
        },
    }
}

async fn sync_doc<R: Runtime>(
    ctx: &mut Ctx<'_, R>,
    node: &Node,
    notion_parent: &str,
    force_push: bool,
) -> AppResult<()> {
    let existing = ctx.cfg.pages.get(&node.id).cloned();
    let file = ctx.paths.doc_file(&node.id)?;
    let doc = read_json::<DocFile>(&file).await?;
    let title = if node.name.trim().is_empty() {
        doc.title.clone()
    } else {
        node.name.clone()
    };
    let local_hash = content_hash(&doc.content);

    // ---- decide what this document needs
    let mut remote_time = existing
        .as_ref()
        .map(|link| link.remote_edited_at.clone())
        .unwrap_or_default();
    let mut remote_title = String::new();
    let mut page_missing = false;

    let decision = if force_push {
        Decision::Push
    } else if ctx.options.direction == SyncDirection::Push {
        match &existing {
            None => Decision::Push,
            Some(link) => {
                if !link.ok {
                    Decision::Push
                } else if ctx.options.mode == SyncMode::Overwrite
                    && link.doc_updated_at < doc.updated_at
                {
                    Decision::Push
                } else {
                    Decision::Skip
                }
            }
        }
    } else if let Some(link) = &existing {
        let local_changed = !link.local_hash.is_empty() && link.local_hash != local_hash;
        let mut remote_changed = false;
        if ctx.options.direction.pulls() {
            match remote_page_meta(ctx.client, &link.page_id).await? {
                Some((edited, remote_name)) => {
                    remote_title = remote_name;
                    remote_changed = !link.remote_edited_at.is_empty()
                        && !edited.is_empty()
                        && link.remote_edited_at != edited;
                    remote_time = edited;
                }
                None => page_missing = true,
            }
        }
        if page_missing {
            Decision::Push
        } else if link.local_hash.is_empty() {
            // migrated link: record the baseline without touching either side
            Decision::Baseline
        } else {
            decide(
                true,
                local_changed,
                remote_changed,
                ctx.options.direction,
                ctx.options.conflict_policy,
            )
        }
    } else {
        Decision::Skip
    };

    // "New pages only" also governs the two-way mode: an already-synced page is
    // never rewritten, even when only the local side changed.
    let decision = if decision == Decision::Push
        && !force_push
        && ctx.options.mode == SyncMode::NewOnly
        && !page_missing
        && existing.as_ref().map(|link| link.ok).unwrap_or(false)
    {
        Decision::Skip
    } else {
        decision
    };

    match decision {
        Decision::Skip => {
            // a link without a remote timestamp (created by a push-only run or
            // by an import) learns one here, without pulling anything
            if ctx.options.direction.pulls() && !remote_time.is_empty() {
                if let Some(link) = ctx.cfg.pages.get_mut(&node.id) {
                    if link.remote_edited_at.is_empty() {
                        link.remote_edited_at = remote_time.clone();
                        link.synced_at = now_ms();
                    }
                }
            }
            ctx.stats.pages_skipped += 1;
            ctx.tick("docs", &title);
            return Ok(());
        }
        Decision::Baseline => {
            let remote = remote_time.clone();
            if let Some(link) = ctx.cfg.pages.get_mut(&node.id) {
                link.local_hash = local_hash;
                link.remote_edited_at = remote;
                link.synced_at = now_ms();
            }
            ctx.stats.pages_skipped += 1;
            ctx.tick("docs", &title);
            return Ok(());
        }
        Decision::Conflict => {
            if let Some(link) = &existing {
                ctx.stats.conflicts.push(SyncConflict {
                    doc_id: node.id.clone(),
                    title: title.clone(),
                    page_id: link.page_id.clone(),
                    url: notion::page_url(&link.page_id),
                });
            }
            ctx.tick("docs", &title);
            return Ok(());
        }
        Decision::Pull => {
            let link = existing.clone().expect("pull needs an existing link");
            pull_doc(ctx, &node.id, &title, &link, &remote_title).await?;
            return Ok(());
        }
        Decision::Push => {}
    }

    // ---- push
    let mut blocks = notion_blocks::convert_doc(&doc.content);
    let mut refs = Vec::new();
    collect_asset_refs(&blocks, &mut refs);
    ctx.uploads.upload_all(ctx.client, ctx.paths, &refs).await;
    apply_asset_results(&mut blocks, &ctx.uploads);

    let mut page_id = None;
    let mut created = false;
    if existing.is_some() && !page_missing {
        let link = existing.as_ref().unwrap();
        let outcome = async {
            rename_page(ctx.client, &link.page_id, &title).await?;
            clear_children(ctx.client, &link.page_id).await?;
            append_tree(ctx.client, &link.page_id, &blocks).await
        }
        .await;
        match outcome {
            Ok(()) => page_id = Some(link.page_id.clone()),
            Err(err) if err.code == "notion_not_found" => {
                // the page was deleted / un-shared since the last sync
                ctx.cfg.pages.remove(&node.id);
                page_id = None;
            }
            Err(err) => {
                ctx.stats.failures.push(SyncFailure {
                    doc_id: node.id.clone(),
                    title: title.clone(),
                    message: err.message,
                });
                ctx.tick("docs", &title);
                return Ok(());
            }
        }
    }

    if page_id.is_none() {
        let id = create_page(ctx.client, notion_parent, &title).await?;
        if let Err(err) = append_tree(ctx.client, &id, &blocks).await {
            ctx.cfg.pages.insert(
                node.id.clone(),
                PageLink {
                    page_id: id,
                    title: title.clone(),
                    doc_updated_at: 0,
                    synced_at: now_ms(),
                    ok: false,
                    local_hash: String::new(),
                    remote_edited_at: String::new(),
                },
            );
            ctx.stats.failures.push(SyncFailure {
                doc_id: node.id.clone(),
                title: title.clone(),
                message: err.message,
            });
            ctx.tick("docs", &title);
            return Ok(());
        }
        created = true;
        page_id = Some(id);
    }

    let Some(id) = page_id else {
        ctx.tick("docs", &title);
        return Ok(());
    };

    // record the revision we just wrote; when syncing both ways also remember
    // Notion's own stamp so the next run does not read our write as a remote edit
    if ctx.options.direction.pulls() {
        if let Ok(Some((edited, _))) = remote_page_meta(ctx.client, &id).await {
            remote_time = edited;
        }
    } else {
        remote_time = String::new();
    }

    ctx.cfg.pages.insert(
        node.id.clone(),
        PageLink {
            page_id: id,
            title: title.clone(),
            doc_updated_at: doc.updated_at,
            synced_at: now_ms(),
            ok: true,
            local_hash,
            remote_edited_at: remote_time,
        },
    );

    if created {
        ctx.stats.pages_created += 1;
    } else {
        ctx.stats.pages_updated += 1;
    }
    ctx.tick("docs", &title);
    Ok(())
}

/// Replaces a local document with the Notion body.
async fn pull_doc<R: Runtime>(
    ctx: &mut Ctx<'_, R>,
    doc_id: &str,
    title: &str,
    link: &PageLink,
    remote_title: &str,
) -> AppResult<()> {
    let blocks = fetch_blocks(ctx.client, &link.page_id, 0).await?;
    let content = notion_blocks::blocks_to_doc(&blocks);
    let file = ctx.paths.doc_file(doc_id)?;
    let created_at = read_json::<DocFile>(&file)
        .await
        .map(|doc| doc.created_at)
        .unwrap_or_else(|_| now_ms());

    // a rename in Notion renames the note here too
    let mut final_title = title.to_string();
    if !remote_title.trim().is_empty() && remote_title.trim() != title {
        final_title = remote_title.trim().to_string();
        if let Some(node) = ctx.ws.nodes.iter_mut().find(|n| n.id == doc_id) {
            node.name = final_title.clone();
            node.updated_at = now_ms();
            ctx.ws_dirty = true;
        }
    } else if let Some(node) = ctx.node(doc_id) {
        final_title = node.name.clone();
    }

    let doc = DocFile {
        id: doc_id.to_string(),
        title: final_title.clone(),
        created_at,
        updated_at: now_ms(),
        schema_version: 1,
        content,
    };
    write_json_atomic(&file, &doc).await?;

    let hash = content_hash(&doc.content);
    let edited = remote_page_meta(ctx.client, &link.page_id)
        .await?
        .map(|(edited, _)| edited)
        .unwrap_or_default();
    if let Some(entry) = ctx.cfg.pages.get_mut(doc_id) {
        entry.title = final_title.clone();
        entry.local_hash = hash;
        entry.remote_edited_at = edited;
        entry.synced_at = now_ms();
        entry.doc_updated_at = doc.updated_at;
        entry.ok = true;
    }

    ctx.stats.pages_pulled += 1;
    ctx.tick("pull", &final_title);
    Ok(())
}

/// Adds pages that exist in Notion but not yet locally.
async fn import_new_pages<R: Runtime>(ctx: &mut Ctx<'_, R>) -> AppResult<()> {
    let mut known: HashSet<String> = ctx.cfg.pages.values().map(|l| l.page_id.clone()).collect();
    // page id → local folder id, so an existing folder is still walked for
    // pages that were created inside it on the Notion side
    let folder_of_page: HashMap<String, String> = ctx
        .cfg
        .folders
        .iter()
        .map(|(folder, page)| (page.clone(), folder.clone()))
        .collect();
    for page in ctx.cfg.folders.values() {
        known.insert(page.clone());
    }

    // (notion page id, local parent, depth)
    let mut queue: Vec<(String, Option<String>, usize)> =
        vec![(ctx.cfg.parent_page_id.clone(), None, 0)];
    let mut visited: HashSet<String> = HashSet::new();

    while let Some((notion_page, local_parent, depth)) = queue.pop() {
        if depth > MAX_DEPTH || ctx.imported >= MAX_IMPORTS {
            continue;
        }
        if !visited.insert(notion_page.clone()) {
            continue;
        }
        let blocks = fetch_blocks(ctx.client, &notion_page, 0).await?;
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("child_page") {
                continue;
            }
            if ctx.imported >= MAX_IMPORTS {
                break;
            }
            let Some(page_id) = block.get("id").and_then(Value::as_str).map(str::to_string) else {
                continue;
            };
            if known.contains(&page_id) {
                // an existing folder may hold pages created in Notion since the
                // last run; walk into it, but never re-import a document
                if let Some(folder_id) = folder_of_page.get(&page_id) {
                    queue.push((page_id.clone(), Some(folder_id.clone()), depth + 1));
                }
                continue;
            }
            let title = block
                .pointer("/child_page/title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .chars()
                .take(160)
                .collect::<String>();
            let title = if title.is_empty() {
                "Untitled".to_string()
            } else {
                title
            };

            let children = fetch_blocks(ctx.client, &page_id, 0).await?;
            let has_child_pages = children
                .iter()
                .any(|child| child.get("type").and_then(Value::as_str) == Some("child_page"));

            if has_child_pages {
                let id = format!("f_{}", short_id());
                let order = next_order(&ctx.ws, local_parent.as_deref());
                ctx.ws.nodes.push(Node::new(
                    id.clone(),
                    NodeKind::Folder,
                    title.clone(),
                    local_parent.clone(),
                    order,
                ));
                ctx.ws.updated_at = now_ms();
                ctx.ws_dirty = true;
                ctx.cfg.folders.insert(id.clone(), page_id.clone());
                known.insert(page_id.clone());
                queue.push((page_id.clone(), Some(id), depth + 1));
            } else {
                let id = format!("d_{}", short_id());
                let order = next_order(&ctx.ws, local_parent.as_deref());
                ctx.ws.nodes.push(Node::new(
                    id.clone(),
                    NodeKind::Doc,
                    title.clone(),
                    local_parent.clone(),
                    order,
                ));
                ctx.ws.updated_at = now_ms();
                ctx.ws_dirty = true;

                let content = notion_blocks::blocks_to_doc(&children);
                let now = now_ms();
                let doc = DocFile {
                    id: id.clone(),
                    title: title.clone(),
                    created_at: now,
                    updated_at: now,
                    schema_version: 1,
                    content,
                };
                write_json_atomic(&ctx.paths.doc_file(&id)?, &doc).await?;

                ctx.cfg.pages.insert(
                    id.clone(),
                    PageLink {
                        page_id: page_id.clone(),
                        title: title.clone(),
                        doc_updated_at: now,
                        synced_at: now,
                        ok: true,
                        local_hash: content_hash(&doc.content),
                        // filled in by the next run without pulling
                        remote_edited_at: String::new(),
                    },
                );
                known.insert(page_id.clone());
                ctx.imported += 1;
                ctx.stats.pages_imported += 1;
                ctx.tick("import", &title);
            }
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
    options: SyncOptions,
) -> AppResult<Ctx<'a, R>> {
    let cfg = notion::snapshot(app);
    validate(&cfg)?;
    let ws = workspace::load_shared(paths).await?.as_ref().clone();

    let total = count_scope(&ws, None, options.include_completed);
    Ok(Ctx {
        app,
        client,
        paths,
        ws,
        cfg,
        options,
        stats: SyncStats::default(),
        uploads: ImageUploads::new(),
        done: 0,
        total,
        ws_dirty: false,
        imported: 0,
    })
}

#[tauri::command]
pub async fn notion_sync_docs<R: Runtime>(
    app: AppHandle<R>,
    options: SyncOptions,
) -> AppResult<SyncStats> {
    let client = NotionClient::from_app(&app)?;
    let paths = Paths::new(workspace_root(&app)?);
    paths.ensure_dirs().await?;
    let mut ctx = build_ctx(&app, &client, &paths, options).await?;
    emit(&app, "prepare", 0, ctx.total, "");

    // A pull-only run must never write to Notion, so it walks the existing
    // page links instead of the local tree (which would create folder pages).
    if ctx.options.direction == SyncDirection::Pull {
        let entries: Vec<String> = ctx.cfg.pages.keys().cloned().collect();
        for doc_id in entries {
            let Some(node) = ctx.node(&doc_id).cloned() else {
                continue;
            };
            if let Err(err) = sync_doc(&mut ctx, &node, "", false).await {
                ctx.stats.failures.push(SyncFailure {
                    doc_id: node.id.clone(),
                    title: node.name.clone(),
                    message: err.message,
                });
                ctx.tick("docs", &node.name);
            }
        }
        if let Err(err) = import_new_pages(&mut ctx).await {
            ctx.stats.failures.push(SyncFailure {
                doc_id: String::new(),
                title: ctx.cfg.parent_page_title.clone(),
                message: err.message,
            });
        }
        return finish(ctx).await;
    }

    let mut queue: Vec<(String, Option<String>)> = vec![(ctx.cfg.parent_page_id.clone(), None)];
    let mut root_done = false;

    while let Some((notion_parent, ws_parent)) = queue.pop() {
        let children = ordered_children(&ctx.ws, ws_parent.as_deref());

        for node in children {
            match node.kind {
                NodeKind::Folder => {
                    match ensure_folder_page(&mut ctx, &node, &notion_parent).await {
                        Ok(page) => {
                            ctx.tick("folders", &node.name);
                            queue.push((page, Some(node.id.clone())));
                        }
                        Err(err) => {
                            ctx.stats.failures.push(SyncFailure {
                                doc_id: node.id.clone(),
                                title: node.name.clone(),
                                message: err.message,
                            });
                            ctx.tick("folders", &node.name);
                        }
                    }
                }
                NodeKind::Doc => {
                    if let Err(err) = sync_doc(&mut ctx, &node, &notion_parent, false).await {
                        ctx.stats.failures.push(SyncFailure {
                            doc_id: node.id.clone(),
                            title: node.name.clone(),
                            message: err.message,
                        });
                        ctx.tick("docs", &node.name);
                    }
                }
            }
        }

        // 「已归档」 lives at the root but is excluded from `ordered_children`
        if ws_parent.is_none() && !root_done {
            root_done = true;
            if ctx.options.include_completed {
                let completed = ctx.ws.nodes.iter().find(|n| n.id == COMPLETED_ID).cloned();
                if let Some(folder) = completed {
                    match ensure_folder_page(&mut ctx, &folder, &notion_parent).await {
                        Ok(page) => {
                            ctx.tick("folders", &folder.name);
                            queue.push((page, Some(folder.id.clone())));
                        }
                        Err(err) => {
                            ctx.stats.failures.push(SyncFailure {
                                doc_id: folder.id.clone(),
                                title: folder.name.clone(),
                                message: err.message,
                            });
                            ctx.tick("folders", &folder.name);
                        }
                    }
                }
            }
        }
    }

    if ctx.options.direction.pulls() {
        if let Err(err) = import_new_pages(&mut ctx).await {
            ctx.stats.failures.push(SyncFailure {
                doc_id: String::new(),
                title: ctx.cfg.parent_page_title.clone(),
                message: err.message,
            });
        }
    }

    finish(ctx).await
}

/// Persists the config and the workspace, then builds the final statistics.
async fn finish<R: Runtime>(mut ctx: Ctx<'_, R>) -> AppResult<SyncStats> {
    let now = now_ms();
    ctx.cfg.last_sync_at = now;
    if ctx.ws_dirty {
        workspace::save(ctx.paths, &ctx.ws).await?;
    }
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
        stats.pages_created + stats.pages_updated + stats.pages_pulled + stats.pages_skipped,
        ctx.total,
        "",
    );
    Ok(stats)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictAction {
    /// Push the local body, replacing Notion's.
    Local,
    /// Pull Notion's body, replacing the local one.
    Remote,
    /// Keep both: pull Notion's body into a new note, then push the local one.
    Both,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolution {
    pub doc_id: String,
    pub action: ConflictAction,
}

#[tauri::command]
pub async fn notion_resolve_conflicts<R: Runtime>(
    app: AppHandle<R>,
    resolutions: Vec<ConflictResolution>,
) -> AppResult<SyncStats> {
    let client = NotionClient::from_app(&app)?;
    let paths = Paths::new(workspace_root(&app)?);
    paths.ensure_dirs().await?;
    let mut ctx = build_ctx(
        &app,
        &client,
        &paths,
        SyncOptions {
            include_completed: false,
            mode: SyncMode::Overwrite,
            direction: SyncDirection::Both,
            conflict_policy: ConflictPolicy::Ask,
        },
    )
    .await?;
    emit(&app, "prepare", 0, ctx.total, "");

    for resolution in resolutions {
        let Some(link) = ctx.cfg.pages.get(&resolution.doc_id).cloned() else {
            continue;
        };
        let Some(node) = ctx.node(&resolution.doc_id).cloned() else {
            continue;
        };
        let notion_parent = ctx
            .cfg
            .folders
            .get(node.parent_id.as_deref().unwrap_or(""))
            .cloned()
            .unwrap_or_else(|| ctx.cfg.parent_page_id.clone());

        let result = match resolution.action {
            ConflictAction::Local => sync_doc(&mut ctx, &node, &notion_parent, true).await,
            ConflictAction::Remote => {
                pull_doc(&mut ctx, &node.id, &node.name, &link, "").await
            }
            ConflictAction::Both => keep_both(&mut ctx, &node, &link, &notion_parent).await,
        };
        if let Err(err) = result {
            ctx.stats.failures.push(SyncFailure {
                doc_id: node.id.clone(),
                title: node.name.clone(),
                message: err.message,
            });
        }
    }

    let now = now_ms();
    ctx.cfg.last_sync_at = now;
    if ctx.ws_dirty {
        workspace::save(&ctx.paths, &ctx.ws).await?;
    }
    notion::save(&app, &ctx.cfg).await?;
    notion::remember(&app, &ctx.cfg);

    let mut stats = std::mem::take(&mut ctx.stats);
    stats.last_sync_at = now;
    stats.parent_url = notion::page_url(&ctx.cfg.parent_page_id);
    Ok(stats)
}

/// Pulls Notion's body into a new note and pushes the local body back.
async fn keep_both<R: Runtime>(
    ctx: &mut Ctx<'_, R>,
    node: &Node,
    link: &PageLink,
    notion_parent: &str,
) -> AppResult<()> {
    let blocks = fetch_blocks(ctx.client, &link.page_id, 0).await?;
    let content = notion_blocks::blocks_to_doc(&blocks);
    let copy_title = format!("{} (Notion)", node.name);
    let id = format!("d_{}", short_id());
    let order = next_order(&ctx.ws, node.parent_id.as_deref());
    ctx.ws.nodes.push(Node::new(
        id.clone(),
        NodeKind::Doc,
        copy_title.clone(),
        node.parent_id.clone(),
        order,
    ));
    ctx.ws.updated_at = now_ms();
    ctx.ws_dirty = true;

    let now = now_ms();
    let doc = DocFile {
        id: id.clone(),
        title: copy_title.clone(),
        created_at: now,
        updated_at: now,
        schema_version: 1,
        content,
    };
    write_json_atomic(&ctx.paths.doc_file(&id)?, &doc).await?;
    // The copy deliberately has no page link: the original keeps that page, and
    // a link pointing at it would make the next sync rewrite it with the copy.

    // the original keeps the page and gets the local body
    sync_doc(ctx, node, notion_parent, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_stable_and_sensitive() {
        let a = json!({ "type": "doc", "content": [{ "type": "text", "text": "a" }] });
        let b = json!({ "type": "doc", "content": [{ "type": "text", "text": "b" }] });
        assert_eq!(content_hash(&a), content_hash(&a.clone()));
        assert_ne!(content_hash(&a), content_hash(&b));
    }

    #[test]
    fn conflict_matrix() {
        // fully qualified: the two enums share variant names
        let both = SyncDirection::Both;
        let push = SyncDirection::Push;
        let pull = SyncDirection::Pull;
        let ask = ConflictPolicy::Ask;

        assert_eq!(decide(true, false, false, both, ask), Decision::Skip);
        assert_eq!(decide(true, true, false, both, ask), Decision::Push);
        assert_eq!(decide(true, false, true, both, ask), Decision::Pull);
        assert_eq!(decide(true, true, true, both, ask), Decision::Conflict);
        assert_eq!(
            decide(true, true, true, both, ConflictPolicy::Local),
            Decision::Push
        );
        assert_eq!(
            decide(true, true, true, both, ConflictPolicy::Remote),
            Decision::Pull
        );
        // a pull-only run never writes to Notion
        assert_eq!(decide(true, true, false, pull, ask), Decision::Skip);
        assert_eq!(decide(false, false, false, pull, ask), Decision::Skip);
        assert_eq!(decide(false, false, false, push, ask), Decision::Push);
    }
}