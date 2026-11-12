use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};

/// Schemes the editor is allowed to hand over to the system.
const ALLOWED_SCHEMES: [&str; 3] = ["http://", "https://", "mailto:"];

/// Opens an external URL in the user's default browser (or mail client).
///
/// The webview must never navigate itself — doing so replaces the whole app
/// with a web page. Anchors in the editor are therefore intercepted in the
/// frontend and end up here. `tauri-plugin-opener` maps the call to the
/// platform's own launcher (`open` on macOS, `ShellExecute` on Windows).
#[tauri::command]
pub async fn open_url<R: Runtime>(app: AppHandle<R>, url: String) -> AppResult<()> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid("链接为空"));
    }
    let lower = trimmed.to_ascii_lowercase();
    if !ALLOWED_SCHEMES
        .iter()
        .any(|scheme| lower.starts_with(scheme))
    {
        return Err(AppError::invalid("只支持 http / https / mailto 链接"));
    }

    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| AppError::wrap("打开浏览器失败", e))?;
    Ok(())
}