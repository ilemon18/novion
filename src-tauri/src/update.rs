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
//! (a detached helper script swaps the `.app` once this process has exited).
//!
//! Security: only `https` URLs on GitHub hosts are downloaded, the expected
//! byte count *and* the SHA-256 from the manifest are verified, and nothing is
//! executed before the user asks for it. There is no code-signing check yet —
//! see the note in `release/README.md`.

#[cfg(target_os = "macos")]
use std::io::Write;
use std::path::{Path, PathBuf};
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
/// How long the helper script waits for this process to disappear before it
/// gives up (it is spawned right before the app exits, so this is generous).
const INSTALL_EXIT_MS: u64 = 600;

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
    pub path: String,
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

/// Installs the downloaded bundle. On macOS a detached script replaces the
/// running `.app` after this process exits and relaunches it.
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, UpdateState>,
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

    #[cfg(target_os = "macos")]
    {
        return macos_install(&app, &archive);
    }

    #[cfg(target_os = "windows")]
    {
        return windows_install(&app, &archive);
    }

    #[allow(unreachable_code)]
    {
        reveal(&app, &archive)?;
        Ok(InstallOutcome {
            mode: "manual",
            path: archive.to_string_lossy().to_string(),
        })
    }
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

/// True when the bundle can be replaced in place (not a read-only volume, not
/// the developer build under `src-tauri/target`).
#[cfg(target_os = "macos")]
fn bundle_is_replaceable(bundle: &Path) -> bool {
    let normalized = bundle.to_string_lossy();
    if normalized.contains("/src-tauri/target/") {
        return false;
    }
    let Some(parent) = bundle.parent() else {
        return false;
    };
    let probe = parent.join(".novion-update-write-test");
    match std::fs::File::create(&probe) {
        Ok(mut file) => {
            let _ = file.write_all(b"ok");
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn macos_install<R: Runtime>(app: &AppHandle<R>, archive: &Path) -> AppResult<InstallOutcome> {
    let bundle = bundle_root().ok_or_else(|| {
        AppError::new("update_unavailable", "当前不是从 .app 启动的，无法自动安装更新")
    })?;

    // a build under `src-tauri/target` or on a read-only volume: hand the file
    // to the user instead of pretending to install it
    if !bundle_is_replaceable(&bundle) {
        reveal(app, archive)?;
        return Ok(InstallOutcome {
            mode: "manual",
            path: archive.to_string_lossy().to_string(),
        });
    }

    // The bundle is swapped through a sibling directory: copying straight over
    // the running app would leave files from the old version behind, and
    // removing it first would leave the user with nothing if the copy fails.
    let script = format!(
        r#"#!/bin/sh
set -e
pid={pid}
bundle={bundle}
dmg={dmg}
staged="$bundle.novion-new"
backup="$bundle.novion-old"
mnt="$(mktemp -d /tmp/novion-update.XXXXXX)"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg" >/dev/null
src="$(find "$mnt" -maxdepth 1 -name '*.app' | head -n 1)"
if [ -z "$src" ]; then
  hdiutil detach -quiet "$mnt" >/dev/null 2>&1 || true
  exit 1
fi
rm -rf "$staged"
ditto "$src" "$staged"
xattr -dr com.apple.quarantine "$staged" >/dev/null 2>&1 || true
hdiutil detach -quiet "$mnt" >/dev/null 2>&1 || true
rmdir "$mnt" >/dev/null 2>&1 || true
rm -rf "$backup"
if [ -d "$bundle" ]; then mv "$bundle" "$backup"; fi
if ! mv "$staged" "$bundle"; then
  if [ -d "$backup" ]; then mv "$backup" "$bundle"; fi
  exit 1
fi
rm -rf "$backup"
rm -f "$dmg"
open "$bundle"
"#,
        pid = std::process::id(),
        bundle = sh_quote(&bundle.to_string_lossy()),
        dmg = sh_quote(&archive.to_string_lossy()),
    );

    let script_path = std::env::temp_dir().join(format!("novion-update-{}.sh", std::process::id()));
    let mut file = std::fs::File::create(&script_path)
        .map_err(|err| AppError::io("写入安装脚本失败", err))?;
    file.write_all(script.as_bytes())
        .map_err(|err| AppError::io("写入安装脚本失败", err))?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700));
    }

    Command::new("/bin/sh")
        .arg(&script_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::io("启动安装脚本失败", err))?;

    // give the invoke result time to reach the webview, then quit so the
    // script can swap the bundle out from under us
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(INSTALL_EXIT_MS)).await;
        handle.exit(0);
    });

    Ok(InstallOutcome {
        mode: "restart",
        path: archive.to_string_lossy().to_string(),
    })
}

// -------------------------------------------------------------------- Windows

#[cfg(target_os = "windows")]
fn windows_install<R: Runtime>(app: &AppHandle<R>, archive: &Path) -> AppResult<InstallOutcome> {
    let exe = std::env::current_exe().ok();
    let script = format!(
        "@echo off\r\n\
         :wait\r\n\
         tasklist /FI \"PID eq {pid}\" | find \"{pid}\" >nul\r\n\
         if not errorlevel 1 (\r\n\
         \x20 timeout /t 1 /nobreak >nul\r\n\
         \x20 goto wait\r\n\
         )\r\n\
         start \"\" \"{installer}\" /S\r\n\
         if exist \"{exe}\" start \"\" \"{exe}\"\r\n\
         del \"%~f0\"\r\n",
        pid = std::process::id(),
        installer = archive.to_string_lossy(),
        exe = exe
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    );
    let script_path = std::env::temp_dir().join(format!("novion-update-{}.bat", std::process::id()));
    std::fs::write(&script_path, script).map_err(|err| AppError::io("写入安装脚本失败", err))?;

    Command::new("cmd")
        .args(["/C", &script_path.to_string_lossy()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| AppError::io("启动安装脚本失败", err))?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(INSTALL_EXIT_MS)).await;
        handle.exit(0);
    });

    Ok(InstallOutcome {
        mode: "restart",
        path: archive.to_string_lossy().to_string(),
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
}
