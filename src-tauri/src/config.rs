use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};

/// Where the workspace lives. The choice is stored in the app config dir, not
/// inside the workspace itself (the workspace path is what it decides).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    Local,
    Icloud,
}

impl Default for Storage {
    fn default() -> Self {
        Storage::Local
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub storage: Storage,
    /// how many rolling body snapshots one document keeps
    #[serde(default = "default_history_limit")]
    pub history_limit: usize,
    /// when false, saves stop writing snapshots (existing ones are kept)
    #[serde(default = "default_true")]
    pub history_enabled: bool,
    /// Port used by the optional local MCP server. The listener itself never
    /// starts automatically, even when a port has been saved here.
    #[serde(default = "default_mcp_port")]
    pub mcp_port: u16,
    /// Local MCP bearer token. It is created only when token authentication is
    /// enabled, and is kept when authentication is turned off so saved client
    /// configuration remains stable if it is enabled again.
    #[serde(default)]
    pub mcp_token: String,
    /// When true, MCP requests must include the configured bearer token.
    /// Authentication is opt-in and off by default.
    #[serde(default)]
    pub mcp_require_token: bool,
}

fn default_true() -> bool {
    true
}

fn default_version() -> u32 {
    1
}

pub const MCP_PORT_DEFAULT: u16 = 39_261;
pub const MCP_PORT_MIN: u16 = 1_024;

fn default_mcp_port() -> u16 {
    MCP_PORT_DEFAULT
}

/// Ten snapshots (~50 minutes of editing back then) is what a notes app needs;
/// the settings page can raise it, twenty is the ceiling that keeps
/// `history/` small even for someone who edits all day.
pub const HISTORY_LIMIT_MIN: usize = 5;
pub const HISTORY_LIMIT_MAX: usize = 20;
pub const HISTORY_LIMIT_DEFAULT: usize = 10;

fn default_history_limit() -> usize {
    HISTORY_LIMIT_DEFAULT
}

pub fn clamp_history_limit(value: usize) -> usize {
    value.clamp(HISTORY_LIMIT_MIN, HISTORY_LIMIT_MAX)
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            storage: Storage::Local,
            history_limit: HISTORY_LIMIT_DEFAULT,
            history_enabled: true,
            mcp_port: MCP_PORT_DEFAULT,
            mcp_token: String::new(),
            mcp_require_token: false,
        }
    }
}

/// Cached config so every command can resolve the workspace root cheaply.
pub struct ConfigState(pub Mutex<Config>);

pub fn config_file<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new("no_config_dir", format!("无法获取配置目录：{e}")))?;
    Ok(dir.join("config.json"))
}

/// Never fails: a missing or broken file means "defaults" so the app still opens.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Config {
    let Ok(file) = config_file(app) else {
        return Config::default();
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return Config::default();
    };
    let mut config = serde_json::from_slice::<Config>(&bytes).unwrap_or_default();
    if config.mcp_port < MCP_PORT_MIN {
        config.mcp_port = MCP_PORT_DEFAULT;
    }
    config
}

/// Current config, from the cache when the app has initialized it.
pub fn get<R: Runtime>(app: &AppHandle<R>) -> Config {
    app.try_state::<ConfigState>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.clone()))
        .unwrap_or_else(|| load(app))
}

pub fn current<R: Runtime>(app: &AppHandle<R>) -> Storage {
    if let Some(state) = app.try_state::<ConfigState>() {
        if let Ok(cfg) = state.0.lock() {
            return cfg.storage;
        }
    }
    load(app).storage
}

/// How many snapshots a document keeps, already clamped to the allowed range.
pub fn history_limit<R: Runtime>(app: &AppHandle<R>) -> usize {
    if let Some(state) = app.try_state::<ConfigState>() {
        if let Ok(cfg) = state.0.lock() {
            return clamp_history_limit(cfg.history_limit);
        }
    }
    clamp_history_limit(load(app).history_limit)
}

/// Whether automatic version snapshots are written on save.
pub fn history_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    if let Some(state) = app.try_state::<ConfigState>() {
        if let Ok(cfg) = state.0.lock() {
            return cfg.history_enabled;
        }
    }
    load(app).history_enabled
}

/// Applies `mutate` to the cached config and rewrites the file; the file stays
/// the source of truth across launches.
fn update<R: Runtime>(app: &AppHandle<R>, mutate: impl FnOnce(&mut Config)) -> AppResult<Config> {
    let mut cfg = app
        .try_state::<ConfigState>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.clone()))
        .unwrap_or_else(|| load(app));
    mutate(&mut cfg);

    let file = config_file(app)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::io(&format!("创建配置目录 {} 失败", dir.display()), e))?;
    }
    let bytes = serde_json::to_vec_pretty(&cfg).map_err(|e| AppError::json("序列化配置失败", e))?;
    std::fs::write(&file, &bytes).map_err(|e| AppError::io("写入配置失败", e))?;

    if let Some(state) = app.try_state::<ConfigState>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = cfg.clone();
        }
    }
    Ok(cfg)
}

/// Persist the storage choice; the file is the source of truth across launches.
pub fn set<R: Runtime>(app: &AppHandle<R>, storage: Storage) -> AppResult<Config> {
    update(app, |cfg| cfg.storage = storage)
}

/// Ensure a bearer credential exists before token authentication is enabled or
/// the HTTP service starts with it enabled. Existing config files gain this
/// field lazily.
pub fn ensure_mcp_token<R: Runtime>(app: &AppHandle<R>) -> AppResult<Config> {
    let current = get(app);
    if !current.mcp_token.is_empty() {
        return Ok(current);
    }
    update(app, |cfg| cfg.mcp_token = uuid::Uuid::new_v4().to_string())
}

fn apply_mcp_require_token(cfg: &mut Config, required: bool) {
    cfg.mcp_require_token = required;
    if required && cfg.mcp_token.is_empty() {
        cfg.mcp_token = uuid::Uuid::new_v4().to_string();
    }
}

/// Turns bearer-token authentication on or off. Enabling it creates a token
/// when one does not exist yet; disabling it keeps the token for later reuse.
pub fn set_mcp_require_token<R: Runtime>(app: &AppHandle<R>, required: bool) -> AppResult<Config> {
    update(app, |cfg| apply_mcp_require_token(cfg, required))
}

pub fn set_mcp_port<R: Runtime>(app: &AppHandle<R>, port: u16) -> AppResult<Config> {
    if !(MCP_PORT_MIN..=u16::MAX).contains(&port) {
        return Err(AppError::invalid(format!(
            "MCP 端口必须在 {MCP_PORT_MIN}–{} 之间",
            u16::MAX
        )));
    }
    update(app, |cfg| cfg.mcp_port = port)
}

pub fn rotate_mcp_token<R: Runtime>(app: &AppHandle<R>) -> AppResult<Config> {
    update(app, |cfg| cfg.mcp_token = uuid::Uuid::new_v4().to_string())
}

#[tauri::command]
pub fn get_history_limit<R: Runtime>(app: AppHandle<R>) -> usize {
    history_limit(&app)
}

#[tauri::command]
pub fn get_history_enabled<R: Runtime>(app: AppHandle<R>) -> bool {
    history_enabled(&app)
}

/// Turning the history off keeps every snapshot already on disk; only new
/// writes stop. Turning it back on resumes from the newest snapshot.
#[tauri::command]
pub fn set_history_enabled<R: Runtime>(app: AppHandle<R>, enabled: bool) -> AppResult<bool> {
    update(&app, |cfg| cfg.history_enabled = enabled)?;
    Ok(enabled)
}

/// Stores the new limit and immediately trims every document's history, so the
/// retention the user just picked is true right away and not only after the
/// next autosave of each document.
#[tauri::command]
pub async fn set_history_limit<R: Runtime>(app: AppHandle<R>, limit: usize) -> AppResult<usize> {
    let limit = clamp_history_limit(limit);
    update(&app, |cfg| cfg.history_limit = limit)?;

    if let Ok(root) = crate::paths::workspace_root(&app) {
        crate::history::trim_all(&crate::paths::Paths::new(root), limit).await;
    }
    Ok(limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_without_history_flag_defaults_to_enabled() {
        // an older config.json has no `historyEnabled` key at all
        let cfg: Config =
            serde_json::from_str(r#"{"version":1,"storage":"local","historyLimit":10}"#)
                .expect("old config must still parse");
        assert!(cfg.history_enabled);
        assert_eq!(cfg.history_limit, 10);
        assert_eq!(cfg.mcp_port, MCP_PORT_DEFAULT);
        assert!(cfg.mcp_token.is_empty());
        assert!(!cfg.mcp_require_token);
    }

    #[test]
    fn mcp_auth_flag_defaults_to_off_for_older_configs() {
        // config files written before optional MCP auth have no flag at all
        let cfg: Config = serde_json::from_str(r#"{"mcpToken":"existing"}"#).unwrap();
        assert!(!cfg.mcp_require_token);
        assert_eq!(cfg.mcp_token, "existing");
    }

    #[test]
    fn mcp_auth_flag_round_trips_through_camel_case() {
        let cfg: Config = serde_json::from_str(r#"{"mcpRequireToken":true}"#).unwrap();
        assert!(cfg.mcp_require_token);
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"mcpRequireToken\":true"));
    }

    #[test]
    fn enabling_mcp_auth_creates_a_token_once_and_disabling_keeps_it() {
        let mut cfg = Config::default();
        apply_mcp_require_token(&mut cfg, true);
        let token = cfg.mcp_token.clone();
        assert!(cfg.mcp_require_token);
        assert!(!token.is_empty());

        apply_mcp_require_token(&mut cfg, false);
        assert!(!cfg.mcp_require_token);
        assert_eq!(cfg.mcp_token, token);

        apply_mcp_require_token(&mut cfg, true);
        assert_eq!(cfg.mcp_token, token);
    }

    #[test]
    fn history_flag_round_trips_through_camel_case() {
        let cfg: Config = serde_json::from_str(r#"{"historyEnabled":false}"#).unwrap();
        assert!(!cfg.history_enabled);
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"historyEnabled\":false"));
    }
}
