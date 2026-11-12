//! TipTap (ProseMirror) JSON → Notion block tree.
//!
//! The converter is synchronous and pure: local images are *not* uploaded here,
//! they are emitted as a placeholder carrying the workspace-relative path
//! (`{"_novion_asset": "assets/x.png"}`). The sync pass walks the tree, uploads
//! the bytes and swaps the placeholder for a real image block, so a failed
//! upload degrades into a readable text block instead of blocking the document.

use serde_json::{json, Map, Value};

/// Notion's hard limit is 2000 characters per rich text item; keep headroom.
const MAX_TEXT_CHUNK: usize = 1800;
/// Notion allows at most 100 rich text items per block.
const MAX_RICH_TEXT_ITEMS: usize = 100;
/// Blocks nested deeper than this are flattened (Notion nests 2 levels per call).
const MAX_DEPTH: usize = 8;
/// Marks the `image` blocks that still need an upload.
pub const ASSET_MARKER: &str = "_novion_asset";

/// One Notion block plus the blocks that belong *inside* it.
pub struct BlockNode {
    /// A block object without a `children` key.
    pub block: Value,
    pub children: Vec<BlockNode>,
}

impl BlockNode {
    fn leaf(block: Value) -> Self {
        Self {
            block,
            children: Vec::new(),
        }
    }
}

/// `{ object: "block", type: <kind>, <kind>: { ..payload } }`
fn block(kind: &str, payload: Value) -> Value {
    let mut map = Map::new();
    map.insert("object".to_string(), Value::String("block".to_string()));
    map.insert("type".to_string(), Value::String(kind.to_string()));
    map.insert(kind.to_string(), payload);
    Value::Object(map)
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Annotations {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    link: Option<String>,
}

impl Annotations {
    fn any(&self) -> bool {
        self.bold || self.italic || self.strike || self.code || self.link.is_some()
    }
}

// ------------------------------------------------------------------- entry

/// Converts a `DocFile.content` value into top-level Notion blocks.
pub fn convert_doc(content: &Value) -> Vec<BlockNode> {
    let mut blocks = convert_nodes(node_content(content), 0);
    if blocks.is_empty() {
        // Notion refuses to create a page whose body is completely empty
        blocks.push(BlockNode::leaf(paragraph(&[])));
    }
    blocks
}

// ---------------------------------------------------------------- dispatch

fn convert_nodes(nodes: &[Value], depth: usize) -> Vec<BlockNode> {
    let mut out = Vec::new();
    for node in nodes {
        out.extend(convert_node(node, depth));
    }
    out
}

fn node_type(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

fn node_content(node: &Value) -> &[Value] {
    // borrowed: cloning the array here made every converted node deep-copy its
    // subtree (a whole-document copy per block)
    node.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn convert_node(node: &Value, depth: usize) -> Vec<BlockNode> {
    let content = node_content(node);
    let nested = depth < MAX_DEPTH;

    match node_type(node) {
        "paragraph" => vec![BlockNode::leaf(paragraph(content))],

        "heading" => {
            let level = node
                .pointer("/attrs/level")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 3);
            let kind = format!("heading_{level}");
            vec![BlockNode::leaf(block(
                &kind,
                json!({ "rich_text": rich_text(content) }),
            ))]
        }

        "bulletList" => list_items(content, "bulleted_list_item", depth),
        "orderedList" => list_items(content, "numbered_list_item", depth),
        "taskList" => list_items(content, "to_do", depth),

        "codeBlock" => {
            let language = node
                .pointer("/attrs/language")
                .and_then(Value::as_str)
                .unwrap_or("");
            vec![BlockNode::leaf(code_block(&plain_text(&content), language))]
        }

        "blockquote" => {
            let rich = match content.first() {
                Some(first) => rich_text_of_node(first),
                None => Vec::new(),
            };
            let rest: Vec<Value> = content.iter().skip(1).cloned().collect();
            vec![BlockNode {
                block: block("quote", json!({ "rich_text": rich })),
                children: if nested {
                    convert_nodes(&rest, depth + 1)
                } else {
                    Vec::new()
                },
            }]
        }

        "horizontalRule" => vec![BlockNode::leaf(block("divider", json!({})))],

        "image" => vec![image_node(node)],

        // `callout` / `toggle` become the native Notion blocks of the same
        // name: the first child is the headline, the rest are its children
        "callout" => {
            let (rich, rest) = split_leading_rich(content);
            vec![BlockNode {
                block: block(
                    "callout",
                    json!({
                        "rich_text": rich,
                        "icon": { "type": "emoji", "emoji": callout_emoji(node) },
                    }),
                ),
                children: if nested {
                    convert_nodes(rest, depth + 1)
                } else {
                    Vec::new()
                },
            }]
        }

        "toggle" => {
            let (rich, rest) = split_leading_rich(content);
            vec![BlockNode {
                block: block("toggle", json!({ "rich_text": rich })),
                children: if nested {
                    convert_nodes(rest, depth + 1)
                } else {
                    Vec::new()
                },
            }]
        }

        "table" => {
            let width = content
                .first()
                .map(|row| node_content(row).len())
                .unwrap_or(1)
                .max(1);
            let rows: Vec<BlockNode> = content
                .iter()
                .map(|row| {
                    let cells: Vec<Value> = node_content(row)
                        .iter()
                        .map(|cell| Value::Array(rich_text_of_node(cell)))
                        .collect();
                    BlockNode::leaf(block("table_row", json!({ "cells": cells })))
                })
                .collect();
            vec![BlockNode {
                block: block(
                    "table",
                    json!({
                        "table_width": width,
                        "has_column_header": true,
                        "has_row_header": false,
                    }),
                ),
                children: rows,
            }]
        }

        // a list item outside a list (defensive): keep its text
        "taskItem" | "listItem" => {
            let (text, rest) = split_leading_paragraph(content);
            vec![BlockNode {
                block: paragraph(&text),
                children: if nested {
                    convert_nodes(rest, depth + 1)
                } else {
                    Vec::new()
                },
            }]
        }

        // unknown wrapper: keep whatever it holds instead of losing content
        _ => {
            if content.is_empty() {
                Vec::new()
            } else {
                vec![BlockNode::leaf(paragraph(&content))]
            }
        }
    }
}

/// First child paragraph as rich text, everything after it as body blocks.
fn split_leading_rich(content: &[Value]) -> (Vec<Value>, &[Value]) {
    match content.split_first() {
        Some((first, rest)) => (rich_text_of_node(first), rest),
        None => (Vec::new(), &[]),
    }
}

fn callout_emoji(node: &Value) -> &'static str {
    match node
        .pointer("/attrs/kind")
        .and_then(Value::as_str)
        .unwrap_or("info")
    {
        "tip" => "💡",
        "warning" => "⚠️",
        "danger" => "⛔",
        _ => "📌",
    }
}

/// One block per list item; the item's leading paragraph becomes its text and
/// everything else (nested lists, quotes, …) becomes its children.
fn list_items(items: &[Value], kind: &str, depth: usize) -> Vec<BlockNode> {
    let mut out = Vec::new();
    for item in items {
        let inner = node_content(item);
        let (text, rest) = split_leading_paragraph(inner);
        let payload = if kind == "to_do" {
            let checked = item
                .pointer("/attrs/checked")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            json!({ "rich_text": text, "checked": checked })
        } else {
            json!({ "rich_text": text })
        };
        out.push(BlockNode {
            block: block(kind, payload),
            children: if depth < MAX_DEPTH {
                convert_nodes(rest, depth + 1)
            } else {
                Vec::new()
            },
        });
    }
    out
}

// --------------------------------------------------------------- rich text

fn paragraph(content: &[Value]) -> Value {
    block("paragraph", json!({ "rich_text": rich_text(content) }))
}

fn code_block(text: &str, language: &str) -> Value {
    let items = if text.trim().is_empty() {
        Vec::new()
    } else {
        chunk_text(text)
            .into_iter()
            .map(|chunk| json!({ "type": "text", "text": { "content": chunk } }))
            .collect::<Vec<_>>()
    };
    block(
        "code",
        json!({ "rich_text": items, "language": notion_language(language) }),
    )
}

fn image_node(node: &Value) -> BlockNode {
    let src = node
        .pointer("/attrs/src")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if src.starts_with("http://") || src.starts_with("https://") {
        return BlockNode::leaf(block(
            "image",
            json!({ "type": "external", "external": { "url": src } }),
        ));
    }
    let rel = src.trim_start_matches('/');
    if rel.starts_with("assets/") && !rel.contains("..") && !rel.contains('\\') {
        return BlockNode::leaf(block("image", json!({ ASSET_MARKER: rel })));
    }
    BlockNode::leaf(placeholder(&format!("Image not synced: {src}")))
}

/// A plain paragraph used when something cannot be represented faithfully.
pub fn placeholder(text: &str) -> Value {
    block(
        "paragraph",
        json!({
            "rich_text": [{
                "type": "text",
                "text": { "content": truncate(text, MAX_TEXT_CHUNK) },
                "annotations": {
                    "bold": false, "italic": true, "strikethrough": false,
                    "underline": false, "code": false, "color": "gray"
                }
            }]
        }),
    )
}

/// Rich text for an inline content array.
pub fn rich_text(nodes: &[Value]) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    walk_inline(nodes, &Annotations::default(), &mut items);
    if items.len() > MAX_RICH_TEXT_ITEMS {
        items.truncate(MAX_RICH_TEXT_ITEMS);
        items.push(json!({ "type": "text", "text": { "content": "…" } }));
    }
    items
}

fn rich_text_of_node(node: &Value) -> Vec<Value> {
    rich_text(node_content(node))
}

fn walk_inline(nodes: &[Value], inherited: &Annotations, out: &mut Vec<Value>) {
    for node in nodes {
        match node_type(node) {
            "text" => {
                let text = node.get("text").and_then(Value::as_str).unwrap_or("");
                let ann = apply_marks(inherited, node);
                push_text(out, text, &ann);
            }
            "hardBreak" => push_text(out, "\n", inherited),
            // inline atoms we do not model: keep whatever text they hold
            _ => {
                let children = node_content(node);
                if children.is_empty() {
                    if let Some(text) = node.get("text").and_then(Value::as_str) {
                        push_text(out, text, inherited);
                    }
                } else {
                    walk_inline(children, inherited, out);
                }
            }
        }
    }
}

fn apply_marks(inherited: &Annotations, node: &Value) -> Annotations {
    let mut ann = inherited.clone();
    let Some(marks) = node.get("marks").and_then(Value::as_array) else {
        return ann;
    };
    for mark in marks {
        match mark.get("type").and_then(Value::as_str).unwrap_or("") {
            "bold" => ann.bold = true,
            "italic" => ann.italic = true,
            "strike" => ann.strike = true,
            "code" => ann.code = true,
            "link" => {
                if let Some(href) = mark.pointer("/attrs/href").and_then(Value::as_str) {
                    let lower = href.to_ascii_lowercase();
                    if lower.starts_with("http://") || lower.starts_with("https://") {
                        ann.link = Some(href.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    ann
}

fn push_text(out: &mut Vec<Value>, text: &str, ann: &Annotations) {
    if text.is_empty() {
        return;
    }
    for chunk in chunk_text(text) {
        let mut text_obj = Map::new();
        text_obj.insert("content".to_string(), Value::String(chunk));
        if let Some(link) = &ann.link {
            text_obj.insert("link".to_string(), json!({ "url": link }));
        }
        let mut item = Map::new();
        item.insert("type".to_string(), Value::String("text".to_string()));
        item.insert("text".to_string(), Value::Object(text_obj));
        if ann.any() {
            item.insert(
                "annotations".to_string(),
                json!({
                    "bold": ann.bold,
                    "italic": ann.italic,
                    "strikethrough": ann.strike,
                    "underline": false,
                    "code": ann.code,
                    "color": "default"
                }),
            );
        }
        out.push(Value::Object(item));
        if out.len() >= MAX_RICH_TEXT_ITEMS {
            return;
        }
    }
}

/// Splits on character boundaries so CJK text never breaks a UTF-8 sequence.
fn chunk_text(text: &str) -> Vec<String> {
    if text.chars().count() <= MAX_TEXT_CHUNK {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut current = String::new();
    let mut count = 0;
    for ch in text.chars() {
        current.push(ch);
        count += 1;
        if count >= MAX_TEXT_CHUNK {
            out.push(std::mem::take(&mut current));
            count = 0;
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Flattens inline nodes into plain text (used for code blocks).
pub fn plain_text(nodes: &[Value]) -> String {
    let mut out = String::new();
    push_plain_text(nodes, &mut out);
    out
}

fn push_plain_text(nodes: &[Value], out: &mut String) {
    for node in nodes {
        match node_type(node) {
            "text" => out.push_str(node.get("text").and_then(Value::as_str).unwrap_or("")),
            "hardBreak" => out.push('\n'),
            _ => push_plain_text(node_content(node), out),
        }
    }
}

/// Returns (rich text of the leading paragraph, remaining nodes).
fn split_leading_paragraph(nodes: &[Value]) -> (Vec<Value>, &[Value]) {
    let Some(first) = nodes.first() else {
        return (Vec::new(), &[]);
    };
    if node_type(first) == "paragraph" {
        let text = rich_text_of_node(first);
        return (text, &nodes[1..]);
    }
    (Vec::new(), nodes)
}

/// Maps editor language hints onto Notion's code block enum.
fn notion_language(raw: &str) -> &'static str {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" => "plain text",
        "ts" | "typescript" => "typescript",
        "tsx" | "jsx" | "js" | "javascript" => "javascript",
        "py" | "python" => "python",
        "rs" | "rust" => "rust",
        "sh" | "bash" | "zsh" | "shell" => "bash",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "html" => "html",
        "xml" => "xml",
        "css" => "css",
        "scss" | "sass" => "scss",
        "md" | "markdown" => "markdown",
        "sql" => "sql",
        "go" | "golang" => "go",
        "java" => "java",
        "kt" | "kotlin" => "kotlin",
        "swift" => "swift",
        "c" => "c",
        "cpp" | "c++" | "cc" => "c++",
        "cs" | "c#" | "csharp" => "c#",
        "rb" | "ruby" => "ruby",
        "php" => "php",
        "diff" | "patch" => "diff",
        "docker" | "dockerfile" => "docker",
        "graphql" => "graphql",
        _ => "plain text",
    }
}

// ------------------------------------------------- Notion → TipTap (pull)

/// Converts Notion blocks into a `DocFile.content` value.
///
/// `blocks` are block objects as returned by `GET /blocks/{id}/children`, with
/// each block's own children already attached under a `children` array by the
/// sync pass. Anything the editor cannot represent degrades to a paragraph, so
/// pulling a page never loses text.
pub fn blocks_to_doc(blocks: &[Value]) -> Value {
    let mut content = convert_block_sequence(blocks);
    if content.is_empty() {
        content.push(json!({ "type": "paragraph" }));
    }
    json!({ "type": "doc", "content": content })
}

fn notion_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

fn payload<'a>(block: &'a Value, kind: &str) -> &'a Value {
    block.get(kind).unwrap_or(&Value::Null)
}

fn block_children(block: &Value) -> &[Value] {
    block
        .get("children")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn rich_array<'a>(block: &'a Value, kind: &str) -> &'a [Value] {
    payload(block, kind)
        .get("rich_text")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn paragraph_of(rich: &[Value]) -> Value {
    let inline = rich_to_inline(rich);
    if inline.is_empty() {
        json!({ "type": "paragraph" })
    } else {
        json!({ "type": "paragraph", "content": inline })
    }
}

/// Groups consecutive list items of the same Notion type into editor lists.
fn convert_block_sequence(blocks: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut index = 0;
    while index < blocks.len() {
        let kind = notion_type(&blocks[index]);
        let list = match kind {
            "bulleted_list_item" => Some(("bulletList", "listItem")),
            "numbered_list_item" => Some(("orderedList", "listItem")),
            "to_do" => Some(("taskList", "taskItem")),
            _ => None,
        };

        if let Some((list_type, item_type)) = list {
            let mut items = Vec::new();
            while index < blocks.len() && notion_type(&blocks[index]) == kind {
                items.push(convert_list_item(&blocks[index], kind, item_type));
                index += 1;
            }
            out.push(json!({ "type": list_type, "content": items }));
            continue;
        }

        if let Some(node) = convert_block(&blocks[index]) {
            out.push(node);
        }
        index += 1;
    }
    out
}

fn convert_list_item(block: &Value, notion_kind: &str, item_type: &str) -> Value {
    let mut content = vec![paragraph_of(rich_array(block, notion_kind))];
    content.extend(convert_block_sequence(block_children(block)));

    if item_type == "taskItem" {
        let checked = payload(block, notion_kind)
            .get("checked")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return json!({
            "type": "taskItem",
            "attrs": { "checked": checked },
            "content": content,
        });
    }
    json!({ "type": "listItem", "content": content })
}

fn convert_block(block: &Value) -> Option<Value> {
    let kind = notion_type(block);
    let node = match kind {
        "paragraph" => Some(paragraph_of(rich_array(block, "paragraph"))),

        "heading_1" | "heading_2" | "heading_3" => {
            let level = match kind {
                "heading_1" => 1,
                "heading_2" => 2,
                _ => 3,
            };
            let inline = rich_to_inline(rich_array(block, kind));
            Some(json!({
                "type": "heading",
                "attrs": { "level": level },
                "content": inline,
            }))
        }

        "quote" => {
            let mut content = vec![paragraph_of(rich_array(block, "quote"))];
            content.extend(convert_block_sequence(block_children(block)));
            Some(json!({ "type": "blockquote", "content": content }))
        }

        "divider" => Some(json!({ "type": "horizontalRule" })),

        "code" => {
            let text = plain_text_from_rich(rich_array(block, "code"));
            let language = payload(block, "code")
                .get("language")
                .and_then(Value::as_str)
                .unwrap_or("plain text");
            Some(json!({
                "type": "codeBlock",
                "attrs": { "language": editor_language(language) },
                "content": if text.is_empty() {
                    Vec::<Value>::new()
                } else {
                    vec![json!({ "type": "text", "text": text })]
                },
            }))
        }

        "image" => image_src(block).map(|src| json!({
            "type": "image",
            "attrs": { "src": src },
        })),

        "callout" => {
            let mut content = vec![paragraph_of(rich_array(block, "callout"))];
            content.extend(convert_block_sequence(block_children(block)));
            Some(json!({
                "type": "callout",
                "attrs": { "kind": callout_kind(block) },
                "content": content,
            }))
        }

        "toggle" => {
            let mut content = vec![paragraph_of(rich_array(block, "toggle"))];
            content.extend(convert_block_sequence(block_children(block)));
            Some(json!({ "type": "toggle", "attrs": { "open": true }, "content": content }))
        }

        "table" => Some(convert_table(block)),

        "equation" => {
            let latex = payload(block, "equation")
                .get("expression")
                .and_then(Value::as_str)
                .unwrap_or("");
            Some(json!({ "type": "blockMath", "attrs": { "latex": latex } }))
        }

        "bookmark" | "link_preview" | "embed" => {
            let url = payload(block, kind)
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("");
            if url.is_empty() {
                None
            } else {
                let caption = plain_text_from_rich(rich_array(block, kind));
                Some(json!({
                    "type": "bookmark",
                    "attrs": { "url": url, "title": "", "description": caption },
                }))
            }
        }

        // Pages live in the tree, not in the body; the sync pass creates a
        // local note for them separately.
        "child_page" | "child_database" => None,

        // Unknown block: keep the text so nothing silently disappears.
        _ => {
            let inline = rich_to_inline(rich_array(block, kind));
            if inline.is_empty() {
                None
            } else {
                Some(json!({ "type": "paragraph", "content": inline }))
            }
        }
    };
    node
}

fn convert_table(block: &Value) -> Value {
    let rows: Vec<Value> = block_children(block)
        .iter()
        .filter(|row| notion_type(row) == "table_row")
        .map(|row| {
            let cells: Vec<Value> = payload(row, "table_row")
                .get("cells")
                .and_then(Value::as_array)
                .map(|cells| {
                    cells
                        .iter()
                        .map(|cell| {
                            let rich = cell.as_array().map(Vec::as_slice).unwrap_or(&[]);
                            json!({ "type": "tableCell", "content": [paragraph_of(rich)] })
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({ "type": "tableRow", "content": cells })
        })
        .collect();

    json!({
        "type": "table",
        "content": if rows.is_empty() {
            vec![json!({ "type": "tableRow", "content": [
                { "type": "tableCell", "content": [{ "type": "paragraph" }] }
            ] })]
        } else {
            rows
        },
    })
}

fn image_src(block: &Value) -> Option<String> {
    let image = payload(block, "image");
    let url = match image.get("type").and_then(Value::as_str) {
        Some("external") => image.pointer("/external/url").and_then(Value::as_str),
        Some("file") => image.pointer("/file/url").and_then(Value::as_str),
        _ => image
            .pointer("/external/url")
            .or_else(|| image.pointer("/file/url"))
            .and_then(Value::as_str),
    }?;
    if url.trim().is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

fn callout_kind(block: &Value) -> &'static str {
    match payload(block, "callout")
        .pointer("/icon/emoji")
        .and_then(Value::as_str)
        .unwrap_or("")
    {
        "💡" => "tip",
        "⚠️" => "warning",
        "⛔" => "danger",
        _ => "info",
    }
}

/// Inline rich text → editor inline nodes (text with marks, or inline maths).
pub fn rich_to_inline(rich: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for item in rich {
        match item.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                let text = item
                    .pointer("/text/content")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                let mut node = Map::new();
                node.insert("type".into(), Value::String("text".into()));
                node.insert("text".into(), Value::String(text.to_string()));
                let marks = marks_for(item);
                if !marks.is_empty() {
                    node.insert("marks".into(), Value::Array(marks));
                }
                out.push(Value::Object(node));
            }
            "equation" => {
                let latex = item
                    .pointer("/equation/expression")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                out.push(json!({ "type": "inlineMath", "attrs": { "latex": latex } }));
            }
            // mentions and anything else only carry their flattened text
            _ => {
                let text = item
                    .get("plain_text")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !text.is_empty() {
                    out.push(json!({ "type": "text", "text": text }));
                }
            }
        }
    }
    out
}

fn marks_for(item: &Value) -> Vec<Value> {
    let mut marks = Vec::new();
    let ann = item.get("annotations");
    let flagged = |key: &str| {
        ann.and_then(|a| a.get(key))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    if flagged("bold") {
        marks.push(json!({ "type": "bold" }));
    }
    if flagged("italic") {
        marks.push(json!({ "type": "italic" }));
    }
    if flagged("strikethrough") {
        marks.push(json!({ "type": "strike" }));
    }
    if flagged("underline") {
        marks.push(json!({ "type": "underline" }));
    }
    if flagged("code") {
        marks.push(json!({ "type": "code" }));
    }
    if let Some(url) = item.pointer("/text/link/url").and_then(Value::as_str) {
        if !url.is_empty() {
            marks.push(json!({ "type": "link", "attrs": { "href": url } }));
        }
    }
    marks
}

fn plain_text_from_rich(rich: &[Value]) -> String {
    rich.iter()
        .map(|item| {
            item.pointer("/text/content")
                .and_then(Value::as_str)
                .or_else(|| item.get("plain_text").and_then(Value::as_str))
                .unwrap_or("")
        })
        .collect::<String>()
}

/// Notion's code language enum → the hint the editor expects.
fn editor_language(raw: &str) -> &'static str {
    match raw {
        "plain text" => "",
        "typescript" => "ts",
        "javascript" => "js",
        "python" => "py",
        "rust" => "rs",
        "bash" => "sh",
        "markdown" => "md",
        "c++" => "cpp",
        "c#" => "cs",
        other => match other {
            "json" => "json",
            "yaml" => "yaml",
            "html" => "html",
            "css" => "css",
            "sql" => "sql",
            "go" => "go",
            "java" => "java",
            "kotlin" => "kt",
            "swift" => "swift",
            "ruby" => "rb",
            "php" => "php",
            "diff" => "diff",
            "xml" => "xml",
            "scss" => "scss",
            "docker" => "docker",
            "graphql" => "graphql",
            _ => "",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_cjk_text_is_chunked() {
        let long = "中文".repeat(1200);
        let chunks = chunk_text(&long);
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| c.chars().count() <= MAX_TEXT_CHUNK));
    }

    #[test]
    fn paragraphs_and_nested_lists_convert() {
        let doc = json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "标题" }] },
                { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "一项" }] },
                        { "type": "bulletList", "content": [
                            { "type": "listItem", "content": [
                                { "type": "paragraph", "content": [{ "type": "text", "text": "子项" }] } ] } ] }
                    ] }
                ] }
            ]
        });
        let blocks = convert_doc(&doc);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].block["type"], "heading_2");
        assert_eq!(blocks[1].block["type"], "bulleted_list_item");
        assert_eq!(blocks[1].children.len(), 1);
        assert_eq!(blocks[1].children[0].block["type"], "bulleted_list_item");
    }

    #[test]
    fn task_lists_keep_checked_state() {
        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "taskList",
                "content": [{
                    "type": "taskItem",
                    "attrs": { "checked": true },
                    "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "做完了" }] }]
                }]
            }]
        });
        let blocks = convert_doc(&doc);
        assert_eq!(blocks[0].block["type"], "to_do");
        assert_eq!(blocks[0].block["to_do"]["checked"], true);
    }

    #[test]
    fn local_images_become_upload_placeholders() {
        let doc = json!({
            "type": "doc",
            "content": [{ "type": "image", "attrs": { "src": "assets/img_1.png" } }]
        });
        let blocks = convert_doc(&doc);
        assert_eq!(
            blocks[0].block["image"][ASSET_MARKER],
            "assets/img_1.png"
        );
    }

    #[test]
    fn notion_blocks_convert_back_to_editor_nodes() {
        let blocks = json!([
            {
                "type": "heading_2",
                "heading_2": { "rich_text": [{ "type": "text", "text": { "content": "标题" }, "annotations": { "bold": true } }] }
            },
            {
                "type": "bulleted_list_item",
                "bulleted_list_item": { "rich_text": [{ "type": "text", "text": { "content": "一项" } }] },
                "children": [{
                    "type": "bulleted_list_item",
                    "bulleted_list_item": { "rich_text": [{ "type": "text", "text": { "content": "子项" } }] }
                }]
            },
            {
                "type": "to_do",
                "to_do": { "rich_text": [{ "type": "text", "text": { "content": "做完了" } }], "checked": true }
            }
        ]);
        let doc = blocks_to_doc(blocks.as_array().unwrap());
        let content = doc["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "heading");
        assert_eq!(content[0]["attrs"]["level"], 2);
        assert_eq!(content[0]["content"][0]["marks"][0]["type"], "bold");
        assert_eq!(content[1]["type"], "bulletList");
        assert_eq!(content[1]["content"][0]["type"], "listItem");
        assert_eq!(
            content[1]["content"][0]["content"][1]["type"],
            "bulletList"
        );
        assert_eq!(content[2]["type"], "taskList");
        assert_eq!(content[2]["content"][0]["attrs"]["checked"], true);
    }

    #[test]
    fn unknown_blocks_keep_their_text() {
        let blocks = json!([{
            "type": "synced_block",
            "synced_block": { "rich_text": [{ "type": "text", "text": { "content": "保留文字" } }] }
        }]);
        let doc = blocks_to_doc(blocks.as_array().unwrap());
        assert_eq!(doc["content"][0]["type"], "paragraph");
        assert_eq!(doc["content"][0]["content"][0]["text"], "保留文字");
    }

    #[test]
    fn round_trip_keeps_headings_and_lists() {
        let original = json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 1 }, "content": [{ "type": "text", "text": "Hi" }] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "body" }] }
            ]
        });
        let blocks = convert_doc(&original);
        let back = blocks_to_doc(
            &blocks
                .iter()
                .map(|node| node.block.clone())
                .collect::<Vec<_>>(),
        );
        assert_eq!(back["content"][0]["type"], "heading");
        assert_eq!(back["content"][0]["attrs"]["level"], 1);
        assert_eq!(back["content"][1]["content"][0]["text"], "body");
    }
}
