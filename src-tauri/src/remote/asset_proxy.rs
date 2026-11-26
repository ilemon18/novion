use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use subtle::ConstantTimeEq;
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, AppResult};

#[derive(Clone)]
struct ProxyState {
    secret: String,
    upstream: String,
    token: String,
    client: reqwest::Client,
}

pub struct AssetProxy {
    pub base: String,
    cancellation: CancellationToken,
    task: JoinHandle<()>,
}

impl AssetProxy {
    pub fn stop(self) {
        self.cancellation.cancel();
        self.task.abort();
    }
}

impl Drop for AssetProxy {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.task.abort();
    }
}

async fn asset(
    State(state): State<Arc<ProxyState>>,
    Path((secret, rel)): Path<(String, String)>,
) -> Response {
    let supplied = secret.as_bytes();
    let expected = state.secret.as_bytes();
    if supplied.len() != expected.len() || !bool::from(supplied.ct_eq(expected)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !rel.starts_with("assets/") || rel.contains("..") {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let url = upstream_asset_url(&state.upstream, &rel);
    let request = state
        .client
        .get(url)
        .bearer_auth(&state.token)
        .timeout(Duration::from_secs(30));
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
    };
    let status = response.status();
    if !status.is_success() {
        return StatusCode::from_u16(status.as_u16())
            .unwrap_or(StatusCode::BAD_GATEWAY)
            .into_response();
    }
    let content_type = mime_guess::from_path(&rel)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    match response.bytes().await {
        Ok(bytes) => {
            let mut response = (StatusCode::OK, Bytes::from(bytes)).into_response();
            if let Ok(value) = HeaderValue::from_str(&content_type) {
                response.headers_mut().insert(header::CONTENT_TYPE, value);
            }
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=300"),
            );
            response
        }
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

fn upstream_asset_url(upstream: &str, rel: &str) -> String {
    format!("{}/v1/asset/{rel}", upstream.trim_end_matches('/'))
}

pub async fn start(upstream: String, token: String, ca_pem: String) -> AppResult<AssetProxy> {
    let upstream = upstream.trim_end_matches('/').to_string();
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::io("启动本机图片代理失败", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::io("读取图片代理地址失败", e))?
        .port();
    let secret = uuid::Uuid::new_v4().simple().to_string();
    let ca = reqwest::Certificate::from_pem(ca_pem.as_bytes())
        .map_err(|e| AppError::wrap("读取主机证书失败", e))?;
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .add_root_certificate(ca)
        .danger_accept_invalid_hostnames(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::wrap("创建图片代理客户端失败", e))?;
    let state = Arc::new(ProxyState {
        secret: secret.clone(),
        upstream,
        token,
        client,
    });
    let app = Router::new()
        .route("/s/{secret}/assets/{*rel}", get(asset))
        .with_state(state);
    let cancellation = CancellationToken::new();
    let shutdown = cancellation.clone();
    let task = tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, app)
            .with_graceful_shutdown(async move { shutdown.cancelled().await })
            .await
        {
            eprintln!("[novion] asset proxy stopped: {error}");
        }
    });
    Ok(AssetProxy {
        base: format!("http://127.0.0.1:{port}/s/{secret}"),
        cancellation,
        task,
    })
}

#[cfg(test)]
mod tests {
    use super::upstream_asset_url;

    #[test]
    fn upstream_asset_path_never_doubles_the_slash() {
        assert_eq!(
            upstream_asset_url("https://host:39262/", "assets/x.png"),
            "https://host:39262/v1/asset/assets/x.png"
        );
    }
}
