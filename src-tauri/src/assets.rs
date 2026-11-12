use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::atomic::write_atomic;
use crate::error::{AppError, AppResult};
use crate::models::{AssetRef, DocFile};
use crate::paths::{extension_of, short_id, to_display, workspace_root, Paths};

const MAX_ASSET_BYTES: usize = 32 * 1024 * 1024;

/// Decodes `%XX` escapes so a percent-encoded asset URL can be matched like the
/// on-disk form. Invalid escapes are kept literally.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Normalises an image `src`/`alt` into a workspace-relative asset path.
/// Accepts what the editor holds (`asset://localhost/.../assets/x.png`,
/// `http://asset.localhost/...`) as well as the on-disk form (`assets/x.png`).
///
/// WebView2 hands back `C%3A%5CUsers%5C...%5Cassets%5Cx.png`, so the input is
/// percent-decoded and its separators are normalised before matching; without
/// that the image would never be exported, garbage-collected or synced.
fn normalize_asset_ref(raw: &str, must_start: bool) -> Option<String> {
    let text = percent_decode(raw.trim()).replace('\\', "/");
    if must_start && !text.starts_with("assets/") {
        return None;
    }
    let at = text.find("assets/")?;
    let rel = text[at..].split(['?', '#']).next()?.trim_end_matches('/');
    if rel.len() <= "assets/".len() || rel.contains("..") {
        return None;
    }
    Some(rel.to_string())
}

/// Every `assets/...` path referenced by an image node in a document body.
pub fn collect_asset_refs(content: &Value) -> Vec<String> {
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Array(items) => {
                for item in items {
                    walk(item, out);
                }
            }
            Value::Object(map) => {
                let is_image = map.get("type").and_then(Value::as_str) == Some("image");
                if is_image {
                    if let Some(attrs) = map.get("attrs").and_then(Value::as_object) {
                        if let Some(src) = attrs.get("src").and_then(Value::as_str) {
                            if let Some(rel) = normalize_asset_ref(src, false) {
                                out.push(rel);
                            }
                        }
                        if let Some(alt) = attrs.get("alt").and_then(Value::as_str) {
                            if let Some(rel) = normalize_asset_ref(alt, true) {
                                out.push(rel);
                            }
                        }
                    }
                }
                if let Some(content) = map.get("content") {
                    walk(content, out);
                }
            }
            _ => {}
        }
    }

    let mut out = Vec::new();
    walk(content, &mut out);
    out.sort();
    out.dedup();
    out
}

/// Every asset ref that is still referenced by a document other than
/// `exclude_doc` (`""` = no exclusion).
///
/// One pass over `docs/` answers *all* questions at once: the previous version
/// of this helper walked and parsed every document once per candidate ref.
/// Documents whose raw bytes never mention `assets/` are skipped without being
/// deserialised at all.
pub async fn refs_used_elsewhere(
    paths: &Paths,
    exclude_doc: &str,
) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Ok(mut dir) = tokio::fs::read_dir(paths.docs_dir()).await else {
        return out;
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if id == exclude_doc {
            continue;
        }
        let Ok(bytes) = tokio::fs::read(entry.path()).await else {
            continue;
        };
        if !contains_subslice(&bytes, b"assets/") {
            continue;
        }
        let Ok(doc) = serde_json::from_slice::<DocFile>(&bytes) else {
            continue;
        };
        out.extend(collect_asset_refs(&doc.content));
    }
    out
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|chunk| chunk == needle)
}

/// True when a *different* document still points at `rel`.
#[cfg(test)]
pub async fn referenced_elsewhere(paths: &Paths, rel: &str, exclude_doc: &str) -> bool {
    refs_used_elsewhere(paths, exclude_doc).await.contains(rel)
}

/// Removes the given asset files, ignoring missing ones.
pub async fn remove_assets(paths: &Paths, refs: &[String]) {
    for rel in refs {
        if let Ok(file) = paths.asset_file(rel) {
            let _ = tokio::fs::remove_file(file).await;
        }
    }
}

/// Persist pasted / dropped image bytes under `assets/`.
#[tauri::command]
pub async fn save_asset<R: Runtime>(
    app: AppHandle<R>,
    name_hint: String,
    data_base64: String,
) -> AppResult<AssetRef> {
    let paths = Paths::new(workspace_root(&app)?);
    paths.ensure_dirs().await?;

    // accept either raw base64 or a `data:image/png;base64,...` payload
    let trimmed = data_base64.trim();
    let payload = trimmed
        .split_once("base64,")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);

    let bytes = STANDARD
        .decode(payload)
        .map_err(|e| AppError::invalid(format!("图片数据解码失败：{e}")))?;
    if bytes.is_empty() {
        return Err(AppError::invalid("图片内容为空"));
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(AppError::invalid("图片超过 32MB，请压缩后再插入"));
    }

    let ext = extension_of(&name_hint);
    let id = format!("img_{}", short_id());
    let rel = format!("assets/{id}.{ext}");
    let path = paths.root.join(&rel);

    write_atomic(&path, &bytes).await?;
    Ok(AssetRef {
        rel,
        abs: to_display(&path),
    })
}

#[tauri::command]
pub async fn delete_asset<R: Runtime>(app: AppHandle<R>, rel: String) -> AppResult<()> {
    let paths = Paths::new(workspace_root(&app)?);
    let file = paths.asset_file(&rel)?;
    match tokio::fs::remove_file(&file).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::io("删除资源失败", e)),
    }
}

/// Shallow listing, relative to the workspace root (`""` = root, `"docs"`, `"assets"`).
#[tauri::command]
pub async fn list_dir<R: Runtime>(app: AppHandle<R>, rel: String) -> AppResult<Vec<String>> {
    let root = workspace_root(&app)?;
    let rel = rel.trim().replace('\\', "/");
    // `Path::starts_with` compares components without resolving `..`, so the
    // check below cannot catch `root.join("../..")` on its own.
    if rel.split('/').any(|part| part == "..") {
        return Err(AppError::invalid("目录路径越界"));
    }
    let target = if rel.is_empty() {
        root.clone()
    } else {
        root.join(rel.trim_start_matches('/'))
    };

    if !target.starts_with(&root) {
        return Err(AppError::invalid("目录路径越界"));
    }

    let mut reader = tokio::fs::read_dir(&target)
        .await
        .map_err(|e| AppError::io(&format!("读取目录 {} 失败", target.display()), e))?;

    let mut names = Vec::new();
    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|e| AppError::io("遍历目录失败", e))?
    {
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    names.sort();
    Ok(names)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::now_ms;
    use serde_json::json;

    fn doc_with_image(src: &str) -> DocFile {
        DocFile {
            id: "d_test".to_string(),
            title: "t".to_string(),
            created_at: 1,
            updated_at: 2,
            schema_version: 1,
            content: json!({
                "type": "doc",
                "content": [
                    { "type": "image", "attrs": { "src": src, "alt": "assets/x.png" } },
                    { "type": "paragraph", "content": [
                        { "type": "text", "text": "正文" } ] }
                ]
            }),
        }
    }

    fn temp_paths() -> Paths {
        Paths::new(std::env::temp_dir().join(format!(
            "novion-assets-test-{}",
            uuid::Uuid::new_v4().simple()
        )))
    }

    #[test]
    fn asset_refs_accept_both_on_disk_and_webview_forms() {
        let refs = collect_asset_refs(&json!({
            "type": "doc",
            "content": [
                { "type": "image", "attrs": { "src": "assets/a.png" } },
                { "type": "image", "attrs": {
                    "src": "asset://localhost/Users/me/Documents/Novion/assets/b.png" } }
            ]
        }));
        assert_eq!(refs, vec!["assets/a.png", "assets/b.png"]);
    }

    #[test]
    fn asset_refs_survive_windows_encoded_urls() {
        // What WebView2 produces for `C:\Users\me\Documents\Novion\assets\b.png`
        // after `convertFileSrc` percent-encodes it.
        let refs = collect_asset_refs(&json!({
            "type": "doc",
            "content": [
                { "type": "image", "attrs": {
                    "src": "http://asset.localhost/C%3A%5CUsers%5Cme%5CDocuments%5CNovion%5Cassets%5Cb.png" } },
                { "type": "image", "attrs": { "src": "assets\\win.png" } }
            ]
        }));
        assert_eq!(refs, vec!["assets/b.png", "assets/win.png"]);
    }

    #[test]
    fn percent_decode_keeps_invalid_escapes() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[tokio::test]
    async fn refs_used_elsewhere_ignores_the_excluded_document() {
        let paths = temp_paths();
        paths.ensure_dirs().await.unwrap();

        let with_image = doc_with_image("assets/a.png");
        for (id, doc) in [("d_one", &with_image), ("d_two", &with_image)] {
            let mut doc = doc.clone();
            doc.id = id.to_string();
            doc.updated_at = now_ms();
            crate::atomic::write_json_atomic(&paths.doc_file(id).unwrap(), &doc)
                .await
                .unwrap();
        }

        let used = refs_used_elsewhere(&paths, "d_one").await;
        assert!(used.contains("assets/a.png"));
        assert!(referenced_elsewhere(&paths, "assets/a.png", "d_two").await);
        assert!(!referenced_elsewhere(&paths, "assets/missing.png", "").await);

        let _ = tokio::fs::remove_dir_all(&paths.root).await;
    }
}
