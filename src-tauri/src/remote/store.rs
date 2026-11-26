use std::path::{Path, PathBuf};

use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Wry};

use crate::atomic::{write_atomic, write_json_atomic};
use crate::error::{AppError, AppResult};

/// Bump this when a change makes an old client unsafe or incompatible.
pub const PROTOCOL_VERSION: u32 = 1;
pub const SHARE_PORT_DEFAULT: u16 = 39_262;
pub const SHARE_PORT_MIN: u16 = 1_024;
pub const PAIRING_TTL_MS: u64 = 2 * 60 * 1000;
pub const PAIRING_MAX_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientPermission {
    ReadOnly,
    ReadWrite,
}

impl Default for ClientPermission {
    fn default() -> Self {
        Self::ReadWrite
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    /// SHA-256 of the bearer token. The token itself is only returned once.
    pub token_hash: String,
    pub permission: ClientPermission,
    pub created_at: u64,
    pub last_seen_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharingConfig {
    pub host_id: String,
    pub device_name: String,
    pub port: u16,
    #[serde(default)]
    pub paired: Vec<PairedDevice>,
}

impl Default for SharingConfig {
    fn default() -> Self {
        Self {
            host_id: uuid::Uuid::new_v4().simple().to_string()[..16].to_string(),
            device_name: default_device_name(),
            port: SHARE_PORT_DEFAULT,
            paired: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTarget {
    pub host: String,
    pub port: u16,
    pub host_id: String,
    pub host_name: String,
    pub workspace_name: String,
    /// PEM of the local CA the host presented during pairing.
    pub ca_pem: String,
    pub ca_fingerprint: String,
    /// Bearer token. Kept in the app config and never sent to the webview.
    pub token: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientPrefs {
    #[serde(default)]
    pub target: Option<SavedTarget>,
}

pub fn default_device_name() -> String {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    if user.trim().is_empty() {
        "Novion".to_string()
    } else {
        format!("{user}'s Novion")
    }
}

fn config_dir(app: &AppHandle<Wry>) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::new("no_config_dir", format!("无法获取配置目录：{e}")))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::io(&format!("创建配置目录 {} 失败", dir.display()), e))?;
    Ok(dir)
}

pub fn sharing_file(app: &AppHandle<Wry>) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join("sharing.json"))
}

pub fn client_file(app: &AppHandle<Wry>) -> AppResult<PathBuf> {
    Ok(config_dir(app)?.join("remote.json"))
}

fn identity_dir(app: &AppHandle<Wry>) -> AppResult<PathBuf> {
    let dir = config_dir(app)?.join("remote-identity");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::io(&format!("创建身份目录 {} 失败", dir.display()), e))?;
    Ok(dir)
}

/// Synchronous, best-effort read used while Tauri sets up managed state.
pub fn load_sharing_blocking(app: &AppHandle<Wry>) -> SharingConfig {
    let Ok(file) = sharing_file(app) else {
        return SharingConfig::default();
    };
    let Ok(bytes) = std::fs::read(file) else {
        return SharingConfig::default();
    };
    let mut cfg = serde_json::from_slice::<SharingConfig>(&bytes).unwrap_or_default();
    if cfg.host_id.is_empty() {
        cfg.host_id = SharingConfig::default().host_id;
    }
    if cfg.device_name.trim().is_empty() {
        cfg.device_name = default_device_name();
    }
    if cfg.port < SHARE_PORT_MIN {
        cfg.port = SHARE_PORT_DEFAULT;
    }
    cfg
}

pub fn load_client_blocking(app: &AppHandle<Wry>) -> ClientPrefs {
    let Ok(file) = client_file(app) else {
        return ClientPrefs::default();
    };
    let Ok(bytes) = std::fs::read(file) else {
        return ClientPrefs::default();
    };
    serde_json::from_slice::<ClientPrefs>(&bytes).unwrap_or_default()
}

pub async fn save_sharing(app: &AppHandle<Wry>, cfg: &SharingConfig) -> AppResult<()> {
    let file = sharing_file(app)?;
    write_json_atomic(&file, cfg).await?;
    set_private_permissions(&file);
    Ok(())
}

pub async fn save_client(app: &AppHandle<Wry>, prefs: &ClientPrefs) -> AppResult<()> {
    let file = client_file(app)?;
    write_json_atomic(&file, prefs).await?;
    set_private_permissions(&file);
    Ok(())
}

fn set_private_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn fingerprint_of_pem(pem: &str) -> AppResult<String> {
    let der = pem_body(pem).ok_or_else(|| AppError::invalid("证书 PEM 格式无效"))?;
    Ok(fingerprint_of_der(&der))
}

pub fn fingerprint_of_der(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn pem_body(pem: &str) -> Option<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    STANDARD.decode(body.trim()).ok()
}

pub struct Identity {
    pub ca_pem: String,
    pub ca_fingerprint: String,
    pub cert_path: PathBuf,
    pub key_path: PathBuf,
}

struct IdentityMaterial {
    ca_pem: String,
    ca_fingerprint: String,
    cert_pem: String,
    key_pem: String,
}

fn identity_material() -> AppResult<IdentityMaterial> {
    let ca_key = KeyPair::generate().map_err(|e| AppError::wrap("生成局域网共享证书失败", e))?;
    let mut ca_params = CertificateParams::new(vec!["Novion Local CA".to_string()])
        .map_err(|e| AppError::wrap("创建局域网共享证书失败", e))?;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let ca_cert = ca_params
        .self_signed(&ca_key)
        .map_err(|e| AppError::wrap("生成局域网共享证书失败", e))?;

    let issuer = Issuer::new(ca_params, ca_key);
    let server_key =
        KeyPair::generate().map_err(|e| AppError::wrap("生成局域网共享证书失败", e))?;
    let mut server_params =
        CertificateParams::new(vec!["localhost".to_string(), "novion.local".to_string()])
            .map_err(|e| AppError::wrap("创建局域网共享证书失败", e))?;
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let server_cert = server_params
        .signed_by(&server_key, &issuer)
        .map_err(|e| AppError::wrap("生成局域网共享证书失败", e))?;

    Ok(IdentityMaterial {
        ca_pem: ca_cert.pem(),
        ca_fingerprint: fingerprint_of_der(ca_cert.der()),
        cert_pem: server_cert.pem(),
        key_pem: server_key.serialize_pem(),
    })
}

/// Loads the host's stable local CA and a server certificate signed by it.
/// If any identity file is missing, the set is regenerated and existing paired
/// clients must pair again (their saved CA no longer matches).
pub async fn load_or_create_identity(app: &AppHandle<Wry>) -> AppResult<Identity> {
    let dir = identity_dir(app)?;
    let ca_path = dir.join("ca.pem");
    let server_path = dir.join("server.pem");
    let server_key_path = dir.join("server-key.pem");

    if let (Ok(ca_pem), Ok(server_pem), Ok(server_key)) = (
        tokio::fs::read_to_string(&ca_path).await,
        tokio::fs::read_to_string(&server_path).await,
        tokio::fs::read_to_string(&server_key_path).await,
    ) {
        if !ca_pem.trim().is_empty()
            && !server_pem.trim().is_empty()
            && !server_key.trim().is_empty()
        {
            return Ok(Identity {
                ca_fingerprint: fingerprint_of_pem(&ca_pem)?,
                ca_pem,
                cert_path: server_path,
                key_path: server_key_path,
            });
        }
    }

    let material = identity_material()?;
    write_atomic(&ca_path, material.ca_pem.as_bytes()).await?;
    write_atomic(&server_path, material.cert_pem.as_bytes()).await?;
    write_atomic(&server_key_path, material.key_pem.as_bytes()).await?;
    for file in [&ca_path, &server_path, &server_key_path] {
        set_private_permissions(file);
    }

    Ok(Identity {
        ca_pem: material.ca_pem,
        ca_fingerprint: material.ca_fingerprint,
        cert_path: server_path,
        key_path: server_key_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_hash_is_stable_and_not_plaintext() {
        let hash = hash_token("secret-token");
        assert_eq!(hash, hash_token("secret-token"));
        assert_ne!(hash, "secret-token");
        assert_eq!(hash.len(), 64);
    }

    #[tokio::test]
    async fn pinned_client_accepts_generated_host_certificate() {
        use axum::routing::get;
        use axum::Router;

        let material = identity_material().expect("identity");
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("listener");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("addr").port();
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem(
            material.cert_pem.clone().into_bytes(),
            material.key_pem.clone().into_bytes(),
        )
        .await
        .expect("tls");
        let handle = axum_server::Handle::new();
        let router = Router::new().route("/", get(|| async { "ok" }));
        let task = tokio::spawn(async move {
            let server = axum_server::from_tcp_rustls(listener, tls)
                .expect("server")
                .handle(handle);
            let _ = server.serve(router.into_make_service()).await;
        });

        let client = super::super::client::pinned_client(&material.ca_pem).expect("client");
        let response = client
            .get(format!("https://127.0.0.1:{port}/"))
            .send()
            .await
            .expect("request");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.text().await.expect("body"), "ok");
        task.abort();
    }
}
