use std::io::Write;

use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, AppResult};

/// Rotate the client log at 256KB so a render loop cannot fill the disk.
const MAX_BYTES: u64 = 256 * 1024;

/// Appends a message from the webview to `client-errors.log` next to
/// `config.json`, and returns the path.
///
/// A desktop app that fails in the frontend shows a blank window with no way to
/// read the console; this is the escape hatch that makes such a failure
/// diagnosable (and the error boundary in the UI points at the file).
#[tauri::command]
pub async fn report_client_error<R: Runtime>(
    app: AppHandle<R>,
    message: String,
) -> AppResult<String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new("no_config_dir", format!("无法获取配置目录：{e}")))?;
    std::fs::create_dir_all(&dir).map_err(|e| AppError::io("创建日志目录失败", e))?;

    let file = dir.join("client-errors.log");
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.len() > MAX_BYTES {
            let _ = std::fs::remove_file(&file);
        }
    }

    let line = format!(
        "[{}] {}\n",
        crate::models::now_ms(),
        message.trim().chars().take(20_000).collect::<String>()
    );
    let mut handle = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| AppError::io("写入日志失败", e))?;
    handle
        .write_all(line.as_bytes())
        .map_err(|e| AppError::io("写入日志失败", e))?;

    Ok(file.to_string_lossy().to_string())
}
