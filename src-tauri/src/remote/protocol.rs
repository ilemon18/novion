use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::store::{ClientPermission, PairedDevice};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHost {
    pub host_id: String,
    pub host_name: String,
    pub address: String,
    pub port: u16,
    pub fingerprint: String,
    pub ca_pem: String,
    pub protocol: u32,
    pub workspace_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    pub running: bool,
    pub port: u16,
    pub addresses: Vec<String>,
    pub host_id: String,
    pub device_name: String,
    pub fingerprint: String,
    pub paired: Vec<PairedDevice>,
    pub pairing_code: Option<String>,
    pub pairing_expires_at: Option<u64>,
    pub discovery_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub host_id: String,
    pub host_name: String,
    pub host: String,
    pub port: u16,
    pub workspace_name: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub connected: bool,
    pub host_id: Option<String>,
    pub host_name: Option<String>,
    pub workspace_name: Option<String>,
    /// Base URL used for document image paths, e.g. http://127.0.0.1:123/s/secret
    pub root_path: Option<String>,
    pub asset_base: Option<String>,
    pub latency_ms: Option<u64>,
    pub protocol: Option<u32>,
    pub error: Option<String>,
    pub saved: Option<SavedConnection>,
}

impl RemoteStatus {
    pub fn disconnected(saved: Option<SavedConnection>, error: Option<String>) -> Self {
        Self {
            connected: false,
            host_id: None,
            host_name: None,
            workspace_name: None,
            root_path: None,
            asset_base: None,
            latency_ms: None,
            protocol: None,
            error,
            saved,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicInfo {
    pub protocol: u32,
    pub host_id: String,
    pub host_name: String,
    pub workspace_name: String,
    pub fingerprint: String,
    /// Sent so a manually entered address can pin the host after pairing.
    pub ca_pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    pub client_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub token: String,
    pub permission: ClientPermission,
    pub info: PublicInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    pub protocol: u32,
    pub host_id: String,
    pub host_name: String,
    pub workspace_name: String,
    pub permission: ClientPermission,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub name: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(data: Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(RpcError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}
