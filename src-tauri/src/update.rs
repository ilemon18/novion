//! In-app updates from GitHub Releases.
//!
//! The app ships as a `.dmg` (macOS) or an NSIS `.exe` (Windows) on
//! `github.com/ilemon18/novion/releases`. This module mirrors what
//! `tauri-plugin-updater` would do — check, download with progress, install —
//! without signed updater artifacts (the release workflow publishes plain
//! bundles).
//!
//! Checking reads a small `latest.json` release asset
//! (`releases/latest/download/latest.json`) that the release workflow writes
//! next to the bundles. Assets are served by the release CDN, so this costs no
//! GitHub API quota and cannot hit the unauthenticated 60-requests/hour limit;
//! the REST API stays as a fallback for releases published before the manifest
//! existed.
//!
//! Flow: `update_check` → `update_download` (progress events) → `update_install`
//! (a detached helper replaces the bundle once this process has exited) →
//! `update_startup_report` on the next launch.
//!
//! Installing is where updates normally die silently, so everything about it is
//! designed to be *checked* rather than trusted:
//!
//! * The helper waits for this process to be gone, unpacks, **verifies the
//!   version it unpacked**, swaps the bundle through a sibling directory, and
//!   relaunches — including relaunching the *old* build when any step fails.
//! * It writes every step to `update.log` (see [`log_path`]); the UI can reveal
//!   that file, so a failure is never a mystery again.
//! * `update_install` leaves an `update-pending.json` marker naming the version
//!   it asked for. The next launch compares it with the running version and
//!   reports a mismatch, which is the only way to notice an installer that ran
//!   and did nothing (the Windows case).
//! * On macOS the update is installed into whichever of the running bundle,
//!   `/Applications` or `~/Applications` is writable. An app opened straight
//!   from the downloaded `.dmg` therefore updates itself instead of saying
//!   "cannot install from here".
//!
//! Security: only `https` URLs on GitHub hosts are downloaded, the expected
//! byte count *and* the SHA-256 from the manifest are verified, and nothing is
//! executed before the user asks for it. There is no code-signing check yet —
//! see the note in `release/README.md`.

use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::{AppError, AppResult};

/// Where releases are published.
const REPO: &str = "ilemon18/novion";
/// Written by `scripts/make-latest-json.mjs` during the release job. Served as
/// a release asset, so reading it does not consume API quota.
const MANIFEST_URL: &str =
    "https://github.com/ilemon18/novion/releases/latest/download/latest.json";
const USER_AGENT: &str = concat!("Novion/", env!("CARGO_PKG_VERSION"));
const PROGRESS_EVENT: &str = "update:progress";
/// A sanity bound: the bundle is ~20 MB, so anything near this is not us.
const MAX_ASSET_BYTES: u64 = 400 * 1024 * 1024;
/// How long the helper waits for this process to disappear before it gives up
/// (it is spawned right before the app exits, so this is generous).
#[cfg(any(target_os = "macos", target_os = "windows"))]
const INSTALL_EXIT_MS: u64 = 600;
/// What the helper did, step by step. Rotated like the client error log, so a
/// helper stuck in a loop cannot fill the disk.
const LOG_FILE: &str = "update.log";
const LOG_MAX_BYTES: u64 = 256 * 1024;
/// Written by `update_install` and read once by the launch that follows it: it
/// names the version the helper was asked to install, so a launch that still
/// runs the old build can say so instead of looking like nothing happened.
const PENDING_FILE: &str = "update-pending.json";

/// Path of the download that `update_install` should apply.
#[derive(Default)]
pub struct UpdateState(Mutex<Option<PathBuf>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// a newer release exists *and* has a bundle for this platform
    pub available: bool,
    /// false when the repository has no published release (yet), so the UI can
    /// say so instead of claiming "up to date"
    pub has_release: bool,
    pub current: String,
    pub latest: String,
    pub name: String,
    pub notes: String,
    pub page_url: String,
    pub published_at: String,
    /// file name of the bundle that would be downloaded ("" when none matched)
    pub asset_name: String,
    pub asset_size: u64,
    pub download_url: String,
    /// SHA-256 of the bundle, empty when the release predates the manifest
    pub checksum: String,
}

impl UpdateInfo {
    fn up_to_date(current: &str) -> Self {
        Self {
            available: false,
            has_release: false,
            current: current.to_string(),
            latest: current.to_string(),
            name: String::new(),
            notes: String::new(),
            page_url: String::new(),
            published_at: String::new(),
            asset_name: String::new(),
            asset_size: 0,
            download_url: String::new(),
            checksum: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub received: u64,
    pub total: u64,
    pub percent: u8,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    /// "restart" = the helper replaces the bundle and relaunches the app;
    /// "manual" = the file was revealed in the file manager instead
    pub mode: &'static str,
    /// the downloaded bundle
    pub path: String,
    /// the `.app` (macOS) that will hold the update; empty for "manual"
    pub installed_to: String,
    /// where this build runs from, when the update lands somewhere else (an app
    /// opened from the downloaded `.dmg` installs into `~/Applications`, for
    /// instance); empty when the bundle is replaced in place
    pub previous: String,
    pub log_path: String,
}

/// What the launch after an install attempt can say about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    /// version the helper was asked to install
    pub attempted: String,
    /// version actually running now
    pub current: String,
    /// false when the swap did not take: this launch is still the old build
    pub ok: bool,
    pub installed_to: String,
    pub previous: String,
    pub log_path: String,
}

/// `update-pending.json`. Same fields as [`UpdateReport`] plus the timestamp,
/// because the file outlives the process that wrote it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingUpdate {
    attempted: String,
    installed_to: String,
    previous: String,
    log_path: String,
    at: u64,
}

// --------------------------------------------------------------- GitHub JSON

#[derive(Debug, Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    #[allow(dead_code)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    browser_download_url: String,
}

/// `latest.json`, produced by the release job. Contains only what the app
/// needs, so no REST call is required (see `MANIFEST_URL`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    version: String,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    page_url: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    assets: ManifestAssets,
}

#[derive(Debug, Default, Deserialize)]
struct ManifestAssets {
    #[serde(default)]
    macos: Option<ManifestAsset>,
    #[serde(default)]
    windows: Option<ManifestAsset>,
}

#[derive(Debug, Deserialize)]
struct ManifestAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // every variant is reachable, but only one per target platform
enum Platform {
    Macos,
    Windows,
    Other,
}

fn current_platform() -> Platform {
    #[cfg(target_os = "macos")]
    {
        Platform::Macos
    }
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Platform::Other
    }
}

/// Picks the bundle that belongs to `platform`: `novion-macos-X.Y.Z.dmg` or
/// `novion-win-X.Y.Z.exe`. Falls back to the right extension alone, so renaming
/// the asset prefix in the workflow cannot silently disable updates.
fn pick_asset<'a>(assets: &'a [Asset], platform: Platform) -> Option<&'a Asset> {
    let (ext, hint) = match platform {
        Platform::Macos => (".dmg", "macos"),
        Platform::Windows => (".exe", "win"),
        Platform::Other => return None,
    };
    let matches_ext = |asset: &&Asset| asset.name.to_ascii_lowercase().ends_with(ext);
    assets
        .iter()
        .filter(matches_ext)
        .find(|asset| asset.name.to_ascii_lowercase().contains(hint))
        .or_else(|| assets.iter().filter(matches_ext).next())
}

fn manifest_asset(manifest: &Manifest, platform: Platform) -> Option<&ManifestAsset> {
    match platform {
        Platform::Macos => manifest.assets.macos.as_ref(),
        Platform::Windows => manifest.assets.windows.as_ref(),
        Platform::Other => None,
    }
}

/// `1.2.0` > `1.1.9`, `v1.2.0` == `1.2.0`, and a release beats its prerelease.
fn is_newer(candidate: &str, current: &str) -> bool {
    fn parse(value: &str) -> (Vec<u64>, Option<String>) {
        let trimmed = value.trim().trim_start_matches(['v', 'V']);
        let (core, pre) = match trimmed.split_once('-') {
            Some((core, pre)) => (core, Some(pre.to_ascii_lowercase())),
            None => (trimmed, None),
        };
        let numbers = core
            .split('.')
            .map(|part| {
                part.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect();
        (numbers, pre)
    }

    let (a, a_pre) = parse(candidate);
    let (b, b_pre) = parse(current);
    for index in 0..a.len().max(b.len()) {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    match (a_pre, b_pre) {
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (left, right) => left > right,
    }
}

/// Only bundles served by GitHub over TLS are accepted.
fn trusted_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    match url.host_str() {
        Some("github.com") => true,
        Some(host) => host.ends_with(".githubusercontent.com"),
        None => false,
    }
}

fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| AppError::new("update_network", format!("初始化网络客户端失败：{err}")))
}

fn network(context: &str, err: impl std::fmt::Display) -> AppError {
    AppError::new("update_network", format!("{context}：{err}"))
}

fn percent(received: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    ((received.saturating_mul(100) / total).min(100)) as u8
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, received: u64, total: u64, done: bool) {
    let _ = app.emit(
        PROGRESS_EVENT,
        UpdateProgress {
            received,
            total,
            percent: percent(received, total),
            done,
        },
    );
}

fn sanitize_file_name(raw: &str) -> String {
    let name: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if name.is_empty() {
        "novion-update".to_string()
    } else {
        name
    }
}

/// `~/Library/Logs/app.novion.desktop/update.log` on macOS,
/// `%LOCALAPPDATA%\app.novion.desktop\logs\update.log` on Windows.
fn log_path<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("novion-logs"));
    let _ = std::fs::create_dir_all(&dir);
    dir.join(LOG_FILE)
}

fn write_log<R: Runtime>(app: &AppHandle<R>, message: &str) {
    let file = log_path(app);
    if let Ok(meta) = std::fs::metadata(&file) {
        if meta.len() > LOG_MAX_BYTES {
            let _ = std::fs::remove_file(&file);
        }
    }
    if let Ok(mut handle) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
    {
        let _ = writeln!(
            handle,
            "[{}] {}",
            crate::models::now_ms(),
            message.trim()
        );
    }
}

fn pending_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(PENDING_FILE))
}

/// Removes the marker, so a helper that never started cannot be reported as a
/// failed install on the next launch.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn clear_pending<R: Runtime>(app: &AppHandle<R>) {
    if let Some(file) = pending_file(app) {
        let _ = std::fs::remove_file(file);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn write_pending<R: Runtime>(app: &AppHandle<R>, pending: &PendingUpdate) {
    let Some(file) = pending_file(app) else {
        return;
    };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_vec_pretty(pending) {
        let _ = std::fs::write(&file, text);
    }
}

/// `v0.0.2` and `0.0.2` name the same build; anything else must match exactly.
fn versions_equal(left: &str, right: &str) -> bool {
    let normalize = |value: &str| value.trim().trim_start_matches(['v', 'V']).to_string();
    normalize(left) == normalize(right)
}

/// Fills the `@@NAME@@` placeholders of a helper script.
///
/// The scripts are shell/PowerShell source with braces, quotes and `$` all over
/// them, so they are kept as plain templates and substituted here instead of
/// being pushed through `format!`, where every `{` would need escaping.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn fill(template: &str, values: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (key, value) in values {
        out = out.replace(key, value);
    }
    out
}

// ------------------------------------------------------------------- commands

/// Asks GitHub for the latest release and compares it with this build.
///
/// Runs once at startup and whenever the user asks; an unauthenticated request
/// is one of 60 per hour per IP, so the frontend throttles its own polling.
#[tauri::command]
pub async fn update_check<R: Runtime>(app: AppHandle<R>) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let http = client()?;

    // Preferred path: the manifest asset (release CDN, no API quota).
    // `None` means "this release has no manifest" — then the REST API below is
    // still consulted, which keeps older releases (v0.0.1) working.
    if let Some(manifest) = fetch_manifest(&http).await? {
        return Ok(info_from_manifest(manifest, &current, current_platform()));
    }

    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let response = http
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|err| network("连接 GitHub 失败", err))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        // the repository has no published release yet: nothing to offer
        return Ok(UpdateInfo::up_to_date(&current));
    }
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(AppError::new(
            "update_rate_limited",
            "GitHub 暂时限制了请求频率，请稍后再试",
        ));
    }
    if !status.is_success() {
        return Err(AppError::new(
            "update_network",
            format!("GitHub 返回了 {status}"),
        ));
    }

    let release: Release = response
        .json()
        .await
        .map_err(|err| network("解析 GitHub 返回内容失败", err))?;
    Ok(info_from_release(release, &current, current_platform()))
}

/// Reads `latest.json`. `Ok(None)` = the newest release has no manifest (older
/// release, so the caller should fall back to the API); `Err` = transport or
/// server problem, where a second request would fail the same way.
async fn fetch_manifest(http: &reqwest::Client) -> AppResult<Option<Manifest>> {
    let response = http
        .get(MANIFEST_URL)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| network("连接 GitHub 失败", err))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(AppError::new(
            "update_network",
            format!("GitHub 返回了 {}", response.status()),
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| network("读取更新清单失败", err))?;
    match serde_json::from_slice::<Manifest>(&bytes) {
        Ok(manifest) if !manifest.version.trim().is_empty() => Ok(Some(manifest)),
        // a corrupt manifest must not brick updates: fall back to the API
        _ => Ok(None),
    }
}

/// Manifest → decision. Kept pure so it can be tested without the network.
fn info_from_manifest(manifest: Manifest, current: &str, platform: Platform) -> UpdateInfo {
    let latest = manifest
        .version
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    if latest.is_empty() {
        return UpdateInfo::up_to_date(current);
    }

    let asset = manifest_asset(&manifest, platform);
    let usable = asset
        .map(|a| a.size > 0 && !a.url.is_empty() && trusted_url(&a.url))
        .unwrap_or(false);
    // An asset that is not served by GitHub over TLS is dropped entirely
    // rather than merely flagged: an untrusted URL must never reach the UI.
    let (asset_name, asset_size, download_url, checksum) = match (usable, asset) {
        (true, Some(asset)) => (
            asset.name.clone(),
            asset.size,
            asset.url.clone(),
            asset.sha256.trim().to_ascii_lowercase(),
        ),
        _ => (String::new(), 0, String::new(), String::new()),
    };

    UpdateInfo {
        available: usable && is_newer(&latest, current),
        has_release: true,
        current: current.to_string(),
        latest,
        name: manifest.tag,
        notes: String::new(),
        page_url: manifest.page_url,
        published_at: manifest.published_at,
        asset_name,
        asset_size,
        download_url,
        checksum,
    }
}

/// Pure release → decision mapping, so the parsing rules can be tested without
/// the network (see the fixture test below).
fn info_from_release(release: Release, current: &str, platform: Platform) -> UpdateInfo {
    if release.draft || release.tag_name.trim().is_empty() {
        let mut info = UpdateInfo::up_to_date(current);
        info.has_release = !release.draft;
        return info;
    }

    let latest = release
        .tag_name
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    let asset = pick_asset(&release.assets, platform);
    let download_url = asset.map(|a| a.browser_download_url.clone()).unwrap_or_default();
    let asset_name = asset.map(|a| a.name.clone()).unwrap_or_default();
    let asset_size = asset.map(|a| a.size).unwrap_or(0);
    // A bundle that is not served by GitHub over TLS is dropped entirely rather
    // than merely flagged: an untrusted URL must never be handed to the UI.
    let usable = !download_url.is_empty() && trusted_url(&download_url);
    let (download_url, asset_name, asset_size) = if usable {
        (download_url, asset_name, asset_size)
    } else {
        (String::new(), String::new(), 0)
    };

    UpdateInfo {
        available: usable && is_newer(&latest, current),
        has_release: true,
        current: current.to_string(),
        latest,
        name: release.name.unwrap_or_default(),
        notes: release.body.unwrap_or_default(),
        page_url: release.html_url,
        published_at: release.published_at,
        asset_name,
        asset_size,
        download_url,
        // the REST API does not expose a digest; the manifest path provides it
        checksum: String::new(),
    }
}

/// Streams the bundle into the app cache directory and reports progress.
#[tauri::command]
pub async fn update_download<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, UpdateState>,
    url: String,
    file_name: String,
    // SHA-256 from `latest.json`; empty/absent for releases without a manifest
    checksum: Option<String>,
) -> AppResult<String> {
    if !trusted_url(&url) {
        return Err(AppError::new(
            "update_untrusted",
            "更新地址不是 GitHub 的 HTTPS 地址，已拒绝下载",
        ));
    }

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| AppError::wrap("找不到缓存目录", err))?
        .join("updates");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|err| AppError::io("创建更新缓存目录失败", err))?;
    // a stale bundle from a previous attempt must never be installed by accident
    if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }

    let target = dir.join(sanitize_file_name(&file_name));
    let mut response = client()?
        .get(&url)
        .send()
        .await
        .map_err(|err| network("下载更新失败", err))?
        .error_for_status()
        .map_err(|err| network("下载更新失败", err))?;

    let total = response.content_length().unwrap_or(0);
    if total > MAX_ASSET_BYTES {
        return Err(AppError::new("update_too_large", "更新包大小异常，已取消下载"));
    }

    emit_progress(&app, 0, total, false);
    let mut file = tokio::fs::File::create(&target)
        .await
        .map_err(|err| AppError::io("创建更新文件失败", err))?;
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut last_percent = 0u8;
    let mut hasher = Sha256::new();

    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => {
                let _ = tokio::fs::remove_file(&target).await;
                return Err(network("下载更新中断", err));
            }
        };
        received += chunk.len() as u64;
        if received > MAX_ASSET_BYTES {
            let _ = tokio::fs::remove_file(&target).await;
            return Err(AppError::new("update_too_large", "更新包大小异常，已取消下载"));
        }
        hasher.update(&chunk);
        if let Err(err) = tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await {
            let _ = tokio::fs::remove_file(&target).await;
            return Err(AppError::io("写入更新文件失败", err));
        }
        let now = percent(received, total);
        if now != last_percent || last_emit.elapsed() >= Duration::from_millis(150) {
            last_emit = Instant::now();
            last_percent = now;
            emit_progress(&app, received, total, false);
        }
    }

    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|err| AppError::io("写入更新文件失败", err))?;
    file.sync_all()
        .await
        .map_err(|err| AppError::io("写入更新文件失败", err))?;

    if total > 0 && received != total {
        let _ = tokio::fs::remove_file(&target).await;
        return Err(AppError::new(
            "update_incomplete",
            format!("更新包不完整（{received}/{total} 字节）"),
        ));
    }

    // Integrity: the digest travels in the manifest, so a tampered or truncated
    // bundle is rejected before it can ever be installed.
    if let Some(expected) = checksum.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&target).await;
            return Err(AppError::new(
                "update_checksum",
                format!("更新包校验失败（预期 {expected}，实际 {actual}）"),
            ));
        }
    }

    emit_progress(&app, received, total.max(received), true);
    *state
        .0
        .lock()
        .map_err(|_| AppError::new("update_state", "更新状态不可用"))? = Some(target.clone());
    Ok(target.to_string_lossy().to_string())
}

/// Installs the downloaded bundle. A detached helper replaces the bundle after
/// this process exits and relaunches the app.
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, UpdateState>,
    // version from `latest.json`; the helper refuses to install anything else,
    // so a mismatched or leftover download cannot be applied quietly
    version: Option<String>,
) -> AppResult<InstallOutcome> {
    let archive = state
        .0
        .lock()
        .map_err(|_| AppError::new("update_state", "更新状态不可用"))?
        .clone()
        .ok_or_else(|| AppError::new("update_not_ready", "还没有下载好的更新"))?;
    if !archive.exists() {
        return Err(AppError::new("update_not_ready", "更新文件已被删除，请重新下载"));
    }

    let current = app.package_info().version.to_string();
    let expected = version
        .map(|value| value.trim().trim_start_matches(['v', 'V']).to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| current.clone());
    let log = log_path(&app).to_string_lossy().to_string();
    write_log(
        &app,
        &format!(
            "install requested: {current} -> {expected} ({})",
            archive.display()
        ),
    );

    #[cfg(target_os = "macos")]
    {
        return macos_install(&app, &archive, &expected, &log);
    }

    #[cfg(target_os = "windows")]
    {
        return windows_install(&app, &archive, &expected, &log);
    }

    #[allow(unreachable_code)]
    {
        reveal(&app, &archive)?;
        Ok(InstallOutcome {
            mode: "manual",
            path: archive.to_string_lossy().to_string(),
            installed_to: String::new(),
            previous: String::new(),
            log_path: log,
        })
    }
}

/// Reads (and clears) the marker left by `update_install`, so the launch after
/// "restart to install" can tell the user whether the update actually took.
///
/// `None` = no install was attempted; `Some(report)` with `ok: false` = the
/// helper ran but this launch is still the old build (the silent failure that
/// made "restart and nothing changed" impossible to explain).
#[tauri::command]
pub async fn update_startup_report<R: Runtime>(
    app: AppHandle<R>,
) -> AppResult<Option<UpdateReport>> {
    let Some(file) = pending_file(&app) else {
        return Ok(None);
    };
    let Ok(bytes) = std::fs::read(&file) else {
        return Ok(None);
    };
    // read once: a report shown twice would nag about a settled install
    let _ = std::fs::remove_file(&file);
    let Ok(pending) = serde_json::from_slice::<PendingUpdate>(&bytes) else {
        return Ok(None);
    };

    let current = app.package_info().version.to_string();
    let ok = versions_equal(&pending.attempted, &current);
    write_log(
        &app,
        &format!(
            "launch after install: wanted {} running {current} -> {}",
            pending.attempted,
            if ok { "ok" } else { "did not take effect" }
        ),
    );

    Ok(Some(UpdateReport {
        attempted: pending.attempted,
        current,
        ok,
        installed_to: pending.installed_to,
        previous: pending.previous,
        log_path: pending.log_path,
    }))
}

/// Reveals `update.log` in the file manager, so a failed install is
/// diagnosable from inside the app (there is no console to read).
#[tauri::command]
pub async fn update_reveal_log<R: Runtime>(app: AppHandle<R>) -> AppResult<String> {
    let file = log_path(&app);
    if !file.exists() {
        write_log(&app, "no update has run yet");
    }
    reveal(&app, &file)?;
    Ok(file.to_string_lossy().to_string())
}

fn reveal<R: Runtime>(app: &AppHandle<R>, path: &Path) -> AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|err| AppError::wrap("打开文件位置失败", err))
}

// -------------------------------------------------------------------- macOS

/// The `.app` this binary was started from, if any.
#[cfg(target_os = "macos")]
fn bundle_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|path| path.extension().map(|ext| ext == "app").unwrap_or(false))
        .map(Path::to_path_buf)
}

/// A developer build under `src-tauri/target`: it must never be replaced by a
/// release bundle, or `tauri dev` would lose the build it is running from.
#[cfg(target_os = "macos")]
fn is_dev_build(bundle: &Path) -> bool {
    bundle.to_string_lossy().contains("/src-tauri/target/")
}

/// Gatekeeper runs an app opened from a quarantined location (a downloaded
/// `.dmg`, `~/Downloads`) from a random read-only mount under
/// `/private/var/folders/.../AppTranslocation/`. That path can never be
/// replaced, and it is not where the user wants the app to live anyway.
#[cfg(target_os = "macos")]
fn is_translocated(bundle: &Path) -> bool {
    bundle.to_string_lossy().contains("/AppTranslocation/")
}

/// True when `dir` accepts a new file.
///
/// The only honest test: a permission bit says nothing about a read-only volume
/// or a sandbox, and creating the probe is how Sparkle decides the same thing.
#[cfg(target_os = "macos")]
fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".novion-update-write-test-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(mut file) => {
            let _ = file.write_all(b"ok");
            drop(file);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Picks the `.app` the update should end up in, in order of preference:
///
/// 1. the bundle this build runs from, when its folder is writable — the normal
///    case, and the only one that needs no copy;
/// 2. `/Applications/<name>`, when `/Applications` is writable: the app was
///    opened from the `.dmg` or from `~/Downloads`, and the user wants it in the
///    place Spotlight and Launchpad show;
/// 3. `~/Applications/<name>`, which needs no administrator password.
///
/// `None` means nothing is writable, which is the only case that still has to
/// hand the file to the user.
#[cfg(target_os = "macos")]
fn choose_install_target(
    current: &Path,
    replace_in_place: bool,
    applications: &Path,
    user_applications: &Path,
    writable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if replace_in_place {
        return Some(current.to_path_buf());
    }
    let name = current
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "Novion.app".into());
    for dir in [applications, user_applications] {
        if !writable(dir) {
            continue;
        }
        let candidate = dir.join(&name);
        // the running bundle is never a candidate here: it was rejected above
        if candidate == current {
            continue;
        }
        return Some(candidate);
    }
    None
}

#[cfg(target_os = "macos")]
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The helper that does the swap. It runs after the app has quit, so it must
/// survive on its own: every step is logged, every failure reopens the app that
/// is currently installed, and the extracted bundle is version-checked before
/// it is allowed to replace anything.
#[cfg(target_os = "macos")]
const INSTALL_SCRIPT: &str = r#"#!/bin/sh
# Written by Novion; deleted when it finishes. Log: @@LOG@@
set -u
LOG=@@LOG@@
BUNDLE=@@BUNDLE@@
SOURCE=@@SOURCE@@
DMG=@@DMG@@
EXPECTED=@@EXPECTED@@
APP_PID=@@PID@@
MNT=""
STAGED="$BUNDLE.novion-new"
BACKUP="$BUNDLE.novion-old"

say() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG"; }

open_app() {
  if [ -d "$BUNDLE" ] && open "$BUNDLE" >> "$LOG" 2>&1; then return 0; fi
  if [ -d "$SOURCE" ] && open "$SOURCE" >> "$LOG" 2>&1; then return 0; fi
  say "could not reopen the app; it has to be started by hand"
  return 1
}

detach() {
  if [ -n "$MNT" ]; then
    hdiutil detach -force -quiet "$MNT" >> "$LOG" 2>&1 || true
    rmdir "$MNT" >/dev/null 2>&1 || true
    MNT=""
  fi
}

fail() {
  say "FAILED: $*"
  [ -d "$STAGED" ] && rm -rf "$STAGED"
  detach
  open_app
  exit 1
}

say "--- installing $EXPECTED into $BUNDLE (running from $SOURCE)"

waited=0
while kill -0 "$APP_PID" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 900 ]; then fail "the app was still running after three minutes"; fi
  sleep 0.2
done
say "the app has quit"

MNT=$(mktemp -d /tmp/novion-update.XXXXXX) || fail "no mount point could be created"
mounted=0
for attempt in 1 2 3; do
  if hdiutil attach -nobrowse -noverify -quiet -mountpoint "$MNT" "$DMG" >> "$LOG" 2>&1; then
    mounted=1
    break
  fi
  say "mounting the downloaded dmg failed (attempt $attempt)"
  sleep 1
done
[ "$mounted" = 1 ] || fail "the downloaded dmg could not be mounted"

SRC=$(find "$MNT" -maxdepth 1 -name '*.app' -print 2>/dev/null | head -n 1)
[ -n "${SRC:-}" ] || fail "the dmg contains no .app"

say "unpacking $SRC"
rm -rf "$STAGED"
ditto "$SRC" "$STAGED" >> "$LOG" 2>&1 || fail "the new bundle could not be copied out of the dmg"
detach

VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$STAGED/Contents/Info.plist" 2>/dev/null)
if [ "${VERSION:-}" != "$EXPECTED" ]; then
  fail "the dmg holds version '${VERSION:-unknown}', expected '$EXPECTED'"
fi
[ -d "$STAGED/Contents/MacOS" ] || fail "the new bundle has no Contents/MacOS"
# the download came from the release CDN, not from Safari: nothing to quarantine
xattr -dr com.apple.quarantine "$STAGED" >> "$LOG" 2>&1 || true

# Swapped through a sibling directory: copying straight over the running app
# would leave files from the old version behind, and removing it first would
# leave the user with nothing if the copy failed.
rm -rf "$BACKUP"
if [ -d "$BUNDLE" ]; then
  mv "$BUNDLE" "$BACKUP" >> "$LOG" 2>&1 || fail "the current app could not be moved aside"
fi
if ! mv "$STAGED" "$BUNDLE" >> "$LOG" 2>&1; then
  [ -d "$BACKUP" ] && mv "$BACKUP" "$BUNDLE" >> "$LOG" 2>&1
  fail "the new app could not be moved into place"
fi
rm -rf "$BACKUP"
rm -f "$DMG" >> "$LOG" 2>&1 || true
say "installed $EXPECTED into $BUNDLE"

# The copy the app was started from (a mounted dmg, ~/Downloads) is stale now.
# Moving it to the Trash keeps one Novion on the Mac and stays undoable.
if [ "$SOURCE" != "$BUNDLE" ] && [ -d "$SOURCE" ]; then
  trash="$HOME/.Trash"
  if mkdir -p "$trash" 2>/dev/null \
    && mv "$SOURCE" "$trash/$(basename "$SOURCE")-$(date +%s)" >> "$LOG" 2>&1; then
    say "moved the old copy to the Trash: $SOURCE"
  else
    say "left the old copy in place: $SOURCE"
  fi
fi

open_app
rm -f "$0" 2>/dev/null || true
exit 0
"#;

#[cfg(target_os = "macos")]
fn macos_install<R: Runtime>(
    app: &AppHandle<R>,
    archive: &Path,
    expected: &str,
    log: &str,
) -> AppResult<InstallOutcome> {
    let bundle = bundle_root().ok_or_else(|| {
        AppError::new("update_unavailable", "当前不是从 .app 启动的，无法自动安装更新")
    })?;

    let manual = |app: &AppHandle<R>| -> AppResult<InstallOutcome> {
        reveal(app, archive)?;
        Ok(InstallOutcome {
            mode: "manual",
            path: archive.to_string_lossy().to_string(),
            installed_to: String::new(),
            previous: String::new(),
            log_path: log.to_string(),
        })
    };

    // a developer build is not the copy the user runs: hand the file over
    if is_dev_build(&bundle) {
        write_log(app, "refusing to replace a developer build in src-tauri/target");
        return manual(app);
    }

    // Translocation is why "the update does nothing" used to happen: the app
    // runs from a read-only mount, so the in-place swap cannot work.
    let in_place = !is_translocated(&bundle)
        && bundle.parent().map(dir_is_writable).unwrap_or(false);
    let applications = PathBuf::from("/Applications");
    let user_applications = app
        .path()
        .home_dir()
        .map(|home| home.join("Applications"))
        .unwrap_or_else(|_| PathBuf::from("Applications"));
    // created up front so the writability probe below means something
    let _ = std::fs::create_dir_all(&user_applications);

    let Some(target) = choose_install_target(
        &bundle,
        in_place,
        &applications,
        &user_applications,
        dir_is_writable,
    ) else {
        write_log(app, "no writable location; the user installs by hand");
        return manual(app);
    };

    let previous = if target == bundle {
        String::new()
    } else {
        write_log(
            app,
            &format!(
                "the app runs from {} (read-only or translocated); installing into {}",
                bundle.display(),
                target.display()
            ),
        );
        bundle.to_string_lossy().to_string()
    };

    write_pending(
        app,
        &PendingUpdate {
            attempted: expected.to_string(),
            installed_to: target.to_string_lossy().to_string(),
            previous: previous.clone(),
            log_path: log.to_string(),
            at: crate::models::now_ms(),
        },
    );

    let script = fill(
        INSTALL_SCRIPT,
        &[
            ("@@LOG@@", sh_quote(log)),
            ("@@BUNDLE@@", sh_quote(&target.to_string_lossy())),
            ("@@SOURCE@@", sh_quote(&bundle.to_string_lossy())),
            ("@@DMG@@", sh_quote(&archive.to_string_lossy())),
            ("@@EXPECTED@@", sh_quote(expected)),
            ("@@PID@@", std::process::id().to_string()),
        ],
    );

    let script_path = std::env::temp_dir().join(format!("novion-update-{}.sh", std::process::id()));
    if let Err(err) = std::fs::write(&script_path, script) {
        clear_pending(app);
        return Err(AppError::new(
            "update_write_failed",
            format!("写入安装脚本失败：{err}"),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700));
    }
    write_log(app, &format!("helper script: {}", script_path.display()));

    // `/bin/sh script` rather than executing it: the file lives in the temp
    // directory, which some setups mount noexec.
    let spawned = Command::new("/bin/sh")
        .arg(&script_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Err(err) = spawned {
        let _ = std::fs::remove_file(&script_path);
        clear_pending(app);
        return Err(AppError::new(
            "update_install_failed",
            format!("启动安装脚本失败：{err}"),
        ));
    }

    exit_for_install(app);

    Ok(InstallOutcome {
        mode: "restart",
        path: archive.to_string_lossy().to_string(),
        installed_to: target.to_string_lossy().to_string(),
        previous,
        log_path: log.to_string(),
    })
}

/// Quits so the helper can replace the files it is running from, but not before
/// the invoke reply has reached the webview.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn exit_for_install<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(INSTALL_EXIT_MS)).await;
        handle.exit(0);
    });
}

// -------------------------------------------------------------------- Windows

/// The helper for `bundle.nsis`. Two things make or break it:
///
/// * NSIS cannot replace a running executable, so it waits for this process
///   *and* the WebView2 children to be gone. The previous version launched the
///   installer in the background and reopened the app immediately, so the old
///   executable was running again before the installer could replace it — which
///   is exactly "it restarts, and it is still the old version".
/// * `/D=<dir>` must be the last parameter and must not be quoted, so the
///   installer call goes through a one-line `.bat` instead of `cmd /c` from
///   PowerShell, where the quoting rules quietly break paths with spaces.
///
/// It then checks that the file version actually changed, and reopens the app
/// either way: a failed update must not leave the user without one.
#[cfg(target_os = "windows")]
const INSTALL_SCRIPT_PS1: &str = r#"# Written by Novion; deleted when it finishes.
$ErrorActionPreference = 'Stop'
$Log = @@LOG@@
$AppExe = @@EXE@@
$AppDir = @@DIR@@
$AppImage = @@IMAGE@@
$Installer = @@INSTALLER@@
$Expected = @@EXPECTED@@
$AppPid = @@PID@@
$BatPath = Join-Path ([IO.Path]::GetTempPath()) ('novion-install-' + [Guid]::NewGuid().ToString('N') + '.bat')

function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') $Message"
  try { Add-Content -LiteralPath $Log -Value $line -Encoding UTF8 } catch { }
}

function Start-App {
  if (Test-Path -LiteralPath $AppExe) {
    try { Start-Process -FilePath $AppExe | Out-Null; return $true } catch { }
  }
  return $false
}

function Get-AppVersion {
  $item = Get-Item -LiteralPath $AppExe -ErrorAction SilentlyContinue
  if (-not $item) { return '' }
  return [string]$item.VersionInfo.ProductVersion
}

function Test-Writable([string]$Dir) {
  try {
    $probe = Join-Path $Dir ('.novion-write-test-' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($probe, 'ok')
    Remove-Item -LiteralPath $probe -Force
    return $true
  } catch { return $false }
}

function Wait-ForExit {
  for ($i = 0; $i -lt 900; $i++) {
    $byId = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
    $byName = Get-Process -Name $AppImage -ErrorAction SilentlyContinue
    if (-not $byId -and -not $byName) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

Write-Log "--- installing $Expected into $AppDir"

if (-not (Wait-ForExit)) { Write-Log 'the app was still running after three minutes; installing anyway' }
Write-Log 'the app has quit'

if (-not (Test-Path -LiteralPath $Installer)) {
  Write-Log "FAILED: the downloaded installer is gone: $Installer"
  Start-App | Out-Null
  exit 1
}

$before = Get-AppVersion
Write-Log "installed version before: $before"

# cmd reads a .bat in the OEM code page, not in UTF-8
$oem = [Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
$bat = '@echo off' + "`r`n" + '"' + $Installer + '" /S /D=' + $AppDir + "`r`n"
[IO.File]::WriteAllText($BatPath, $bat, [Text.Encoding]::GetEncoding($oem))

$elevate = -not (Test-Writable $AppDir)
if ($elevate) { Write-Log 'the program folder is not writable; asking for administrator rights' }

$installerName = [IO.Path]::GetFileNameWithoutExtension($Installer)
$installed = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    if ($elevate) {
      # `-Wait` is ignored together with `-Verb`, so the process is polled
      Start-Process -FilePath $BatPath -Verb RunAs | Out-Null
      Write-Log "attempt $attempt started elevated; waiting for the installer"
      $saw = $false
      for ($i = 0; $i -lt 600; $i++) {
        if (Get-Process -Name $installerName -ErrorAction SilentlyContinue) { $saw = $true; break }
        Start-Sleep -Milliseconds 200
      }
      if (-not $saw) { Write-Log "attempt $attempt never started (administrator prompt refused?)" }
      for ($i = 0; $i -lt 900; $i++) {
        if (-not (Get-Process -Name $installerName -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 200
      }
    } else {
      $proc = Start-Process -FilePath $BatPath -Wait -PassThru -WindowStyle Hidden
      Write-Log "installer attempt $attempt exited with code $($proc.ExitCode)"
    }
    # a silent NSIS install can return before the last file lands
    for ($i = 0; $i -lt 100; $i++) {
      if ((Get-AppVersion) -ne $before) { $installed = $true; break }
      Start-Sleep -Milliseconds 200
    }
    if ($installed) { break }
    Write-Log "attempt $attempt finished but the version is still $before"
  } catch {
    Write-Log "installer attempt $attempt failed: $($_.Exception.Message)"
  }
  Start-Sleep -Milliseconds 500
}

Remove-Item -LiteralPath $BatPath -Force -ErrorAction SilentlyContinue

$after = Get-AppVersion
Write-Log "installed version after: $after (expected $Expected)"
if ($after -eq '') {
  Write-Log 'the executable is missing after the install'
} elseif (-not $after.StartsWith($Expected)) {
  Write-Log 'the installed version does not match the update; the next launch reports it'
}

if (Start-App) { Write-Log 'reopened the app' } else { Write-Log 'could not reopen the app' }
Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
"#;


#[cfg(target_os = "windows")]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
fn windows_install<R: Runtime>(
    app: &AppHandle<R>,
    archive: &Path,
    expected: &str,
    log: &str,
) -> AppResult<InstallOutcome> {
    let exe = std::env::current_exe().map_err(|err| AppError::io("找不到当前程序", err))?;
    let install_dir = exe
        .parent()
        .ok_or_else(|| AppError::new("update_unavailable", "找不到程序所在目录"))?
        .to_path_buf();
    // `Get-Process -Name` takes the image name without `.exe`
    let image = exe
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "Novion".to_string());

    write_log(
        app,
        &format!(
            "installing {expected} into {} (running from {})",
            install_dir.display(),
            exe.display()
        ),
    );
    write_pending(
        app,
        &PendingUpdate {
            attempted: expected.to_string(),
            installed_to: install_dir.to_string_lossy().to_string(),
            previous: String::new(),
            log_path: log.to_string(),
            at: crate::models::now_ms(),
        },
    );

    let script = fill(
        INSTALL_SCRIPT_PS1,
        &[
            ("@@LOG@@", ps_quote(log)),
            ("@@EXE@@", ps_quote(&exe.to_string_lossy())),
            ("@@DIR@@", ps_quote(&install_dir.to_string_lossy())),
            ("@@IMAGE@@", ps_quote(&image)),
            ("@@INSTALLER@@", ps_quote(&archive.to_string_lossy())),
            ("@@EXPECTED@@", ps_quote(expected)),
            ("@@PID@@", std::process::id().to_string()),
        ],
    );

    let script_path = std::env::temp_dir().join(format!("novion-update-{}.ps1", std::process::id()));
    // UTF-8 with BOM: PowerShell 5.1 reads a BOM-less script as ANSI and would
    // mangle the paths.
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(script.as_bytes());
    if let Err(err) = std::fs::write(&script_path, bytes) {
        clear_pending(app);
        return Err(AppError::new(
            "update_write_failed",
            format!("写入安装脚本失败：{err}"),
        ));
    }

    let powershell = std::env::var("SystemRoot")
        .map(|root| format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))
        .unwrap_or_else(|_| "powershell.exe".to_string());

    let spawned = Command::new(&powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Err(err) = spawned {
        let _ = std::fs::remove_file(&script_path);
        clear_pending(app);
        return Err(AppError::new(
            "update_install_failed",
            format!("启动安装脚本失败：{err}"),
        ));
    }

    exit_for_install(app);

    Ok(InstallOutcome {
        mode: "restart",
        path: archive.to_string_lossy().to_string(),
        installed_to: install_dir.to_string_lossy().to_string(),
        previous: String::new(),
        log_path: log.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> Asset {
        Asset {
            name: name.to_string(),
            size: 10,
            browser_download_url: format!("https://github.com/ilemon18/novion/releases/download/v1/{name}"),
        }
    }

    #[test]
    fn version_compare_handles_tags_and_prereleases() {
        assert!(is_newer("0.0.2", "0.0.1"));
        assert!(is_newer("v0.1.0", "0.0.9"));
        assert!(!is_newer("0.0.1", "0.0.1"));
        assert!(!is_newer("0.0.1", "0.1.0"));
        assert!(is_newer("1.0.0", "1.0.0-beta.1"));
        assert!(!is_newer("1.0.0-beta.2", "1.0.0"));
    }

    #[test]
    fn asset_pick_follows_the_platform() {
        let assets = vec![
            asset("novion-macos-0.0.2.dmg"),
            asset("novion-win-0.0.2.exe"),
            asset("source.tar.gz"),
        ];
        assert_eq!(
            pick_asset(&assets, Platform::Macos).map(|a| a.name.as_str()),
            Some("novion-macos-0.0.2.dmg")
        );
        assert_eq!(
            pick_asset(&assets, Platform::Windows).map(|a| a.name.as_str()),
            Some("novion-win-0.0.2.exe")
        );
        assert!(pick_asset(&assets, Platform::Other).is_none());
    }

    #[test]
    fn asset_pick_falls_back_to_the_extension() {
        let assets = vec![asset("Novion-0.0.2.dmg")];
        assert_eq!(
            pick_asset(&assets, Platform::Macos).map(|a| a.name.as_str()),
            Some("Novion-0.0.2.dmg")
        );
        assert!(pick_asset(&assets, Platform::Windows).is_none());
    }

    #[test]
    fn only_github_https_urls_are_trusted() {
        assert!(trusted_url(
            "https://github.com/ilemon18/novion/releases/download/v1/x.dmg"
        ));
        assert!(trusted_url("https://objects.githubusercontent.com/x.dmg"));
        assert!(!trusted_url("http://github.com/x.dmg"));
        assert!(!trusted_url("https://example.com/x.dmg"));
        assert!(!trusted_url("file:///tmp/x.dmg"));
        assert!(!trusted_url("not a url"));
    }

    #[test]
    fn file_names_cannot_escape_the_cache_directory() {
        assert_eq!(sanitize_file_name("../../evil.sh"), "....evil.sh");
        assert_eq!(sanitize_file_name("novion-macos-0.0.2.dmg"), "novion-macos-0.0.2.dmg");
        assert_eq!(sanitize_file_name(""), "novion-update");
    }

    /// Shape of the real v0.0.1 release (names and sizes taken from GitHub).
    const RELEASE_JSON: &str = r#"{
        "tag_name": "v0.0.1",
        "name": "Novion v0.0.1",
        "body": "first release",
        "html_url": "https://github.com/ilemon18/novion/releases/tag/v0.0.1",
        "published_at": "2026-11-11T09:00:00Z",
        "draft": false,
        "prerelease": false,
        "assets": [
            {
                "name": "novion-macos-0.0.1.dmg",
                "size": 12537083,
                "browser_download_url": "https://github.com/ilemon18/novion/releases/download/v0.0.1/novion-macos-0.0.1.dmg"
            },
            {
                "name": "novion-win-0.0.1.exe",
                "size": 9000000,
                "browser_download_url": "https://github.com/ilemon18/novion/releases/download/v0.0.1/novion-win-0.0.1.exe"
            }
        ]
    }"#;

    fn release_fixture() -> Release {
        serde_json::from_str(RELEASE_JSON).expect("fixture parses")
    }

    #[test]
    fn a_published_release_is_parsed_and_compared() {
        // same version: no update, but the release itself is visible
        let same = info_from_release(release_fixture(), "0.0.1", Platform::Macos);
        assert!(same.has_release);
        assert!(!same.available);
        assert_eq!(same.latest, "0.0.1");
        assert_eq!(same.asset_name, "novion-macos-0.0.1.dmg");
        assert_eq!(same.asset_size, 12_537_083);
        assert_eq!(same.page_url, "https://github.com/ilemon18/novion/releases/tag/v0.0.1");

        // an older build must see it as an update, with the right bundle
        let newer = info_from_release(release_fixture(), "0.0.0", Platform::Macos);
        assert!(newer.available);
        assert_eq!(newer.asset_name, "novion-macos-0.0.1.dmg");

        let windows = info_from_release(release_fixture(), "0.0.0", Platform::Windows);
        assert!(windows.available);
        assert_eq!(windows.asset_name, "novion-win-0.0.1.exe");
    }

    #[test]
    fn a_release_without_a_bundle_for_this_platform_is_not_offerable() {
        let info = info_from_release(release_fixture(), "0.0.0", Platform::Other);
        assert!(info.has_release);
        assert!(!info.available);
        assert!(info.download_url.is_empty());
    }

    #[test]
    fn a_release_pointing_outside_github_is_refused() {
        let mut release = release_fixture();
        release.assets[0].browser_download_url = "https://example.com/novion.dmg".to_string();
        let info = info_from_release(release, "0.0.0", Platform::Macos);
        assert!(!info.available, "untrusted host must never be offered");
        assert!(info.asset_name.is_empty() || info.download_url.is_empty());
    }

    /// `scripts/make-latest-json.mjs` output for v0.0.2.
    const MANIFEST_JSON: &str = r#"{
        "version": "0.0.2",
        "tag": "v0.0.2",
        "pageUrl": "https://github.com/ilemon18/novion/releases/tag/v0.0.2",
        "publishedAt": "",
        "assets": {
            "macos": {
                "name": "novion-macos-0.0.2.dmg",
                "url": "https://github.com/ilemon18/novion/releases/download/v0.0.2/novion-macos-0.0.2.dmg",
                "size": 12537083,
                "sha256": "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"
            },
            "windows": {
                "name": "novion-win-0.0.2.exe",
                "url": "https://github.com/ilemon18/novion/releases/download/v0.0.2/novion-win-0.0.2.exe",
                "size": 9000000,
                "sha256": "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
            }
        }
    }"#;

    fn manifest_fixture() -> Manifest {
        serde_json::from_str(MANIFEST_JSON).expect("manifest fixture parses")
    }

    #[test]
    fn the_manifest_drives_the_decision_without_the_api() {
        let newer = info_from_manifest(manifest_fixture(), "0.0.1", Platform::Macos);
        assert!(newer.has_release);
        assert!(newer.available);
        assert_eq!(newer.latest, "0.0.2");
        assert_eq!(newer.asset_name, "novion-macos-0.0.2.dmg");
        assert_eq!(newer.asset_size, 12_537_083);
        // digests are normalised so the comparison is case-insensitive
        assert_eq!(
            newer.checksum,
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        );

        let windows = info_from_manifest(manifest_fixture(), "0.0.1", Platform::Windows);
        assert_eq!(windows.asset_name, "novion-win-0.0.2.exe");

        // already running the newest version: nothing to offer
        let same = info_from_manifest(manifest_fixture(), "0.0.2", Platform::Macos);
        assert!(same.has_release);
        assert!(!same.available);
        assert_eq!(same.asset_name, "novion-macos-0.0.2.dmg");
    }

    #[test]
    fn a_manifest_without_the_platform_bundle_is_not_offerable() {
        let info = info_from_manifest(manifest_fixture(), "0.0.1", Platform::Other);
        assert!(info.has_release);
        assert!(!info.available);
        assert!(info.download_url.is_empty() && info.checksum.is_empty());
    }

    #[test]
    fn a_manifest_pointing_outside_github_is_refused() {
        let mut manifest = manifest_fixture();
        manifest.assets.macos = Some(ManifestAsset {
            name: "novion-macos-0.0.2.dmg".to_string(),
            url: "https://example.com/novion.dmg".to_string(),
            size: 10,
            sha256: "abc".to_string(),
        });
        let info = info_from_manifest(manifest, "0.0.1", Platform::Macos);
        assert!(!info.available);
        assert!(info.download_url.is_empty() && info.asset_name.is_empty() && info.checksum.is_empty());
    }

    #[test]
    fn an_empty_manifest_version_reports_nothing() {
        let manifest: Manifest = serde_json::from_str("{}").expect("empty object parses");
        let info = info_from_manifest(manifest, "0.0.2", Platform::Macos);
        assert!(!info.has_release);
        assert!(!info.available);
        assert_eq!(info.latest, "0.0.2");
    }

    #[test]
    fn a_version_marker_matches_with_or_without_the_v_prefix() {
        assert!(versions_equal("0.0.2", "v0.0.2"));
        assert!(versions_equal(" v0.0.2 ", "0.0.2"));
        assert!(!versions_equal("0.0.1", "0.0.2"));
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn script_placeholders_are_substituted() {
        let out = fill(
            "open @@BUNDLE@@; echo '@@BUNDLE@@'",
            &[("@@BUNDLE@@", "'/Applications/Novion.app'".to_string())],
        );
        assert!(!out.contains("@@"));
        assert_eq!(out.matches("/Applications/Novion.app").count(), 2);
    }

    /// The three places an update may land, and what each case must pick.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_install_target_follows_what_is_writable() {
        let current = Path::new("/Applications/Novion.app");
        let apps = Path::new("/Applications");
        let home_apps = Path::new("/Users/me/Applications");

        // the normal case: replace what is running
        assert_eq!(
            choose_install_target(current, true, apps, home_apps, |_| true),
            Some(current.to_path_buf())
        );

        // opened from the dmg, /Applications writable: install there, not back
        // onto the read-only mount
        let from_volume = Path::new("/Volumes/Novion/Novion.app");
        assert_eq!(
            choose_install_target(from_volume, false, apps, home_apps, |_| true),
            Some(PathBuf::from("/Applications/Novion.app"))
        );

        // /Applications not writable (managed Mac): the home folder needs no
        // password, so the update still installs
        assert_eq!(
            choose_install_target(from_volume, false, apps, home_apps, |dir| dir
                != apps),
            Some(PathBuf::from("/Users/me/Applications/Novion.app"))
        );

        // nothing writable: the caller hands the file to the user instead
        assert_eq!(
            choose_install_target(from_volume, false, apps, home_apps, |_| false),
            None
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_install_target_never_collides_with_the_running_bundle() {
        // a folder that already holds the running bundle is skipped: it was
        // rejected above, and installing back onto it would be a no-op
        assert_eq!(
            choose_install_target(
                Path::new("/Volumes/Novion/Novion.app"),
                false,
                Path::new("/Volumes/Novion"),
                Path::new("/Users/me/Applications"),
                |_| true
            ),
            Some(PathBuf::from("/Users/me/Applications/Novion.app"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_translocated_bundle_is_detected() {
        assert!(is_translocated(Path::new(
            "/private/var/folders/xy/T/AppTranslocation/1F2E/d/Novion.app"
        )));
        assert!(!is_translocated(Path::new("/Applications/Novion.app")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_developer_build_is_never_replaced() {
        assert!(is_dev_build(Path::new(
            "/Users/me/novion/src-tauri/target/debug/bundle/macos/Novion.app"
        )));
        assert!(!is_dev_build(Path::new("/Applications/Novion.app")));
    }
}
