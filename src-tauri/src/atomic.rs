use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};

/// Windows refuses `MoveFileEx` while another handle (Defender, the search
/// indexer, a concurrent read of the same file) is open, and the app reads
/// documents and `workspace.json` from other tasks while saving. Retrying a few
/// times with a short backoff turns that race into a slow save instead of a
/// failed one. macOS and Linux always succeed on the first attempt, so the loop
/// costs nothing there.
const RENAME_ATTEMPTS: u32 = 5;
const RENAME_BACKOFF_MS: u64 = 20;

async fn replace_file(tmp: &Path, path: &Path) -> std::io::Result<()> {
    let mut delay = RENAME_BACKOFF_MS;
    for attempt in 1..=RENAME_ATTEMPTS {
        match tokio::fs::rename(tmp, path).await {
            Ok(()) => return Ok(()),
            Err(e) if attempt == RENAME_ATTEMPTS => return Err(e),
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                delay *= 2;
            }
        }
    }
    unreachable!("the loop returns on the last attempt")
}

/// Write `bytes` to `path` atomically: temp file -> fsync -> rename.
/// A crash can therefore never leave a half-written workspace or document.
pub async fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| AppError::io("创建目录失败", e))?;
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp = path.with_file_name(format!(
        ".{}.tmp-{}",
        file_name,
        uuid::Uuid::new_v4().simple()
    ));

    let write_result = async {
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| AppError::io("创建临时文件失败", e))?;
        file.write_all(bytes)
            .await
            .map_err(|e| AppError::io("写入临时文件失败", e))?;
        file.flush()
            .await
            .map_err(|e| AppError::io("刷新临时文件失败", e))?;
        file.sync_all()
            .await
            .map_err(|e| AppError::io("同步临时文件失败", e))?;
        drop(file);
        replace_file(&tmp, path)
            .await
            .map_err(|e| AppError::io("替换目标文件失败", e))
    }
    .await;

    if write_result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    write_result
}

pub async fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| AppError::json("序列化失败", e))?;
    write_atomic(path, &bytes).await
}

pub async fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> AppResult<T> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| AppError::io(&format!("读取 {} 失败", path.display()), e))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| AppError::json(&format!("解析 {} 失败", path.display()), e))
}