use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Folder,
    Doc,
}

/// System folders that always exist at the workspace root and cannot be
/// renamed, deleted or reordered by the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Builtin {
    Completed,
    Trash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: NodeKind,
    pub name: String,
    pub parent_id: Option<String>,
    pub order: i64,
    pub created_at: u64,
    pub updated_at: u64,
    /// set for the two system folders (已归档 / 回收站)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<Builtin>,
    /// parent the node had before it was moved into 已归档 / 回收站; `""` = root
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<u64>,
    /// set when the document is pinned to the top of its folder
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<u64>,
}

impl Node {
    pub fn new(id: String, kind: NodeKind, name: String, parent_id: Option<String>, order: i64) -> Self {
        let now = now_ms();
        Self {
            id,
            kind,
            name,
            parent_id,
            order,
            created_at: now,
            updated_at: now,
            builtin: None,
            origin_parent: None,
            completed_at: None,
            trashed_at: None,
            pinned_at: None,
        }
    }
}

/// The workspace tree. Small enough (< 50KB for thousands of nodes) to be
/// rewritten as a whole on every structural change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub version: u32,
    pub updated_at: u64,
    pub nodes: Vec<Node>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: now_ms(),
            nodes: Vec::new(),
        }
    }
}

/// One document == one file under `docs/`. `content` is TipTap JSON where each
/// top-level node is a block.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocFile {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub schema_version: u32,
    pub content: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDoc {
    pub workspace: Workspace,
    pub doc_id: String,
}

/// Same shape for folders: the fresh tree plus the id of the folder that was
/// just added, so the sidebar can open its inline rename field on that row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedFolder {
    pub workspace: Workspace,
    pub folder_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    /// workspace-relative path stored inside the document, e.g. `assets/img_1a2b.png`
    pub rel: String,
    /// absolute path, used by the webview asset protocol
    pub abs: String,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn empty_doc() -> serde_json::Value {
    serde_json::json!({
        "type": "doc",
        "content": [{ "type": "paragraph" }]
    })
}