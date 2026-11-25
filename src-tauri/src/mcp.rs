use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use subtle::ConstantTimeEq;
use tauri::{AppHandle, State as TauriState};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

use crate::config::{self, Config};
use crate::error::{AppError, AppResult};
use crate::models::{Node, NodeKind};
use crate::paths::{workspace_root, Paths};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub host: &'static str,
    pub port: u16,
    pub endpoint: String,
    pub token: String,
}

struct RunningServer {
    port: u16,
    cancellation: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct McpState {
    server: Mutex<Option<RunningServer>>,
}

fn status(config: &Config, running: bool, port: u16) -> McpStatus {
    McpStatus {
        running,
        host: "127.0.0.1",
        port,
        endpoint: format!("http://127.0.0.1:{port}/mcp"),
        token: config.mcp_token.clone(),
    }
}

async fn current_status(app: &AppHandle<tauri::Wry>, state: &McpState) -> AppResult<McpStatus> {
    let mut server = state.server.lock().await;
    if server
        .as_ref()
        .is_some_and(|running| running.task.inner().is_finished())
    {
        server.take();
    }
    let config = config::ensure_mcp_token(app)?;
    match server.as_ref() {
        Some(running) => Ok(status(&config, true, running.port)),
        None => Ok(status(&config, false, config.mcp_port)),
    }
}

#[tauri::command]
pub async fn mcp_get_status(
    app: AppHandle<tauri::Wry>,
    state: TauriState<'_, McpState>,
) -> AppResult<McpStatus> {
    current_status(&app, &state).await
}

#[tauri::command]
pub async fn mcp_set_port(
    app: AppHandle<tauri::Wry>,
    state: TauriState<'_, McpState>,
    port: u16,
) -> AppResult<McpStatus> {
    let mut server = state.server.lock().await;
    if server
        .as_ref()
        .is_some_and(|running| !running.task.inner().is_finished())
    {
        return Err(AppError::invalid("停止 MCP 服务后才能更改端口"));
    }
    server.take();
    let config = config::set_mcp_port(&app, port)?;
    let response = status(&config, false, config.mcp_port);
    drop(server);
    Ok(response)
}

#[tauri::command]
pub async fn mcp_rotate_token(
    app: AppHandle<tauri::Wry>,
    state: TauriState<'_, McpState>,
) -> AppResult<McpStatus> {
    let mut server = state.server.lock().await;
    if server
        .as_ref()
        .is_some_and(|running| !running.task.inner().is_finished())
    {
        return Err(AppError::invalid("停止 MCP 服务后才能更换访问令牌"));
    }
    server.take();
    let config = config::rotate_mcp_token(&app)?;
    let response = status(&config, false, config.mcp_port);
    drop(server);
    Ok(response)
}

#[tauri::command]
pub async fn mcp_start(
    app: AppHandle<tauri::Wry>,
    state: TauriState<'_, McpState>,
) -> AppResult<McpStatus> {
    let mut slot = state.server.lock().await;
    let config = config::ensure_mcp_token(&app)?;
    if slot
        .as_ref()
        .is_some_and(|running| !running.task.inner().is_finished())
    {
        let running = slot.as_ref().expect("running server was checked");
        return Ok(status(&config, true, running.port));
    }
    slot.take();

    let address = SocketAddr::from(([127, 0, 0, 1], config.mcp_port));
    let listener = TcpListener::bind(address)
        .await
        .map_err(|error| AppError::wrap("启动本地 MCP 服务失败", error))?;
    let cancellation = CancellationToken::new();
    let service_cancel = cancellation.child_token();
    let app_for_tools = app.clone();
    let service = StreamableHttpService::new(
        move || Ok(NovionMcp::new(app_for_tools.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_json_response(true)
            .with_cancellation_token(service_cancel),
    );
    let router = Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(
            Arc::new(config.mcp_token.clone()),
            authorize_request,
        ));
    let shutdown = cancellation.clone();
    let task = tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async move { shutdown.cancelled().await })
            .await
        {
            eprintln!("[novion] MCP server stopped: {error}");
        }
    });
    let port = config.mcp_port;
    *slot = Some(RunningServer {
        port,
        cancellation,
        task,
    });
    Ok(status(&config, true, port))
}

#[tauri::command]
pub async fn mcp_stop(
    app: AppHandle<tauri::Wry>,
    state: TauriState<'_, McpState>,
) -> AppResult<McpStatus> {
    let mut server = state.server.lock().await;
    let running = server.take();
    if let Some(running) = running {
        running.cancellation.cancel();
        let _ = running.task.await;
    }
    drop(server);
    current_status(&app, &state).await
}

async fn authorize_request(
    State(expected_token): State<Arc<String>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let allowed = origin
            .to_str()
            .ok()
            .and_then(|value| Url::parse(value).ok())
            .is_some_and(is_loopback_origin);
        if !allowed {
            return StatusCode::FORBIDDEN.into_response();
        }
    }

    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    let authorized = supplied.len() == expected_token.len()
        && bool::from(supplied.as_bytes().ct_eq(expected_token.as_bytes()));
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
        )
            .into_response();
    }
    next.run(request).await
}

fn is_loopback_origin(origin: Url) -> bool {
    matches!(origin.scheme(), "http" | "https" | "tauri")
        && origin.path() == "/"
        && origin.query().is_none()
        && origin.fragment().is_none()
        && origin.username().is_empty()
        && origin.password().is_none()
        && (matches!(
            origin.host(),
            Some(Host::Domain(host)) if host.eq_ignore_ascii_case("localhost") || host.eq_ignore_ascii_case("tauri.localhost")
        ) || matches!(
            origin.host(),
            Some(Host::Ipv4(address)) if address.is_loopback()
        ) || matches!(
            origin.host(),
            Some(Host::Ipv6(address)) if address.is_loopback()
        ))
}

fn mcp_error(error: AppError) -> McpError {
    match error.code.as_str() {
        "invalid_argument" | "not_found" => McpError::invalid_params(error.message, None),
        _ => McpError::internal_error(error.message, None),
    }
}

fn json_result(value: impl Serialize) -> Result<CallToolResult, McpError> {
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ListNotesArgs {
    /// Return notes that have been moved to the Trash as well.
    #[serde(default)]
    include_trash: bool,
    /// When supplied, return only direct children of this folder.
    #[serde(default)]
    parent_id: Option<String>,
    /// Return only notes at the workspace root. Ignored when parent_id is set.
    #[serde(default)]
    root_only: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchNotesArgs {
    /// Novion search syntax, including title/text/path/date filters.
    query: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct NoteIdArgs {
    note_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateNoteArgs {
    title: String,
    /// Markdown body. Images should use workspace asset paths when applicable.
    #[serde(default)]
    content_markdown: String,
    /// Existing folder id; omit to create at the workspace root.
    #[serde(default)]
    parent_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct UpdateNoteArgs {
    note_id: String,
    /// Revision returned by get_note. Required to avoid overwriting newer edits.
    expected_revision: u64,
    #[serde(default)]
    title: Option<String>,
    /// Replaces the full body when supplied.
    #[serde(default)]
    content_markdown: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct MoveNoteArgs {
    note_id: String,
    /// Existing folder id; omit to move to the workspace root.
    #[serde(default)]
    parent_id: Option<String>,
    /// Zero-based sibling position. Omit to append.
    #[serde(default)]
    index: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ListFoldersArgs {
    /// When supplied, return only direct child folders.
    #[serde(default)]
    parent_id: Option<String>,
}

#[derive(Clone)]
struct NovionMcp {
    app: AppHandle<tauri::Wry>,
    #[allow(dead_code)] // Read by rmcp's generated ServerHandler implementation.
    tool_router: ToolRouter<Self>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteSummary {
    id: String,
    title: String,
    parent_id: Option<String>,
    path: String,
    updated_at: u64,
    revision: u64,
    trashed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderSummary {
    id: String,
    name: String,
    parent_id: Option<String>,
    path: String,
}

fn node_path(nodes: &[Node], node: &Node) -> String {
    let mut path = vec![node.name.clone()];
    let mut parent_id = node.parent_id.as_deref();
    let mut remaining = nodes.len();
    while let Some(id) = parent_id {
        if remaining == 0 {
            break;
        }
        remaining -= 1;
        let Some(parent) = nodes.iter().find(|candidate| candidate.id == id) else {
            break;
        };
        path.push(parent.name.clone());
        parent_id = parent.parent_id.as_deref();
    }
    path.reverse();
    path.join("/")
}

async fn load_note_node(app: &AppHandle<tauri::Wry>, id: &str) -> AppResult<Node> {
    let root = workspace_root(app)?;
    let workspace = crate::workspace::load_shared(&Paths::new(root)).await?;
    workspace
        .nodes
        .iter()
        .find(|node| node.id == id && node.kind == NodeKind::Doc)
        .cloned()
        .ok_or_else(|| AppError::not_found("文档不存在"))
}

#[tool_router]
impl NovionMcp {
    fn new(app: AppHandle<tauri::Wry>) -> Self {
        Self {
            app,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(description = "List Novion notes, with their ids, folders, and revision markers.")]
    async fn list_notes(
        &self,
        Parameters(args): Parameters<ListNotesArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = workspace_root(&self.app).map_err(mcp_error)?;
        let workspace = crate::workspace::load_shared(&Paths::new(root))
            .await
            .map_err(mcp_error)?;
        let mut notes = Vec::new();
        for node in workspace
            .nodes
            .iter()
            .filter(|node| node.kind == NodeKind::Doc)
        {
            let trashed = crate::workspace::in_trash(&workspace.nodes, &node.id);
            if trashed && !args.include_trash {
                continue;
            }
            if let Some(parent_id) = args.parent_id.as_deref() {
                if node.parent_id.as_deref() != Some(parent_id) {
                    continue;
                }
            } else if args.root_only && node.parent_id.is_some() {
                continue;
            }
            let revision = crate::docs::doc_stamp(self.app.clone(), node.id.clone())
                .await
                .map_err(mcp_error)?
                .mtime_ms;
            notes.push(NoteSummary {
                id: node.id.clone(),
                title: node.name.clone(),
                parent_id: node.parent_id.clone(),
                path: node_path(&workspace.nodes, node),
                updated_at: node.updated_at.max(revision),
                revision,
                trashed,
            });
        }
        json_result(notes)
    }

    #[tool(description = "List folders so note tools can target an existing parent folder id.")]
    async fn list_folders(
        &self,
        Parameters(args): Parameters<ListFoldersArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = workspace_root(&self.app).map_err(mcp_error)?;
        let workspace = crate::workspace::load_shared(&Paths::new(root))
            .await
            .map_err(mcp_error)?;
        let folders: Vec<FolderSummary> = workspace
            .nodes
            .iter()
            .filter(|node| {
                node.kind == NodeKind::Folder
                    && node.builtin.is_none()
                    && !crate::workspace::in_trash(&workspace.nodes, &node.id)
                    && args
                        .parent_id
                        .as_deref()
                        .is_none_or(|parent_id| node.parent_id.as_deref() == Some(parent_id))
            })
            .map(|node| FolderSummary {
                id: node.id.clone(),
                name: node.name.clone(),
                parent_id: node.parent_id.clone(),
                path: node_path(&workspace.nodes, node),
            })
            .collect();
        json_result(folders)
    }

    #[tool(description = "Search note titles and bodies with Novion's full-text search syntax.")]
    async fn search_notes(
        &self,
        Parameters(args): Parameters<SearchNotesArgs>,
    ) -> Result<CallToolResult, McpError> {
        let hits = crate::search::search_docs(self.app.clone(), args.query)
            .await
            .map_err(mcp_error)?;
        json_result(hits)
    }

    #[tool(
        description = "Read one note as Markdown. Save the returned revision for a later update_note call."
    )]
    async fn get_note(
        &self,
        Parameters(args): Parameters<NoteIdArgs>,
    ) -> Result<CallToolResult, McpError> {
        load_note_node(&self.app, &args.note_id)
            .await
            .map_err(mcp_error)?;
        let doc = crate::docs::read_doc(self.app.clone(), args.note_id.clone())
            .await
            .map_err(mcp_error)?;
        let revision = crate::docs::doc_stamp(self.app.clone(), args.note_id)
            .await
            .map_err(mcp_error)?
            .mtime_ms;
        json_result(json!({
            "id": doc.id,
            "title": doc.title,
            "createdAt": doc.created_at,
            "updatedAt": doc.updated_at,
            "revision": revision,
            "contentMarkdown": crate::markdown::to_markdown(&doc.content, ""),
        }))
    }

    #[tool(description = "Create a note from Markdown, optionally inside an existing folder.")]
    async fn create_note(
        &self,
        Parameters(args): Parameters<CreateNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        let created =
            crate::workspace::create_doc(self.app.clone(), args.parent_id, args.title.clone())
                .await
                .map_err(mcp_error)?;
        let title = created
            .workspace
            .nodes
            .iter()
            .find(|node| node.id == created.doc_id)
            .map(|node| node.name.clone())
            .unwrap_or(args.title);
        let content = crate::markdown::parse_markdown_body(&args.content_markdown);
        if let Err(error) = crate::docs::save_doc(
            self.app.clone(),
            created.doc_id.clone(),
            title,
            content,
            None,
            None,
        )
        .await
        {
            let _ = crate::workspace::delete_doc(self.app.clone(), created.doc_id.clone()).await;
            return Err(mcp_error(error));
        }
        let revision = crate::docs::doc_stamp(self.app.clone(), created.doc_id.clone())
            .await
            .map_err(mcp_error)?
            .mtime_ms;
        json_result(json!({ "id": created.doc_id, "revision": revision }))
    }

    #[tool(
        description = "Update a note's title and/or full Markdown body using its current revision marker."
    )]
    async fn update_note(
        &self,
        Parameters(args): Parameters<UpdateNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        if args.title.is_none() && args.content_markdown.is_none() {
            return Err(McpError::invalid_params(
                "Provide title, content_markdown, or both.".to_string(),
                None,
            ));
        }
        let stamp = crate::docs::doc_stamp(self.app.clone(), args.note_id.clone())
            .await
            .map_err(mcp_error)?;
        let stale = if stamp.exists {
            stamp.mtime_ms != args.expected_revision
        } else {
            args.expected_revision != 0
        };
        if stale {
            return Err(McpError::invalid_params(
                "The note revision changed. Read it again before updating.".to_string(),
                None,
            ));
        }
        let node = load_note_node(&self.app, &args.note_id)
            .await
            .map_err(mcp_error)?;
        let root = workspace_root(&self.app).map_err(mcp_error)?;
        let workspace = crate::workspace::load_shared(&Paths::new(root))
            .await
            .map_err(mcp_error)?;
        if crate::workspace::in_trash(&workspace.nodes, &node.id) {
            return Err(McpError::invalid_params(
                "Restore the note before updating it.".to_string(),
                None,
            ));
        }
        let current = crate::docs::read_doc(self.app.clone(), args.note_id.clone())
            .await
            .map_err(mcp_error)?;
        let title = args.title.unwrap_or(current.title);
        let content = args
            .content_markdown
            .map(|markdown| crate::markdown::parse_markdown_body(&markdown))
            .unwrap_or(current.content);
        crate::docs::save_doc(
            self.app.clone(),
            args.note_id.clone(),
            title.clone(),
            content,
            Some(args.expected_revision),
            None,
        )
        .await
        .map_err(mcp_error)?;
        crate::workspace::rename_doc(self.app.clone(), args.note_id.clone(), title)
            .await
            .map_err(mcp_error)?;
        let revision = crate::docs::doc_stamp(self.app.clone(), args.note_id)
            .await
            .map_err(mcp_error)?
            .mtime_ms;
        json_result(json!({ "revision": revision }))
    }

    #[tool(description = "Move a note to a folder or to the workspace root.")]
    async fn move_note(
        &self,
        Parameters(args): Parameters<MoveNoteArgs>,
    ) -> Result<CallToolResult, McpError> {
        load_note_node(&self.app, &args.note_id)
            .await
            .map_err(mcp_error)?;
        crate::workspace::move_node(
            self.app.clone(),
            args.note_id,
            args.parent_id,
            args.index.unwrap_or(i64::MAX),
        )
        .await
        .map_err(mcp_error)?;
        json_result(json!({ "moved": true }))
    }

    #[tool(description = "Move a note into Novion's recoverable Trash.")]
    async fn delete_note(
        &self,
        Parameters(args): Parameters<NoteIdArgs>,
    ) -> Result<CallToolResult, McpError> {
        crate::workspace::delete_doc(self.app.clone(), args.note_id)
            .await
            .map_err(mcp_error)?;
        json_result(json!({ "trashed": true }))
    }

    #[tool(description = "Restore a trashed note to its previous folder when possible.")]
    async fn restore_note(
        &self,
        Parameters(args): Parameters<NoteIdArgs>,
    ) -> Result<CallToolResult, McpError> {
        load_note_node(&self.app, &args.note_id)
            .await
            .map_err(mcp_error)?;
        crate::workspace::restore_node(self.app.clone(), args.note_id)
            .await
            .map_err(mcp_error)?;
        json_result(json!({ "restored": true }))
    }
}

#[tool_handler]
impl ServerHandler for NovionMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_instructions(
                "Novion MCP provides local note listing, search, reading, creation, revision-checked updates, moving, trashing, and restoration. Note bodies use Markdown.".to_string(),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_loopback_origins() {
        for origin in [
            "http://localhost:3000/",
            "https://tauri.localhost/",
            "http://127.0.0.1:1420/",
            "http://[::1]:1420/",
            "tauri://localhost/",
        ] {
            assert!(is_loopback_origin(Url::parse(origin).unwrap()), "{origin}");
        }
    }

    #[test]
    fn rejects_remote_or_non_origin_urls() {
        for origin in [
            "https://example.com/",
            "http://localhost.attacker.test/",
            "ftp://localhost/",
            "http://127.0.0.1/path",
            "http://user@localhost/",
        ] {
            assert!(!is_loopback_origin(Url::parse(origin).unwrap()), "{origin}");
        }
    }
}
