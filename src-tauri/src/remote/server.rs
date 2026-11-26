use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Extension, Path, Request, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::{AppHandle, Wry};

use crate::error::{AppError, AppResult};
use crate::paths::{workspace_root, Paths};

use super::protocol::{
    HelloResponse, PairRequest, PairResponse, PublicInfo, RpcRequest, RpcResponse,
};
use super::store::ClientPermission;
use super::RemoteState;

const MAX_RPC_BODY: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct ServerContext {
    pub app: AppHandle<Wry>,
    pub remote: RemoteState,
    pub ca_pem: String,
    pub ca_fingerprint: String,
}

#[derive(Clone)]
struct AuthDevice {
    permission: ClientPermission,
}

fn json_response(status: StatusCode, body: RpcResponse) -> Response {
    (status, Json(body)).into_response()
}

pub fn router(ctx: Arc<ServerContext>) -> Router {
    let protected = Router::new()
        .route("/v1/hello", get(hello))
        .route("/v1/rpc", post(rpc))
        .route("/v1/asset/{*rel}", get(asset))
        .route_layer(middleware::from_fn_with_state(ctx.clone(), authorize));
    Router::new()
        .route("/v1/info", get(info))
        .route("/v1/pair", post(pair))
        .merge(protected)
        .layer(DefaultBodyLimit::max(MAX_RPC_BODY))
        .with_state(ctx)
}

async fn info(State(ctx): State<Arc<ServerContext>>) -> Json<PublicInfo> {
    Json(public_info(&ctx))
}

fn public_info(ctx: &ServerContext) -> PublicInfo {
    let sharing = ctx.remote.sharing();
    PublicInfo {
        protocol: super::store::PROTOCOL_VERSION,
        host_id: sharing.host_id,
        host_name: sharing.device_name,
        workspace_name: workspace_name(&ctx.app),
        fingerprint: ctx.ca_fingerprint.clone(),
        ca_pem: ctx.ca_pem.clone(),
    }
}

pub fn workspace_name(app: &AppHandle<Wry>) -> String {
    workspace_root(app)
        .ok()
        .and_then(|root| {
            root.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Novion".to_string())
}

async fn pair(State(ctx): State<Arc<ServerContext>>, Json(request): Json<PairRequest>) -> Response {
    if !ctx.remote.consume_pairing_code(&request.code).await {
        return (
            StatusCode::UNAUTHORIZED,
            Json(RpcResponse::error(
                "pairing_rejected",
                "配对码错误、已过期或尝试次数过多。",
            )),
        )
            .into_response();
    }
    let (token, permission) = match ctx.remote.issue_token(&request.client_name).await {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(RpcResponse::error(error.code, error.message)),
            )
                .into_response()
        }
    };
    let _ = ctx.remote.save_sharing(&ctx.app).await;
    (
        StatusCode::OK,
        Json(PairResponse {
            token,
            permission,
            info: public_info(&ctx),
        }),
    )
        .into_response()
}

async fn authorize(
    State(ctx): State<Arc<ServerContext>>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    let Some(device) = ctx.remote.authenticate(supplied).await else {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            Json(RpcResponse::error(
                "remote_unauthorized",
                "主机未授权此设备，请重新配对。",
            )),
        )
            .into_response();
    };
    request.extensions_mut().insert(AuthDevice {
        permission: device.permission,
    });
    next.run(request).await
}

async fn hello(
    State(ctx): State<Arc<ServerContext>>,
    Extension(device): Extension<AuthDevice>,
) -> Json<HelloResponse> {
    let sharing = ctx.remote.sharing();
    Json(HelloResponse {
        protocol: super::store::PROTOCOL_VERSION,
        host_id: sharing.host_id,
        host_name: sharing.device_name,
        workspace_name: workspace_name(&ctx.app),
        permission: device.permission,
    })
}

async fn rpc(
    State(ctx): State<Arc<ServerContext>>,
    Extension(device): Extension<AuthDevice>,
    Json(request): Json<RpcRequest>,
) -> Response {
    if device.permission == ClientPermission::ReadOnly && is_mutating(&request.name) {
        return json_response(
            StatusCode::FORBIDDEN,
            RpcResponse::error("remote_read_only", "此设备只有只读权限。"),
        );
    }
    let result = tokio::time::timeout(
        Duration::from_secs(120),
        dispatch(&ctx.app, &request.name, &request.args),
    )
    .await;
    match result {
        Ok(Ok(value)) => json_response(StatusCode::OK, RpcResponse::ok(value)),
        Ok(Err(error)) => json_response(
            StatusCode::OK,
            RpcResponse::error(error.code, error.message),
        ),
        Err(_) => json_response(
            StatusCode::GATEWAY_TIMEOUT,
            RpcResponse::error("remote_timeout", "主机执行操作超时。"),
        ),
    }
}

async fn asset(State(ctx): State<Arc<ServerContext>>, Path(rel): Path<String>) -> Response {
    if !rel.starts_with("assets/") || rel.contains("..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(root) = workspace_root(&ctx.app) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let paths = Paths::new(root);
    let Ok(file) = paths.asset_file(&rel) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match tokio::fs::read(&file).await {
        Ok(bytes) => {
            let content_type = mime_guess::from_path(&file)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
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
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            StatusCode::NOT_FOUND.into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

fn is_mutating(name: &str) -> bool {
    !matches!(
        name,
        "ensure_workspace"
            | "read_doc"
            | "doc_stamp"
            | "workspace_stamp"
            | "search_docs"
            | "backlinks_doc"
            | "list_dir"
            | "list_doc_versions"
            | "read_doc_version"
    )
}

fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> AppResult<T> {
    let value = args.get(key).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|e| AppError::invalid(format!("参数 {key} 无效：{e}")))
}

async fn dispatch(app: &AppHandle<Wry>, name: &str, args: &Value) -> AppResult<Value> {
    macro_rules! value {
        ($result:expr) => {
            serde_json::to_value($result).map_err(|e| AppError::json("序列化远程结果失败", e))
        };
    }
    match name {
        "ensure_workspace" => {
            value!(crate::workspace::ensure_workspace(app.clone(), arg(args, "language")?).await?)
        }
        "create_folder" => value!(
            crate::workspace::create_folder(
                app.clone(),
                arg(args, "parentId")?,
                arg(args, "name")?,
            )
            .await?
        ),
        "rename_folder" => value!(
            crate::workspace::rename_folder(app.clone(), arg(args, "id")?, arg(args, "name")?,)
                .await?
        ),
        "delete_folder" => {
            value!(crate::workspace::delete_folder(app.clone(), arg(args, "id")?).await?)
        }
        "create_doc" => value!(
            crate::workspace::create_doc(app.clone(), arg(args, "parentId")?, arg(args, "title")?,)
                .await?
        ),
        "rename_doc" => value!(
            crate::workspace::rename_doc(app.clone(), arg(args, "id")?, arg(args, "title")?)
                .await?
        ),
        "delete_doc" => {
            value!(crate::workspace::delete_doc(app.clone(), arg(args, "id")?).await?)
        }
        "restore_node" => {
            value!(crate::workspace::restore_node(app.clone(), arg(args, "id")?).await?)
        }
        "set_completed" => value!(
            crate::workspace::set_completed(
                app.clone(),
                arg(args, "id")?,
                arg(args, "completed")?,
            )
            .await?
        ),
        "set_pinned" => value!(
            crate::workspace::set_pinned(app.clone(), arg(args, "id")?, arg(args, "pinned")?)
                .await?
        ),
        "move_node" => value!(
            crate::workspace::move_node(
                app.clone(),
                arg(args, "id")?,
                arg(args, "parentId")?,
                arg(args, "index")?,
            )
            .await?
        ),
        "restore_workspace" => {
            value!(crate::workspace::restore_workspace(app.clone(), arg(args, "workspace")?).await?)
        }
        "read_doc" => value!(crate::docs::read_doc(app.clone(), arg(args, "id")?).await?),
        "save_doc" => value!(
            crate::docs::save_doc(
                app.clone(),
                arg(args, "id")?,
                arg(args, "title")?,
                arg(args, "content")?,
                arg(args, "baseMtimeMs")?,
                arg(args, "force")?,
            )
            .await?
        ),
        "duplicate_doc" => value!(
            crate::docs::duplicate_doc(
                app.clone(),
                arg(args, "sourceId")?,
                arg(args, "title")?,
                arg(args, "content")?,
            )
            .await?
        ),
        "doc_stamp" => value!(crate::docs::doc_stamp(app.clone(), arg(args, "id")?).await?),
        "workspace_stamp" => value!(crate::docs::workspace_stamp(app.clone()).await?),
        "search_docs" => {
            value!(crate::search::search_docs(app.clone(), arg(args, "query")?).await?)
        }
        "backlinks_doc" => {
            value!(crate::links::backlinks_doc(app.clone(), arg(args, "id")?).await?)
        }
        "save_asset" => value!(
            crate::assets::save_asset(
                app.clone(),
                arg(args, "nameHint")?,
                arg(args, "dataBase64")?,
            )
            .await?
        ),
        "delete_asset" => {
            value!(crate::assets::delete_asset(app.clone(), arg(args, "rel")?).await?)
        }
        "list_dir" => value!(crate::assets::list_dir(app.clone(), arg(args, "rel")?).await?),
        "list_doc_versions" => {
            value!(crate::history::list_doc_versions(app.clone(), arg(args, "id")?).await?)
        }
        "read_doc_version" => value!(
            crate::history::read_doc_version(app.clone(), arg(args, "id")?, arg(args, "ts")?)
                .await?
        ),
        "create_doc_version" => {
            value!(crate::history::create_doc_version(app.clone(), arg(args, "id")?).await?)
        }
        "restore_doc_version" => value!(
            crate::history::restore_doc_version(app.clone(), arg(args, "id")?, arg(args, "ts")?)
                .await?
        ),
        _ => Err(AppError::new(
            "remote_unsupported",
            format!("此操作不允许通过局域网共享执行：{name}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutating_commands_are_classified() {
        assert!(is_mutating("save_doc"));
        assert!(is_mutating("delete_folder"));
        assert!(is_mutating("save_asset"));
        assert!(!is_mutating("read_doc"));
        assert!(!is_mutating("search_docs"));
    }
}
