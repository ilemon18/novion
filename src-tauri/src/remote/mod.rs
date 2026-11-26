mod asset_proxy;
mod client;
mod discovery;
mod protocol;
mod server;
mod store;

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use axum_server::tls_rustls::RustlsConfig;
use axum_server::Handle;
use serde::Deserialize;
use serde_json::Value;
use subtle::ConstantTimeEq;
use tauri::{AppHandle, State as TauriState, Wry};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::models::now_ms;

use protocol::HelloResponse;
pub use protocol::{RemoteHost, RemoteStatus, SavedConnection, ShareStatus};
use store::{
    load_client_blocking, load_sharing_blocking, ClientPermission, ClientPrefs, PairedDevice,
    SavedTarget, SharingConfig, PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, PROTOCOL_VERSION,
    SHARE_PORT_DEFAULT, SHARE_PORT_MIN,
};

struct PairingSession {
    code: String,
    expires_at: u64,
    attempts: u32,
}

struct RunningShare {
    port: u16,
    addresses: Vec<String>,
    fingerprint: String,
    handle: Handle<std::net::SocketAddr>,
    task: tauri::async_runtime::JoinHandle<()>,
    advertiser: Option<discovery::Advertiser>,
    discovery_error: Option<String>,
}

pub struct ClientSession {
    host_id: String,
    host_name: String,
    workspace_name: String,
    base_url: String,
    token: String,
    ca_pem: String,
    client: reqwest::Client,
    asset_proxy: asset_proxy::AssetProxy,
    root_path: String,
    latency_ms: Option<u64>,
    permission: ClientPermission,
}

struct RemoteInner {
    sharing: RwLock<SharingConfig>,
    prefs: RwLock<ClientPrefs>,
    pairing: Mutex<Option<PairingSession>>,
    running: Mutex<Option<RunningShare>>,
    session: Mutex<Option<ClientSession>>,
}

#[derive(Clone)]
pub struct RemoteState {
    inner: Arc<RemoteInner>,
}

impl RemoteState {
    pub fn new(app: &AppHandle<Wry>) -> Self {
        Self {
            inner: Arc::new(RemoteInner {
                sharing: RwLock::new(load_sharing_blocking(app)),
                prefs: RwLock::new(load_client_blocking(app)),
                pairing: Mutex::new(None),
                running: Mutex::new(None),
                session: Mutex::new(None),
            }),
        }
    }

    pub fn sharing(&self) -> SharingConfig {
        self.inner
            .sharing
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn prefs(&self) -> ClientPrefs {
        self.inner
            .prefs
            .read()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn replace_prefs(&self, prefs: ClientPrefs) {
        if let Ok(mut guard) = self.inner.prefs.write() {
            *guard = prefs;
        }
    }

    pub async fn save_sharing(&self, app: &AppHandle<Wry>) -> AppResult<()> {
        let cfg = self.sharing();
        if let Ok(mut guard) = self.inner.sharing.write() {
            *guard = cfg.clone();
        }
        store::save_sharing(app, &cfg).await
    }

    async fn save_prefs(&self, app: &AppHandle<Wry>, prefs: &ClientPrefs) -> AppResult<()> {
        self.replace_prefs(prefs.clone());
        store::save_client(app, prefs).await
    }

    async fn new_pairing_code(&self) -> AppResult<(String, u64)> {
        let mut guard = self.inner.pairing.lock().await;
        let code = random_code();
        let expires_at = now_ms() + PAIRING_TTL_MS;
        *guard = Some(PairingSession {
            code: code.clone(),
            expires_at,
            attempts: 0,
        });
        Ok((code, expires_at))
    }

    async fn pairing_view(&self) -> (Option<String>, Option<u64>) {
        let guard = self.inner.pairing.lock().await;
        match guard.as_ref() {
            Some(session) if session.expires_at > now_ms() => {
                (Some(session.code.clone()), Some(session.expires_at))
            }
            _ => (None, None),
        }
    }

    async fn clear_pairing(&self) {
        *self.inner.pairing.lock().await = None;
    }

    pub async fn consume_pairing_code(&self, supplied: &str) -> bool {
        let mut guard = self.inner.pairing.lock().await;
        let Some(session) = guard.as_mut() else {
            return false;
        };
        if session.expires_at <= now_ms() {
            *guard = None;
            return false;
        }
        session.attempts = session.attempts.saturating_add(1);
        if session.attempts > PAIRING_MAX_ATTEMPTS {
            *guard = None;
            return false;
        }
        let expected = session.code.as_bytes();
        let supplied = supplied.trim().as_bytes();
        let matched = expected.len() == supplied.len()
            && bool::from(subtle::ConstantTimeEq::ct_eq(expected, supplied));
        if matched {
            *guard = None;
        }
        matched
    }

    pub async fn issue_token(&self, client_name: &str) -> AppResult<(String, ClientPermission)> {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let hash = store::hash_token(&token);
        let permission = ClientPermission::ReadWrite;
        let now = now_ms();
        {
            let mut guard = self
                .inner
                .sharing
                .write()
                .map_err(|_| AppError::new("remote_state", "共享状态不可用"))?;
            guard.paired.push(PairedDevice {
                id: format!("dev_{}", &hash[..12]),
                name: client_name.to_string(),
                token_hash: hash,
                permission,
                created_at: now,
                last_seen_at: now,
            });
        }
        Ok((token, permission))
    }

    pub async fn authenticate(&self, token: &str) -> Option<PairedDevice> {
        if token.is_empty() {
            return None;
        }
        let hash = store::hash_token(token);
        let mut found = None;
        if let Ok(mut guard) = self.inner.sharing.write() {
            if let Some(device) = guard.paired.iter_mut().find(|device| {
                device.token_hash.len() == hash.len()
                    && bool::from(device.token_hash.as_bytes().ct_eq(hash.as_bytes()))
            }) {
                device.last_seen_at = now_ms();
                found = Some(device.clone());
            }
        }
        found
    }

    async fn revoke_device(&self, app: &AppHandle<Wry>, id: &str) -> AppResult<()> {
        if let Ok(mut guard) = self.inner.sharing.write() {
            guard.paired.retain(|device| device.id != id);
        }
        self.save_sharing(app).await
    }

    fn saved_connection(&self) -> Option<SavedConnection> {
        self.prefs().target.map(|target| SavedConnection {
            host_id: target.host_id,
            host_name: target.host_name,
            host: target.host,
            port: target.port,
            workspace_name: target.workspace_name,
            fingerprint: target.ca_fingerprint,
        })
    }

    async fn session_state(&self) -> RemoteStatus {
        let guard = self.inner.session.lock().await;
        match guard.as_ref() {
            Some(session) => RemoteStatus {
                connected: true,
                host_id: Some(session.host_id.clone()),
                host_name: Some(session.host_name.clone()),
                workspace_name: Some(session.workspace_name.clone()),
                root_path: Some(session.root_path.clone()),
                asset_base: Some(session.root_path.clone()),
                latency_ms: session.latency_ms,
                protocol: Some(PROTOCOL_VERSION),
                error: None,
                saved: self.saved_connection(),
            },
            None => RemoteStatus::disconnected(self.saved_connection(), None),
        }
    }
}

fn random_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let raw = uuid::Uuid::new_v4().simple().to_string();
    let mut out = String::with_capacity(9);
    for (index, byte) in raw.bytes().take(8).enumerate() {
        if index == 4 {
            out.push('-');
        }
        out.push(ALPHABET[(byte as usize) % ALPHABET.len()] as char);
    }
    out
}

fn current_client() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| format!("Novion {}", std::env::consts::OS))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTargetInput {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub code: Option<String>,
    pub ca_pem: Option<String>,
    pub fingerprint: Option<String>,
}

// --------------------------------------------------------------- host commands

#[tauri::command]
pub async fn share_get_status(state: TauriState<'_, RemoteState>) -> AppResult<ShareStatus> {
    let mut slot = state.inner.running.lock().await;
    if slot
        .as_ref()
        .is_some_and(|running| running.task.inner().is_finished())
    {
        slot.take();
    }
    let pairing = state.pairing_view().await;
    let sharing = state.sharing();
    match slot.as_ref() {
        Some(running) => Ok(ShareStatus {
            running: true,
            port: running.port,
            addresses: running.addresses.clone(),
            host_id: sharing.host_id,
            device_name: sharing.device_name,
            fingerprint: running.fingerprint.clone(),
            paired: sharing.paired,
            pairing_code: pairing.0,
            pairing_expires_at: pairing.1,
            discovery_error: running.discovery_error.clone(),
        }),
        None => Ok(ShareStatus {
            running: false,
            port: sharing.port,
            addresses: discovery::display_addresses(),
            host_id: sharing.host_id,
            device_name: sharing.device_name,
            fingerprint: String::new(),
            paired: sharing.paired,
            pairing_code: pairing.0,
            pairing_expires_at: pairing.1,
            discovery_error: None,
        }),
    }
}

#[tauri::command]
pub async fn share_set_port(
    app: AppHandle<Wry>,
    state: TauriState<'_, RemoteState>,
    port: u16,
) -> AppResult<ShareStatus> {
    if port < SHARE_PORT_MIN {
        return Err(AppError::invalid(format!(
            "共享端口必须在 {SHARE_PORT_MIN}–65535 之间"
        )));
    }
    {
        let slot = state.inner.running.lock().await;
        if slot
            .as_ref()
            .is_some_and(|running| !running.task.inner().is_finished())
        {
            return Err(AppError::invalid("停止共享后才能更改端口"));
        }
    }
    if let Ok(mut guard) = state.inner.sharing.write() {
        guard.port = port;
    }
    state.save_sharing(&app).await?;
    share_get_status(state).await
}

#[tauri::command]
pub async fn share_set_device_name(
    app: AppHandle<Wry>,
    state: TauriState<'_, RemoteState>,
    name: String,
) -> AppResult<ShareStatus> {
    let name = name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err(AppError::invalid("设备名称需要 1–64 个字符"));
    }
    if let Ok(mut guard) = state.inner.sharing.write() {
        guard.device_name = name.to_string();
    }
    state.save_sharing(&app).await?;
    share_get_status(state).await
}

#[tauri::command]
pub async fn share_start(
    app: AppHandle<Wry>,
    state: TauriState<'_, RemoteState>,
) -> AppResult<ShareStatus> {
    let mut slot = state.inner.running.lock().await;
    if slot
        .as_ref()
        .is_some_and(|running| !running.task.inner().is_finished())
    {
        let sharing = state.sharing();
        let pairing = state.pairing_view().await;
        if let Some(running) = slot.as_ref() {
            return Ok(ShareStatus {
                running: true,
                port: running.port,
                addresses: running.addresses.clone(),
                host_id: sharing.host_id,
                device_name: sharing.device_name,
                fingerprint: running.fingerprint.clone(),
                paired: sharing.paired,
                pairing_code: pairing.0,
                pairing_expires_at: pairing.1,
                discovery_error: running.discovery_error.clone(),
            });
        }
    }
    slot.take();

    let sharing = state.sharing();
    let identity = store::load_or_create_identity(&app).await?;
    let tls = RustlsConfig::from_pem_file(&identity.cert_path, &identity.key_path)
        .await
        .map_err(|e| AppError::wrap("加载局域网共享证书失败", e))?;
    let listener = std::net::TcpListener::bind(("0.0.0.0", sharing.port))
        .map_err(|e| AppError::io(&format!("启动共享端口 {} 失败", sharing.port), e))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| AppError::io("配置共享端口失败", e))?;

    let ctx = Arc::new(server::ServerContext {
        app: app.clone(),
        remote: state.inner_handle(),
        ca_pem: identity.ca_pem.clone(),
        ca_fingerprint: identity.ca_fingerprint.clone(),
    });
    let router = server::router(ctx);
    let handle = Handle::new();
    let server_handle = handle.clone();
    let task = tauri::async_runtime::spawn(async move {
        let server = match axum_server::from_tcp_rustls(listener, tls) {
            Ok(server) => server.handle(server_handle),
            Err(error) => {
                eprintln!("[novion] LAN sharing could not start: {error}");
                return;
            }
        };
        if let Err(error) = server.serve(router.into_make_service()).await {
            eprintln!("[novion] LAN sharing stopped: {error}");
        }
    });

    let workspace_name = server::workspace_name(&app);
    let advertised = discovery::advertise(
        &sharing.host_id,
        &sharing.device_name,
        sharing.port,
        &identity.ca_pem,
        &identity.ca_fingerprint,
        &workspace_name,
    );
    let (advertiser, discovery_error) = match advertised {
        Ok(advertiser) => (Some(advertiser), None),
        Err(error) => (None, Some(error.message)),
    };

    let addresses = discovery::display_addresses();
    let pairing = state.pairing_view().await;
    let status = ShareStatus {
        running: true,
        port: sharing.port,
        addresses,
        host_id: sharing.host_id,
        device_name: sharing.device_name,
        fingerprint: identity.ca_fingerprint,
        paired: sharing.paired,
        pairing_code: pairing.0,
        pairing_expires_at: pairing.1,
        discovery_error,
    };
    *slot = Some(RunningShare {
        port: sharing.port,
        addresses: status.addresses.clone(),
        fingerprint: status.fingerprint.clone(),
        handle,
        task,
        advertiser,
        discovery_error: status.discovery_error.clone(),
    });
    Ok(status)
}

#[tauri::command]
pub async fn share_stop(state: TauriState<'_, RemoteState>) -> AppResult<ShareStatus> {
    let mut slot = state.inner.running.lock().await;
    if let Some(running) = slot.take() {
        if let Some(advertiser) = running.advertiser {
            advertiser.stop();
        }
        running
            .handle
            .graceful_shutdown(Some(Duration::from_secs(1)));
        let task = running.task;
        task.abort();
        let _ = task.await;
    }
    state.clear_pairing().await;
    drop(slot);
    share_get_status(state).await
}

#[tauri::command]
pub async fn share_new_pairing_code(
    state: TauriState<'_, RemoteState>,
) -> AppResult<(String, u64)> {
    {
        let slot = state.inner.running.lock().await;
        if !slot
            .as_ref()
            .is_some_and(|running| !running.task.inner().is_finished())
        {
            return Err(AppError::invalid("请先开启共享"));
        }
    }
    state.new_pairing_code().await
}

#[tauri::command]
pub async fn share_revoke_device(
    app: AppHandle<Wry>,
    state: TauriState<'_, RemoteState>,
    id: String,
) -> AppResult<ShareStatus> {
    state.revoke_device(&app, &id).await?;
    share_get_status(state).await
}

// ------------------------------------------------------------- client commands

#[tauri::command]
pub async fn remote_scan() -> AppResult<Vec<RemoteHost>> {
    discovery::scan().await
}

#[tauri::command]
pub async fn remote_get_state(state: TauriState<'_, RemoteState>) -> AppResult<RemoteStatus> {
    Ok(state.session_state().await)
}

#[tauri::command]
pub async fn remote_connect_saved(
    app: AppHandle<Wry>,
    state: TauriState<'_, RemoteState>,
) -> AppResult<RemoteStatus> {
    let target = state
        .prefs()
        .target
        .ok_or_else(|| AppError::invalid("没有保存的远程主机"))?;
    let input = RemoteTargetInput {
        host: Some(target.host.clone()),
        port: Some(target.port),
        code: None,
        ca_pem: Some(target.ca_pem.clone()),
        fingerprint: Some(target.ca_fingerprint.clone()),
    };
    connect_inner(app, state, input).await
}

#[tauri::command]
pub async fn remote_connect(
    app: AppHandle<Wry>,
    state: TauriState<'_, RemoteState>,
    target: RemoteTargetInput,
) -> AppResult<RemoteStatus> {
    connect_inner(app, state, target).await
}

async fn connect_inner(
    app: AppHandle<Wry>,
    state: TauriState<'_, RemoteState>,
    input: RemoteTargetInput,
) -> AppResult<RemoteStatus> {
    let saved = state.prefs().target;
    let host = input
        .host
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| saved.as_ref().map(|target| target.host.clone()))
        .ok_or_else(|| AppError::invalid("请输入主机地址"))?;
    let port = input
        .port
        .or_else(|| saved.as_ref().map(|target| target.port))
        .unwrap_or(SHARE_PORT_DEFAULT);
    let base = client::base_url(&host, port);
    let code = input.code.unwrap_or_default();
    let use_saved = code.trim().is_empty()
        && saved
            .as_ref()
            .is_some_and(|target| target.host == host && target.port == port);

    let (token, ca_pem, info) = if use_saved {
        let target = saved
            .as_ref()
            .ok_or_else(|| AppError::invalid("没有保存的远程主机"))?;
        let info = client::hello(&base, &target.token, &target.ca_pem).await?;
        (target.token.clone(), target.ca_pem.clone(), info)
    } else {
        if code.trim().is_empty() {
            return Err(AppError::invalid("首次连接需要输入主机上显示的配对码"));
        }
        let provided_ca = input.ca_pem.clone();
        if let Some(ca) = provided_ca.as_deref() {
            let info = client::info(&base, Some(ca)).await?;
            if let Some(expected) = input.fingerprint.as_deref() {
                if !expected.is_empty() && expected != info.fingerprint {
                    return Err(AppError::new(
                        "remote_identity_mismatch",
                        "主机证书与扫描结果不一致，连接已拒绝。",
                    ));
                }
            }
        }
        let paired = client::pair(
            &base,
            code.trim(),
            &current_client(),
            provided_ca.as_deref(),
        )
        .await?;
        let info = HelloResponse {
            protocol: paired.info.protocol,
            host_id: paired.info.host_id.clone(),
            host_name: paired.info.host_name.clone(),
            workspace_name: paired.info.workspace_name.clone(),
            permission: paired.permission,
        };
        (paired.token, paired.info.ca_pem, info)
    };

    if info.protocol != PROTOCOL_VERSION {
        return Err(AppError::new(
            "protocol_mismatch",
            format!(
                "主机协议版本为 {}，本机为 {}，请将两台电脑更新到同一版本。",
                info.protocol, PROTOCOL_VERSION
            ),
        ));
    }
    let client = client::pinned_client(&ca_pem)?;
    let started = Instant::now();
    let hello = client::hello(&base, &token, &ca_pem).await?;
    let latency = started.elapsed().as_millis() as u64;
    let proxy = asset_proxy::start(base.clone(), token.clone(), ca_pem.clone()).await?;
    let root_path = proxy.base.clone();
    let ca_fingerprint = store::fingerprint_of_pem(&ca_pem)?;
    let fingerprint = input
        .fingerprint
        .filter(|value| !value.is_empty())
        .unwrap_or(ca_fingerprint.clone());

    let target = SavedTarget {
        host: host.clone(),
        port,
        host_id: hello.host_id.clone(),
        host_name: hello.host_name.clone(),
        workspace_name: hello.workspace_name.clone(),
        ca_pem: ca_pem.clone(),
        ca_fingerprint: fingerprint,
        token: token.clone(),
    };
    let prefs = ClientPrefs {
        target: Some(target.clone()),
    };
    state.save_prefs(&app, &prefs).await?;

    let session = ClientSession {
        host_id: hello.host_id.clone(),
        host_name: hello.host_name.clone(),
        workspace_name: hello.workspace_name.clone(),
        base_url: base,
        token,
        ca_pem,
        client,
        asset_proxy: proxy,
        root_path,
        latency_ms: Some(latency),
        permission: hello.permission,
    };
    let view = RemoteStatus {
        connected: true,
        host_id: Some(session.host_id.clone()),
        host_name: Some(session.host_name.clone()),
        workspace_name: Some(session.workspace_name.clone()),
        root_path: Some(session.root_path.clone()),
        asset_base: Some(session.root_path.clone()),
        latency_ms: session.latency_ms,
        protocol: Some(PROTOCOL_VERSION),
        error: None,
        saved: Some(SavedConnection {
            host_id: target.host_id,
            host_name: target.host_name,
            host: target.host,
            port: target.port,
            workspace_name: target.workspace_name,
            fingerprint: target.ca_fingerprint,
        }),
    };
    let mut slot = state.inner.session.lock().await;
    if let Some(old) = slot.take() {
        old.asset_proxy.stop();
    }
    *slot = Some(session);
    Ok(view)
}

#[tauri::command]
pub async fn remote_call(
    state: TauriState<'_, RemoteState>,
    name: String,
    args: Option<Value>,
) -> AppResult<Value> {
    let args = args.unwrap_or(Value::Object(Default::default()));
    let mut slot = state.inner.session.lock().await;
    let Some(session) = slot.as_mut() else {
        return Err(AppError::new("remote_offline", "当前未连接远程主机。"));
    };
    let result = client::rpc::<Value, Value>(
        &session.client,
        &session.base_url,
        &session.token,
        &name,
        &args,
    )
    .await;
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            if error.code == "remote_unauthorized" {
                if let Some(old) = slot.take() {
                    old.asset_proxy.stop();
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn remote_ping(state: TauriState<'_, RemoteState>) -> AppResult<RemoteStatus> {
    let mut slot = state.inner.session.lock().await;
    let Some(session) = slot.as_mut() else {
        drop(slot);
        return Ok(state.session_state().await);
    };
    let started = Instant::now();
    let result = client::hello(&session.base_url, &session.token, &session.ca_pem).await;
    match result {
        Ok(hello) => {
            session.latency_ms = Some(started.elapsed().as_millis() as u64);
            session.workspace_name = hello.workspace_name;
            session.permission = hello.permission;
            drop(slot);
            Ok(state.session_state().await)
        }
        Err(error) => {
            let unauthorized = error.code == "remote_unauthorized";
            if unauthorized {
                if let Some(old) = slot.take() {
                    old.asset_proxy.stop();
                }
            }
            drop(slot);
            let mut view = state.session_state().await;
            if unauthorized {
                view = RemoteStatus::disconnected(state.saved_connection(), Some(error.message));
            } else {
                view.error = Some(error.message);
            }
            Ok(view)
        }
    }
}

#[tauri::command]
pub async fn remote_disconnect(state: TauriState<'_, RemoteState>) -> AppResult<RemoteStatus> {
    let mut slot = state.inner.session.lock().await;
    if let Some(session) = slot.take() {
        session.asset_proxy.stop();
    }
    drop(slot);
    Ok(state.session_state().await)
}

#[tauri::command]
pub async fn remote_forget(
    app: AppHandle<Wry>,
    state: TauriState<'_, RemoteState>,
) -> AppResult<RemoteStatus> {
    {
        let mut slot = state.inner.session.lock().await;
        if let Some(session) = slot.take() {
            session.asset_proxy.stop();
        }
    }
    let prefs = ClientPrefs::default();
    state.save_prefs(&app, &prefs).await?;
    Ok(RemoteStatus::disconnected(None, None))
}

impl RemoteState {
    fn inner_handle(&self) -> RemoteState {
        self.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> RemoteState {
        RemoteState {
            inner: Arc::new(RemoteInner {
                sharing: RwLock::new(SharingConfig::default()),
                prefs: RwLock::new(ClientPrefs::default()),
                pairing: Mutex::new(None),
                running: Mutex::new(None),
                session: Mutex::new(None),
            }),
        }
    }

    #[tokio::test]
    async fn pairing_code_is_one_time_and_attempt_limited() {
        let state = test_state();
        let (code, _) = state.new_pairing_code().await.expect("code");
        assert!(state.consume_pairing_code(&code).await);
        assert!(!state.consume_pairing_code(&code).await);

        let (code, _) = state.new_pairing_code().await.expect("code");
        for _ in 0..PAIRING_MAX_ATTEMPTS {
            assert!(!state.consume_pairing_code("WRONG-CODE").await);
        }
        assert!(!state.consume_pairing_code(&code).await);
    }

    #[tokio::test]
    async fn issued_tokens_authenticate_with_read_write_permission() {
        let state = test_state();
        let (token, permission) = state.issue_token("Test client").await.expect("token");
        assert_eq!(permission, ClientPermission::ReadWrite);
        let device = state.authenticate(&token).await.expect("authenticated");
        assert_eq!(device.name, "Test client");
        assert!(state.authenticate("not-the-token").await.is_none());
    }

    #[test]
    fn pairing_codes_have_the_expected_shape() {
        for _ in 0..100 {
            let code = random_code();
            assert_eq!(code.len(), 9);
            assert_eq!(&code[4..5], "-");
            assert!(code
                .chars()
                .filter(|c| *c != '-')
                .all(|c| "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(c)));
        }
    }
}
