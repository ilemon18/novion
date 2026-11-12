//! Notion integration.
//!
//! Everything here runs in Rust on purpose: the webview never talks to the
//! network, and the integration token never leaves this process except in the
//! `Authorization` header. The token and the doc → page mapping live in
//! `<app config>/notion.json` with `0600` permissions.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::atomic::write_json_atomic;
use crate::error::{AppError, AppResult};

pub const NOTION_VERSION: &str = "2022-06-28";
const API_BASE: &str = "https://api.notion.com/v1";
const USER_AGENT: &str = concat!("Novion/", env!("CARGO_PKG_VERSION"));
/// Notion allows ~3 requests per second on average; stay a little below it.
const MIN_GAP: Duration = Duration::from_millis(360);
const MAX_ATTEMPTS: u32 = 4;

// --------------------------------------------------------------------- state

/// One synced document: the Notion page it became and the revision it holds.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PageLink {
    pub page_id: String,
    pub title: String,
    /// document `updatedAt` at the moment the page content was written
    pub doc_updated_at: u64,
    pub synced_at: u64,
    /// false while the page exists but its body was never fully written
    pub ok: bool,
    /// Hash of the local body at the last successful push *or* pull. Empty on
    /// links created before two-way sync existed; the next sync fills it in
    /// without touching either side.
    #[serde(default)]
    pub local_hash: String,
    /// Notion's `last_edited_time` for the page as of the last sync. Comparing
    /// it with the live value is how a remote edit is noticed without hashing
    /// the remote body on every run.
    #[serde(default)]
    pub remote_edited_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotionConfig {
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub workspace_name: String,
    pub bot_name: String,
    pub parent_page_id: String,
    pub parent_page_title: String,
    /// Novion doc id → Notion page
    pub pages: HashMap<String, PageLink>,
    /// Novion folder id → Notion page id
    pub folders: HashMap<String, String>,
    pub last_sync_at: u64,
}

impl Default for NotionConfig {
    fn default() -> Self {
        Self {
            version: 1,
            token: None,
            workspace_name: String::new(),
            bot_name: String::new(),
            parent_page_id: String::new(),
            parent_page_title: String::new(),
            pages: HashMap::new(),
            folders: HashMap::new(),
            last_sync_at: 0,
        }
    }
}

impl NotionConfig {
    pub fn token(&self) -> Option<&str> {
        self.token
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
    }
}

/// Cached view of `notion.json` so commands do not hit the disk on every call.
pub struct NotionState(pub Mutex<NotionConfig>);

pub fn config_file<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new("no_config_dir", format!("无法获取配置目录：{e}")))?;
    Ok(dir.join("notion.json"))
}

/// Never fails: a broken file simply means "not connected yet".
pub fn load<R: Runtime>(app: &AppHandle<R>) -> NotionConfig {
    let Ok(file) = config_file(app) else {
        return NotionConfig::default();
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return NotionConfig::default();
    };
    serde_json::from_slice::<NotionConfig>(&bytes).unwrap_or_default()
}

/// Persists the config atomically and keeps the token file private.
///
/// The `0600` mode only exists on Unix; Windows inherits the ACL of the user's
/// profile directory, which already keeps the file out of other accounts.
pub async fn save<R: Runtime>(app: &AppHandle<R>, cfg: &NotionConfig) -> AppResult<()> {
    let file = config_file(app)?;
    write_json_atomic(&file, cfg).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // ignore failures: the file is already written, a stricter umask is
        // the only thing that could make this fail
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Cheap copy of the cached config; callers never hold the lock across an await.
pub fn snapshot<R: Runtime>(app: &AppHandle<R>) -> NotionConfig {
    if let Some(state) = app.try_state::<NotionState>() {
        if let Ok(guard) = state.0.lock() {
            return guard.clone();
        }
    }
    load(app)
}

pub fn remember<R: Runtime>(app: &AppHandle<R>, cfg: &NotionConfig) {
    if let Some(state) = app.try_state::<NotionState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = cfg.clone();
        }
    }
}

// -------------------------------------------------------------------- client

/// Notion requires ~3 req/s; the slot is shared by every request of the app.
static LAST_REQUEST: Mutex<Option<Instant>> = Mutex::new(None);

async fn throttle() {
    let wait = {
        let mut guard = match LAST_REQUEST.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        let wait = match *guard {
            Some(prev) => (prev + MIN_GAP).saturating_duration_since(now),
            None => Duration::ZERO,
        };
        *guard = Some(now + wait);
        wait
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

pub struct NotionClient {
    http: reqwest::Client,
    token: String,
}

impl NotionClient {
    /// Client bound to the stored token.
    pub fn from_app<R: Runtime>(app: &AppHandle<R>) -> AppResult<Self> {
        let cfg = snapshot(app);
        let token = cfg.token().ok_or_else(|| {
            AppError::new(
                "notion_no_token",
                "还没有连接 Notion：请先填入 Integration Token 并点「验证并保存」",
            )
        })?;
        Self::with_token(token)
    }

    pub fn with_token(token: &str) -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|e| AppError::new("notion_network", format!("初始化网络客户端失败：{e}")))?;
        Ok(Self {
            http,
            token: token.trim().to_string(),
        })
    }

    fn base_headers(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        rb.header("Authorization", format!("Bearer {}", self.token))
            .header("Notion-Version", NOTION_VERSION)
            .header("Accept", "application/json")
    }

    async fn request(
        &self,
        method: reqwest::Method,
        url: String,
        body: Option<Value>,
    ) -> AppResult<Value> {
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            throttle().await;
            let mut rb = self.base_headers(self.http.request(method.clone(), &url));
            if let Some(body) = &body {
                rb = rb.json(body);
            }

            let response = match rb.send().await {
                Ok(response) => response,
                Err(err) => {
                    let retryable = err.is_timeout() || err.is_connect() || err.is_request();
                    if retryable && attempt < MAX_ATTEMPTS {
                        tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
                        continue;
                    }
                    return Err(network_error(&err));
                }
            };

            let status = response.status();
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            let text = response.text().await.unwrap_or_default();
            let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

            if status.is_success() {
                return Ok(parsed);
            }

            let retryable = status.as_u16() == 429 || status.is_server_error();
            if retryable && attempt < MAX_ATTEMPTS {
                let wait = retry_after
                    .map(Duration::from_secs)
                    .unwrap_or_else(|| Duration::from_millis(700 * attempt as u64));
                tokio::time::sleep(wait.min(Duration::from_secs(10))).await;
                continue;
            }
            return Err(map_api_error(status.as_u16(), &parsed, &text));
        }
    }

    pub async fn get(&self, path: &str) -> AppResult<Value> {
        self.request(reqwest::Method::GET, format!("{API_BASE}{path}"), None)
            .await
    }

    pub async fn post(&self, path: &str, body: Value) -> AppResult<Value> {
        self.request(reqwest::Method::POST, format!("{API_BASE}{path}"), Some(body))
            .await
    }

    pub async fn patch(&self, path: &str, body: Value) -> AppResult<Value> {
        self.request(reqwest::Method::PATCH, format!("{API_BASE}{path}"), Some(body))
            .await
    }

    pub async fn delete(&self, path: &str) -> AppResult<Value> {
        self.request(reqwest::Method::DELETE, format!("{API_BASE}{path}"), None)
            .await
    }

    /// Uploads raw bytes to a signed Notion upload URL (multipart, field `file`).
    pub async fn upload_bytes(
        &self,
        upload_url: &str,
        filename: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> AppResult<Value> {
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            throttle().await;
            let part = reqwest::multipart::Part::bytes(bytes.clone())
                .file_name(filename.to_string())
                .mime_str(mime)
                .map_err(|e| AppError::new("notion_upload", format!("图片类型不支持：{e}")))?;
            let form = reqwest::multipart::Form::new().part("file", part);
            let rb = self
                .base_headers(self.http.post(upload_url))
                .multipart(form);
            let response = match rb.send().await {
                Ok(response) => response,
                Err(err) => {
                    if (err.is_timeout() || err.is_connect()) && attempt < MAX_ATTEMPTS {
                        tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
                        continue;
                    }
                    return Err(network_error(&err));
                }
            };
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if status.is_success() {
                return Ok(parsed);
            }
            let retryable = status.as_u16() == 429 || status.is_server_error();
            if retryable && attempt < MAX_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(700 * attempt as u64)).await;
                continue;
            }
            return Err(map_api_error(status.as_u16(), &parsed, &text));
        }
    }
}

fn network_error(err: &reqwest::Error) -> AppError {
    let detail = if err.is_timeout() {
        "请求超时".to_string()
    } else if err.is_connect() {
        "无法连到 api.notion.com".to_string()
    } else {
        err.to_string()
    };
    AppError::new(
        "notion_network",
        format!("网络请求失败（{detail}）：请检查网络连接、代理或 VPN 设置后重试"),
    )
}

/// Turns a Notion API error into an actionable Chinese message.
fn map_api_error(status: u16, body: &Value, raw: &str) -> AppError {
    let code = body.get("code").and_then(Value::as_str).unwrap_or("");
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let detail = if message.is_empty() {
        raw.trim().chars().take(200).collect::<String>()
    } else {
        message.to_string()
    };

    match status {
        401 => AppError::new(
            "notion_unauthorized",
            "Token 无效或已被撤销：请到 Notion「设置 → 连接 / Connections」重新获取 Integration Token（Token 只显示一次）",
        ),
        403 => AppError::new(
            "notion_forbidden",
            format!(
                "这个集成没有权限访问目标页面（{code}）：请在 Notion 里打开目标页面 → 右上角「…」→「连接」→ 添加你的集成后重试"
            ),
        ),
        404 => AppError::new(
            "notion_not_found",
            "Notion 找不到目标页面或内容：链接里的 id 可能不对，或者该页面没有分享给你的集成",
        ),
        400 => AppError::new(
            "notion_validation",
            format!("Notion 拒绝了这次写入（{code}）：{detail}"),
        ),
        409 => AppError::new(
            "notion_conflict",
            format!("Notion 报告冲突（{code}）：{detail}"),
        ),
        429 => AppError::new(
            "notion_rate_limited",
            "Notion 接口限流了（429）：已自动重试仍失败，请等 30 秒再试",
        ),
        _ if status >= 500 => AppError::new(
            "notion_server",
            format!("Notion 服务端出错（{status}）：请稍后重试"),
        ),
        _ => AppError::new(
            "notion_api_error",
            format!("Notion 返回错误（{status} {code}）：{detail}"),
        ),
    }
}

// ---------------------------------------------------------------- page utils

fn is_hex32(text: &str) -> bool {
    text.len() == 32 && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Accepts a Notion page URL, a dashed UUID or a bare 32-char id.
pub fn extract_page_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    // drop query string / fragment
    let path = trimmed
        .split(['?', '#'])
        .next()
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    let segment = path.rsplit('/').next().unwrap_or(path);

    let bare: String = segment.chars().filter(|c| *c != '-').collect();
    if segmented_is_id(segment) {
        return Some(bare.to_ascii_lowercase());
    }
    // "My-Page-Title-<32 hex>": the last dash-separated chunk is the id
    if let Some(idx) = segment.rfind('-') {
        let tail = &segment[idx + 1..];
        if is_hex32(tail) {
            return Some(tail.to_ascii_lowercase());
        }
    }
    // "...Title1a2b3c4d5e6f7890abcd1234ef567890" — grab the trailing run
    if segment.len() > 32 {
        let tail = &segment[segment.len() - 32..];
        if is_hex32(tail) {
            return Some(tail.to_ascii_lowercase());
        }
    }
    None
}

/// True when the whole segment is an id, optionally with uuid dashes.
fn segmented_is_id(segment: &str) -> bool {
    let stripped: String = segment.chars().filter(|c| *c != '-').collect();
    if !is_hex32(&stripped) {
        return false;
    }
    // A dashed uuid has exactly the 8-4-4-4-12 shape; anything else that merely
    // strips down to 32 hex chars (a page title made of a-f/0-9) is treated as
    // an id too — it cannot be confused with a real title in practice.
    segment.chars().filter(|c| *c == '-').count() <= 4
}

fn rich_text_plain(items: &Value) -> String {
    items
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| item.get("plain_text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default()
}

/// Reads the title property (or a "title" / "name" field) of a page object.
pub fn page_title(page: &Value) -> String {
    if let Some(properties) = page.get("properties").and_then(Value::as_object) {
        for value in properties.values() {
            let kind = value.get("type").and_then(Value::as_str);
            if kind == Some("title") {
                if let Some(title) = value.get("title") {
                    let text = rich_text_plain(title);
                    if !text.trim().is_empty() {
                        return text;
                    }
                }
            }
        }
        for key in ["title", "Name", "名称", "标题"] {
            if let Some(value) = properties.get(key) {
                let text = rich_text_plain(value);
                if !text.trim().is_empty() {
                    return text;
                }
            }
        }
    }
    String::new()
}

pub fn page_url(page_id: &str) -> String {
    let compact: String = page_id.chars().filter(|c| *c != '-').collect();
    format!("https://www.notion.so/{compact}")
}

// ------------------------------------------------------------------- commands

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionStateInfo {
    pub connected: bool,
    /// only the last 4 characters ever leave Rust
    pub token_tail: String,
    pub workspace_name: String,
    pub bot_name: String,
    pub parent_page_id: String,
    pub parent_page_title: String,
    pub parent_url: String,
    pub synced_docs: usize,
    pub synced_folders: usize,
    pub last_sync_at: u64,
}

fn state_info(cfg: &NotionConfig) -> NotionStateInfo {
    let tail = cfg
        .token()
        .map(|t| {
            let chars: Vec<char> = t.chars().collect();
            let start = chars.len().saturating_sub(4);
            chars[start..].iter().collect::<String>()
        })
        .unwrap_or_default();
    NotionStateInfo {
        connected: cfg.token().is_some(),
        token_tail: tail,
        workspace_name: cfg.workspace_name.clone(),
        bot_name: cfg.bot_name.clone(),
        parent_page_id: cfg.parent_page_id.clone(),
        parent_page_title: cfg.parent_page_title.clone(),
        parent_url: if cfg.parent_page_id.is_empty() {
            String::new()
        } else {
            page_url(&cfg.parent_page_id)
        },
        synced_docs: cfg.pages.len(),
        synced_folders: cfg.folders.len(),
        last_sync_at: cfg.last_sync_at,
    }
}

#[tauri::command]
pub async fn notion_get_state<R: Runtime>(app: AppHandle<R>) -> AppResult<NotionStateInfo> {
    Ok(state_info(&snapshot(&app)))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionConnection {
    pub state: NotionStateInfo,
    pub workspace_name: String,
    pub bot_name: String,
}

#[tauri::command]
pub async fn notion_connect<R: Runtime>(
    app: AppHandle<R>,
    token: String,
) -> AppResult<NotionConnection> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::new(
            "notion_no_token",
            "请先填入 Integration Token（Notion 里的 ntn_... 或 secret_...）",
        ));
    }
    if token.chars().any(char::is_whitespace) || token.chars().count() < 20 {
        return Err(AppError::new(
            "notion_invalid_token",
            "Token 格式看起来不对：它应该是一段没有空格的长字符串，通常以 ntn_ 或 secret_ 开头",
        ));
    }

    let client = NotionClient::with_token(&token)?;
    let me = client.get("/users/me").await.map_err(|err| {
        if err.code == "notion_unauthorized" {
            AppError::new(
                "notion_unauthorized",
                "Token 无效：Notion 拒绝了这个 Token，请确认复制完整、且没有被重置或删除",
            )
        } else {
            err
        }
    })?;

    let bot_name = me
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Notion 集成")
        .to_string();
    let workspace_name = me
        .pointer("/bot/workspace_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let mut cfg = snapshot(&app);
    let switched_token = cfg.token() != Some(token.as_str());
    cfg.token = Some(token);
    cfg.bot_name = bot_name.clone();
    cfg.workspace_name = workspace_name.clone();
    if switched_token {
        // a new token may point at a totally different integration
        cfg.parent_page_id.clear();
        cfg.parent_page_title.clear();
        cfg.pages.clear();
        cfg.folders.clear();
    }
    save(&app, &cfg).await?;
    remember(&app, &cfg);

    Ok(NotionConnection {
        state: state_info(&cfg),
        workspace_name,
        bot_name,
    })
}

#[tauri::command]
pub async fn notion_disconnect<R: Runtime>(app: AppHandle<R>) -> AppResult<NotionStateInfo> {
    let cfg = NotionConfig::default();
    save(&app, &cfg).await?;
    remember(&app, &cfg);
    Ok(state_info(&cfg))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionParent {
    pub id: String,
    pub title: String,
    pub url: String,
    /// true when the target changed and the old page mapping was discarded
    pub reset: bool,
    pub state: NotionStateInfo,
}

#[tauri::command]
pub async fn notion_set_parent<R: Runtime>(
    app: AppHandle<R>,
    target: String,
) -> AppResult<NotionParent> {
    let id = extract_page_id(&target).ok_or_else(|| {
        AppError::new(
            "notion_bad_target",
            "没能从这段内容里认出页面 id：请粘贴 Notion 页面的完整链接，或 32 位的页面 id",
        )
    })?;

    let client = NotionClient::from_app(&app)?;
    let page = client.get(&format!("/pages/{id}")).await?;

    if page.get("object").and_then(Value::as_str) == Some("database") {
        return Err(AppError::new(
            "notion_bad_target",
            "这是一个数据库，不是页面：请选择普通页面作为同步目标",
        ));
    }
    if page.get("archived").and_then(Value::as_bool) == Some(true)
        || page.get("in_trash").and_then(Value::as_bool) == Some(true)
    {
        return Err(AppError::new(
            "notion_bad_target",
            "这个页面在回收站里：请先在 Notion 里恢复它，或换一个目标页面",
        ));
    }

    let title = {
        let title = page_title(&page);
        if title.trim().is_empty() {
            "（未命名页面）".to_string()
        } else {
            title
        }
    };

    let mut cfg = snapshot(&app);
    let reset = !cfg.parent_page_id.is_empty() && cfg.parent_page_id != id;
    if reset {
        cfg.pages.clear();
        cfg.folders.clear();
    }
    cfg.parent_page_id = id.clone();
    cfg.parent_page_title = title.clone();
    save(&app, &cfg).await?;
    remember(&app, &cfg);

    Ok(NotionParent {
        id: id.clone(),
        title,
        url: page_url(&id),
        reset,
        state: state_info(&cfg),
    })
}

/// Convenience for the sync module: the shared title property payload.
pub fn title_property(title: &str) -> Value {
    let content: String = title.trim().chars().take(200).collect();
    json!({
        "title": [{
            "type": "text",
            "text": { "content": if content.is_empty() { "Untitled".to_string() } else { content } }
        }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_notion_urls_and_ids() {
        let id = "1a2b3c4d5e6f7890abcd1234ef567890";
        let dashed = "1a2b3c4d-5e6f-7890-abcd-1234ef567890";
        assert_eq!(extract_page_id(id).as_deref(), Some(id));
        assert_eq!(extract_page_id(dashed).as_deref(), Some(id));
        assert_eq!(
            extract_page_id("https://www.notion.so/My-Page-1a2b3c4d5e6f7890abcd1234ef567890?pvs=4")
                .as_deref(),
            Some(id)
        );
        assert_eq!(
            extract_page_id("  https://notion.so/1a2b3c4d5e6f7890abcd1234ef567890/").as_deref(),
            Some(id)
        );
        assert_eq!(extract_page_id("https://www.notion.so/settings"), None);
        assert_eq!(extract_page_id(""), None);
    }

    #[test]
    fn reads_the_title_property() {
        let page = json!({
            "object": "page",
            "properties": {
                "Name": { "id": "title", "type": "title", "title": [{ "plain_text": "我的页面" }] }
            }
        });
        assert_eq!(page_title(&page), "我的页面");
    }
}
