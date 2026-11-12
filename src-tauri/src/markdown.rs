//! TipTap (ProseMirror) JSON → Markdown / standalone HTML.
//!
//! Pure and synchronous: the export pass owns file IO, this module only turns a
//! `DocFile.content` tree into text. Keeping it side-effect free makes the
//! conversion testable without a Tauri handle (see the tests at the bottom).

use serde_json::{json, Value};

// ------------------------------------------------------------------- helpers

fn node_type(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

/// Children of a block, borrowed.
///
/// This used to `.cloned()` the array, so every rendered node deep-copied its
/// whole subtree: converting a 7 MB note peaked above 400 MB of transient
/// allocations. A slice costs nothing.
fn children_of(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn attr<'a>(node: &'a Value, key: &str) -> Option<&'a Value> {
    node.get("attrs")
        .and_then(Value::as_object)
        .and_then(|map| map.get(key))
}

fn attr_str<'a>(node: &'a Value, key: &str) -> &'a str {
    attr(node, key).and_then(Value::as_str).unwrap_or("")
}

fn text_of(node: &Value) -> &str {
    node.get("text").and_then(Value::as_str).unwrap_or("")
}

/// Mark types applied to one text node, in document order.
fn marks_of(node: &Value) -> Vec<&str> {
    node.get("marks")
        .and_then(Value::as_array)
        .map(|marks| {
            marks
                .iter()
                .filter_map(|mark| mark.get("type").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default()
}

fn link_href(node: &Value) -> Option<&str> {
    node.get("marks")?.as_array()?.iter().find_map(|mark| {
        if mark.get("type").and_then(Value::as_str) == Some("link") {
            mark.get("attrs")?.get("href")?.as_str()
        } else {
            None
        }
    })
}

/// Escapes the characters that would otherwise turn plain prose into markup.
/// Deliberately narrow: escaping `<`, `>` or `|` makes exported notes hard to
/// read, and they are rare in body text compared to `*` / `_` / `[`.
fn escape_md(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        if matches!(ch, '\\' | '*' | '_' | '`' | '[' | ']') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Wraps text in an inline code span sized so inner backticks stay literal.
fn code_span(text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for ch in text.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat(longest + 1);
    let pad = if text.starts_with('`')
        || text.ends_with('`')
        || text.starts_with(' ')
        || text.ends_with(' ')
    {
        " "
    } else {
        ""
    };
    format!("{fence}{pad}{text}{pad}{fence}")
}

fn align_continuation(text: &str, pad: usize) -> String {
    let indent = " ".repeat(pad);
    text.split('\n')
        .enumerate()
        .map(|(i, line)| {
            if i == 0 {
                line.to_string()
            } else {
                format!("{indent}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `assets/x.png` → `../assets/x.png` for documents nested in folders, so the
/// mirrored export keeps working when opened from any depth.
fn image_md(node: &Value, asset_prefix: &str) -> String {
    let src = attr_str(node, "src");
    let alt = attr_str(node, "alt").replace(['[', ']'], "");
    format!("![{alt}]({asset_prefix}{src})")
}

// ------------------------------------------------------------------ markdown

fn inline_md(nodes: &[Value], prefix: &str) -> String {
    let mut out = String::new();
    for node in nodes {
        match node_type(node) {
            "text" => {
                let raw = text_of(node);
                let marks = marks_of(node);
                let is_code = marks.contains(&"code");
                let mut piece = if is_code {
                    code_span(raw)
                } else {
                    escape_md(raw)
                };
                // innermost first, so the wrapping order reads naturally
                if marks.contains(&"strike") {
                    piece = format!("~~{piece}~~");
                }
                if marks.contains(&"italic") {
                    piece = format!("*{piece}*");
                }
                if marks.contains(&"bold") {
                    piece = format!("**{piece}**");
                }
                // Obsidian's highlight syntax is the one Markdown readers
                // already recognise, and the importer turns it back into a mark
                if marks.contains(&"highlight") {
                    piece = format!("=={piece}==");
                }
                if let Some(href) = link_href(node) {
                    piece = match internal_link_name(href) {
                        // an in-app link is exported as the Obsidian form, which
                        // the importer turns back into a real link
                        Some(_) => format!("[[{}]]", unescape_md(&piece).replace('|', "\\|")),
                        None => format!("[{piece}]({href})"),
                    };
                }
                out.push_str(&piece);
            }
            "hardBreak" => out.push_str("  \n"),
            "image" => out.push_str(&image_md(node, prefix)),
            "inlineMath" => {
                let latex = attr_str(node, "latex").trim();
                if latex.is_empty() {
                    out.push_str("$ $");
                } else {
                    out.push_str(&format!("${latex}$"));
                }
            }
            "" => {}
            _ => out.push_str(&inline_md(children_of(node), prefix)),
        }
    }
    out
}

#[derive(Clone, Copy)]
enum ListKind {
    Bullet,
    Ordered,
    Task,
}

fn list_md(items: &[Value], indent: usize, prefix: &str, kind: ListKind) -> String {
    let pad = "  ".repeat(indent);
    let mut blocks: Vec<String> = Vec::new();

    for (i, item) in items.iter().enumerate() {
        let marker = match kind {
            ListKind::Bullet => "- ".to_string(),
            ListKind::Ordered => format!("{}. ", i + 1),
            ListKind::Task => {
                let checked = attr(item, "checked").and_then(Value::as_bool).unwrap_or(false);
                format!("- [{}] ", if checked { "x" } else { " " })
            }
        };

        let mut head: Option<String> = None;
        let mut tail: Vec<String> = Vec::new();
        for child in children_of(item) {
            match node_type(child) {
                "paragraph" if head.is_none() => {
                    head = Some(inline_md(children_of(child), prefix));
                }
                "bulletList" => tail.push(list_md(
                    children_of(child),
                    indent + 1,
                    prefix,
                    ListKind::Bullet,
                )),
                "orderedList" => tail.push(list_md(
                    children_of(child),
                    indent + 1,
                    prefix,
                    ListKind::Ordered,
                )),
                "taskList" => tail.push(list_md(
                    children_of(child),
                    indent + 1,
                    prefix,
                    ListKind::Task,
                )),
                _ => {
                    if let Some(chunk) = block_md(child, indent + 1, prefix) {
                        let inner = " ".repeat(pad.len() + 2);
                        tail.push(
                            chunk
                                .lines()
                                .map(|line| format!("{inner}{line}"))
                                .collect::<Vec<_>>()
                                .join("\n"),
                        );
                    }
                }
            }
        }

        let head = head.unwrap_or_default();
        let mut first = if head.trim().is_empty() {
            format!("{pad}{}", marker.trim_end())
        } else {
            format!(
                "{pad}{marker}{}",
                align_continuation(&head, pad.len() + marker.len())
            )
        };
        for chunk in tail {
            first.push('\n');
            first.push_str(&chunk);
        }
        blocks.push(first);
    }

    blocks.join("\n")
}

// ------------------------------------------------------- structured blocks

/// `novion://doc/<id>` or `novion://docname/<name>` → its payload.
fn internal_link_name(href: &str) -> Option<&str> {
    href.strip_prefix(DOC_PREFIX)
        .or_else(|| href.strip_prefix(WIKI_PREFIX))
}

fn unescape_md(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
                continue;
            }
        }
        out.push(ch);
    }
    out
}


/// Callout kinds the editor can produce; anything else degrades to `note`.
pub fn callout_kind(raw: &str) -> &'static str {
    match raw.to_ascii_lowercase().as_str() {
        "tip" | "success" | "check" => "tip",
        "warning" | "warn" | "caution" => "warning",
        "danger" | "error" | "bug" => "danger",
        _ => "info",
    }
}

fn cell_text(cell: &Value, prefix: &str) -> String {
    let text = inline_md(children_of(cell), prefix);
    text.replace('|', "\\|").replace('\n', " ")
}

fn table_md(rows: &[Value], prefix: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut widths: Vec<usize> = Vec::new();
    let mut rendered: Vec<Vec<String>> = Vec::new();

    for row in rows {
        let cells: Vec<String> = children_of(row)
            .iter()
            .map(|cell| cell_text(cell, prefix))
            .collect();
        for (i, cell) in cells.iter().enumerate() {
            let width = cell.chars().count().max(3);
            if widths.len() <= i {
                widths.push(width);
            } else {
                widths[i] = widths[i].max(width);
            }
        }
        rendered.push(cells);
    }

    if rendered.is_empty() {
        return String::new();
    }
    let join = |cells: &[String]| -> String {
        let padded: Vec<String> = cells
            .iter()
            .enumerate()
            .map(|(i, cell)| {
                let width = widths.get(i).copied().unwrap_or(3);
                format!("{:width$}", cell, width = width)
            })
            .collect();
        format!("| {} |", padded.join(" | "))
    };

    lines.push(join(&rendered[0]));
    lines.push(format!(
        "| {} |",
        widths
            .iter()
            .map(|w| "-".repeat(*w))
            .collect::<Vec<_>>()
            .join(" | ")
    ));
    for row in rendered.iter().skip(1) {
        lines.push(join(row));
    }
    lines.join("\n")
}

fn callout_md(kind: &str, blocks: &[Value], prefix: &str) -> String {
    let mut inner = String::new();
    render_blocks(blocks, prefix, &mut inner);
    let body = inner.trim_end();
    let mut out = format!("> [!{}]", callout_kind(kind).to_uppercase());
    for line in body.lines() {
        out.push('\n');
        if line.is_empty() {
            out.push('>');
        } else {
            out.push_str("> ");
            out.push_str(line);
        }
    }
    out
}

fn toggle_md(blocks: &[Value], prefix: &str) -> String {
    let Some((summary, body)) = blocks.split_first() else {
        return String::new();
    };
    let title = inline_md(children_of(summary), prefix);
    let mut inner = String::new();
    render_blocks(body, prefix, &mut inner);
    let text = inner.trim_end();

    // Same shape as a callout, with its own kind: Obsidian shows it as a
    // generic callout, and `parse_quote` turns it back into a toggle, so the
    // round trip through Markdown no longer degrades the block.
    let mut out = format!("> [!TOGGLE] {}", title.trim());
    for line in text.lines() {
        out.push('\n');
        if line.is_empty() {
            out.push('>');
        } else {
            out.push_str("> ");
            out.push_str(line);
        }
    }
    out
}

fn block_md(node: &Value, indent: usize, prefix: &str) -> Option<String> {
    let kids = children_of(node);
    match node_type(node) {
        "paragraph" => {
            let text = inline_md(kids, prefix);
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
        "heading" => {
            let level = attr(node, "level")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 3) as usize;
            let text = inline_md(kids, prefix);
            Some(format!("{} {}", "#".repeat(level), text))
        }
        "bulletList" => Some(list_md(kids, indent, prefix, ListKind::Bullet)),
        "orderedList" => Some(list_md(kids, indent, prefix, ListKind::Ordered)),
        "taskList" => Some(list_md(kids, indent, prefix, ListKind::Task)),
        "codeBlock" => {
            let lang = attr_str(node, "language").trim();
            let body = plain_text(kids);
            let fence = if body.contains("```") { "````" } else { "```" };
            Some(format!(
                "{fence}{lang}\n{}\n{fence}",
                body.trim_end_matches('\n')
            ))
        }
        "blockquote" => {
            let mut inner = String::new();
            render_blocks(kids, prefix, &mut inner);
            let body = inner.trim_end();
            Some(
                body.lines()
                    .map(|line| {
                        if line.is_empty() {
                            ">".to_string()
                        } else {
                            format!("> {line}")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        }
        "horizontalRule" => Some("---".to_string()),
        "image" => Some(image_md(node, prefix)),
        "table" => {
            let rendered = table_md(kids, prefix);
            if rendered.trim().is_empty() {
                None
            } else {
                Some(rendered)
            }
        }
        "callout" => Some(callout_md(attr_str(node, "kind"), kids, prefix)),
        "toggle" => {
            let body = toggle_md(kids, prefix);
            if body.trim().is_empty() {
                None
            } else {
                Some(body)
            }
        }
        "bookmark" => {
            let url = attr_str(node, "url").trim();
            if url.is_empty() {
                None
            } else {
                let title = attr_str(node, "title").trim();
                let label = if title.is_empty() { url } else { title };
                Some(format!("[{label}]({url})"))
            }
        }
        // a table of contents is derived from the headings, not content
        "toc" => None,
        "blockMath" => {
            let latex = attr_str(node, "latex").trim();
            if latex.is_empty() {
                None
            } else {
                Some(format!("$${latex}$$"))
            }
        }
        _ => {
            let mut inner = String::new();
            render_blocks(kids, prefix, &mut inner);
            let body = inner.trim_end();
            if body.is_empty() {
                None
            } else {
                Some(body.to_string())
            }
        }
    }
}

fn render_blocks(nodes: &[Value], prefix: &str, out: &mut String) {
    for node in nodes {
        if let Some(chunk) = block_md(node, 0, prefix) {
            if !chunk.trim().is_empty() {
                out.push_str(&chunk);
                out.push_str("\n\n");
            }
        }
    }
}

/// Renders one document body as Markdown (without the title heading).
pub fn to_markdown(content: &Value, asset_prefix: &str) -> String {
    let mut out = String::new();
    render_blocks(children_of(content), asset_prefix, &mut out);
    let trimmed = out.trim_end();
    if trimmed.is_empty() {
        return String::new();
    }
    // trim in place instead of `format!`-ing a second copy of the whole output
    let end = trimmed.len();
    out.truncate(end);
    out.push('\n');
    out
}

// ---------------------------------------------------------------------- html

fn esc_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

fn inline_html(nodes: &[Value], prefix: &str) -> String {
    let mut out = String::new();
    for node in nodes {
        match node_type(node) {
            "text" => {
                let marks = marks_of(node);
                let raw = text_of(node);
                let mut piece = if marks.contains(&"code") {
                    format!("<code>{}</code>", esc_html(raw))
                } else {
                    esc_html(raw)
                };
                if marks.contains(&"strike") {
                    piece = format!("<s>{piece}</s>");
                }
                if marks.contains(&"italic") {
                    piece = format!("<em>{piece}</em>");
                }
                if marks.contains(&"bold") {
                    piece = format!("<strong>{piece}</strong>");
                }
                if marks.contains(&"underline") {
                    piece = format!("<u>{piece}</u>");
                }
                if marks.contains(&"highlight") {
                    piece = format!("<mark>{piece}</mark>");
                }
                if marks.contains(&"superscript") {
                    piece = format!("<sup>{piece}</sup>");
                }
                if marks.contains(&"subscript") {
                    piece = format!("<sub>{piece}</sub>");
                }
                if let Some(href) = link_href(node) {
                    piece = format!(
                        "<a href=\"{}\" rel=\"noopener noreferrer\">{piece}</a>",
                        esc_html(href)
                    );
                }
                out.push_str(&piece);
            }
            "hardBreak" => out.push_str("<br />"),
            "image" => {
                out.push_str(&format!(
                    "<img src=\"{}{}\" alt=\"{}\" />",
                    esc_html(prefix),
                    esc_html(attr_str(node, "src")),
                    esc_html(attr_str(node, "alt"))
                ));
            }
            "inlineMath" => out.push_str(&format!(
                "<code class=\"math\">{}</code>",
                esc_html(attr_str(node, "latex"))
            )),
            "" => {}
            _ => out.push_str(&inline_html(children_of(node), prefix)),
        }
    }
    out
}

fn list_html(items: &[Value], prefix: &str, kind: ListKind) -> String {
    let (tag, class) = match kind {
        ListKind::Bullet => ("ul", ""),
        ListKind::Ordered => ("ol", ""),
        ListKind::Task => ("ul", " class=\"tasks\""),
    };
    let mut out = format!("<{tag}{class}>");
    for item in items {
        let kids = children_of(item);
        let mut body = String::new();
        let mut leading = String::new();
        for child in kids {
            match node_type(child) {
                "paragraph" if leading.is_empty() && body.is_empty() => {
                    leading = inline_html(children_of(child), prefix);
                }
                _ => body.push_str(&block_html(child, prefix)),
            }
        }
        if let ListKind::Task = kind {
            let checked = attr(item, "checked").and_then(Value::as_bool).unwrap_or(false);
            out.push_str(&format!(
                "<li><input type=\"checkbox\" disabled{} /> <span>{leading}</span>{body}</li>",
                if checked { " checked" } else { "" }
            ));
        } else {
            out.push_str(&format!("<li>{leading}{body}</li>"));
        }
    }
    out.push_str(&format!("</{tag}>"));
    out
}

fn table_html(rows: &[Value], prefix: &str) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let mut out = String::from("<table>");
    for (index, row) in rows.iter().enumerate() {
        let tag = if index == 0 { "th" } else { "td" };
        out.push_str("<tr>");
        for cell in children_of(row) {
            let inner: String = children_of(cell)
                .iter()
                .map(|block| block_html(block, prefix))
                .collect();
            let content = inner.trim();
            let content = if content.is_empty() { "&nbsp;" } else { content };
            out.push_str(&format!("<{tag}>{content}</{tag}>"));
        }
        out.push_str("</tr>");
    }
    out.push_str("</table>");
    out
}

fn block_html(node: &Value, prefix: &str) -> String {
    let kids = children_of(node);
    match node_type(node) {
        "paragraph" => {
            let text = inline_html(kids, prefix);
            if text.trim().is_empty() {
                String::new()
            } else {
                format!("<p>{text}</p>")
            }
        }
        "heading" => {
            let level = attr(node, "level")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 6);
            format!("<h{level}>{}</h{level}>", inline_html(kids, prefix))
        }
        "bulletList" => list_html(kids, prefix, ListKind::Bullet),
        "orderedList" => list_html(kids, prefix, ListKind::Ordered),
        "taskList" => list_html(kids, prefix, ListKind::Task),
        "codeBlock" => {
            let lang = attr_str(node, "language").trim();
            let class = if lang.is_empty() {
                String::new()
            } else {
                format!(" class=\"language-{}\"", esc_html(lang))
            };
            format!("<pre><code{class}>{}</code></pre>", esc_html(&plain_text(kids)))
        }
        "blockquote" => {
            let inner: String = kids.iter().map(|c| block_html(c, prefix)).collect();
            format!("<blockquote>{inner}</blockquote>")
        }
        "horizontalRule" => "<hr />".to_string(),
        "image" => format!(
            "<img src=\"{}{}\" alt=\"{}\" />",
            esc_html(prefix),
            esc_html(attr_str(node, "src")),
            esc_html(attr_str(node, "alt"))
        ),
        "table" => table_html(&kids, prefix),
        "callout" => {
            let kind = callout_kind(attr_str(node, "kind"));
            let inner: String = kids.iter().map(|c| block_html(c, prefix)).collect();
            format!(
                "<div class=\"callout callout-{kind}\">{inner}</div>"
            )
        }
        "toggle" => {
            let mut iter = kids.iter();
            let summary = iter
                .next()
                .map(|first| inline_html(children_of(first), prefix))
                .unwrap_or_default();
            let body: String = iter.map(|c| block_html(c, prefix)).collect();
            format!(
                "<details open><summary>{summary}</summary>{body}</details>"
            )
        }
        "bookmark" => {
            let url = attr_str(node, "url").trim();
            if url.is_empty() {
                String::new()
            } else {
                let title = attr_str(node, "title").trim();
                let label = if title.is_empty() { url } else { title };
                format!(
                    "<p class=\"bookmark\"><a href=\"{}\" target=\"_blank\" rel=\"noopener noreferrer\">{}</a></p>",
                    esc_html(url),
                    esc_html(label)
                )
            }
        }
        "toc" => "<nav class=\"toc\">目录</nav>".to_string(),
        "blockMath" => format!(
            "<div class=\"math-block\"><code>{}</code></div>",
            esc_html(attr_str(node, "latex"))
        ),
        _ => kids.iter().map(|c| block_html(c, prefix)).collect(),
    }
}

const HTML_STYLE: &str = r#"
:root {
  --bg: #f7f6f3; --fg: #2c2c2c; --muted: #6b6b6b;
  --border: #e2e0db; --brand: #4a6fa5; --code-bg: #efeee9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a1a; --fg: #e6e6e6; --muted: #9a9a9a;
    --border: #2e2e2e; --brand: #6b9bd2; --code-bg: #232323;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.72 -apple-system, BlinkMacSystemFont, "Helvetica Neue",
    "PingFang SC", "Hiragino Sans GB", "Segoe UI", "Microsoft YaHei", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow-wrap: break-word;
}
article { max-width: 720px; margin: 0 auto; padding: 56px 24px 96px; }
h1.title {
  font-size: 38px; font-weight: 650; letter-spacing: -0.022em;
  line-height: 1.2; margin: 0 0 28px;
}
h1, h2, h3, h4, h5, h6 {
  font-weight: 600; letter-spacing: -0.011em; line-height: 1.3;
  margin: 1.5em 0 0.4em;
}
h1 { font-size: 1.85em; } h2 { font-size: 1.42em; } h3 { font-size: 1.18em; }
h4 { font-size: 1.06em; } h5 { font-size: 1em; } h6 { font-size: 0.94em; color: var(--muted); }
nav.toc { border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; color: var(--muted); }
p { margin: 0.45em 0; }
a {
  color: var(--brand); text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--brand) 40%, transparent);
}
img { max-width: 100%; border-radius: 6px; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace;
  font-size: 0.9em; background: var(--code-bg);
  border-radius: 4px; padding: 0.1em 0.35em;
}
pre {
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 8px; padding: 12px 14px; overflow: auto;
}
pre code { background: none; padding: 0; font-size: 0.88em; }
blockquote {
  margin: 0.7em 0; padding: 0.15em 0 0.15em 14px;
  border-left: 3px solid var(--border); color: var(--muted);
}
ul, ol { padding-left: 1.4em; margin: 0.45em 0; }
li { margin: 0.15em 0; }
ul.tasks { list-style: none; padding-left: 0.2em; }
ul.tasks li { display: flex; gap: 0.5em; align-items: flex-start; }
ul.tasks input { margin-top: 0.45em; accent-color: var(--brand); }
hr { border: none; border-top: 1px solid var(--border); margin: 1.8em 0; }
table { border-collapse: collapse; width: 100%; margin: 0.9em 0; font-size: 0.94em; }
th, td {
  border: 1px solid var(--border); padding: 6px 9px;
  text-align: left; vertical-align: top;
}
th { background: var(--code-bg); font-weight: 600; }
.callout {
  margin: 0.9em 0; padding: 10px 14px; border-radius: 6px;
  border-left: 3px solid var(--brand);
  background: color-mix(in srgb, var(--brand) 7%, transparent);
}
.callout-warning { border-left-color: #c98a2b; background: rgba(201, 138, 43, 0.09); }
.callout-danger { border-left-color: #c0392b; background: rgba(192, 57, 43, 0.09); }
.callout-tip { border-left-color: #2f9e5f; background: rgba(47, 158, 95, 0.09); }
.callout > *:first-child { margin-top: 0; }
.callout > *:last-child { margin-bottom: 0; }
details { margin: 0.7em 0; }
summary { cursor: pointer; font-weight: 600; }
"#;

/// A self-contained page: images stay next to the file, no network needed.
pub fn html_document(title: &str, content: &Value) -> String {
    let body: String = children_of(content)
        .iter()
        .map(|node| block_html(node, ""))
        .collect();
    format!(
        "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\" />\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n\
<title>{title}</title>\n<style>{HTML_STYLE}</style>\n</head>\n<body>\n\
<article>\n<h1 class=\"title\">{title}</h1>\n{body}\n\n</article>\n</body>\n</html>\n",
        title = esc_html(title)
    )
}

// --------------------------------------------------------------------- text

/// Flattens a body into plain text (search snippets, version previews, counts).
pub fn plain_text(nodes: &[Value]) -> String {
    let mut out = String::new();
    push_plain_text(nodes, &mut out);
    out
}
/// Recursion writes into one buffer: the old version returned a fresh `String`
/// per node and immediately copied it into the parent, so a deep document
/// allocated one intermediate string per block.
fn push_plain_text(nodes: &[Value], out: &mut String) {
    for node in nodes {
        match node_type(node) {
            "text" => out.push_str(text_of(node)),
            "hardBreak" => out.push('\n'),
            _ => push_plain_text(children_of(node), out),
        }
    }
}

/// Whole-document text with block boundaries turned into spaces.
pub fn document_text(content: &Value) -> String {
    fn walk(node: &Value, out: &mut String) {
        // content is an array of blocks; arrays carry no attributes of their own
        if let Value::Array(items) = node {
            for item in items {
                walk(item, out);
            }
            return;
        }
        let kind = node_type(node);
        if kind == "image" {
            out.push_str(" [图片] ");
        }
        if let Some(text) = node.get("text").and_then(Value::as_str) {
            out.push_str(text);
        }
        if let Some(children) = node.get("content") {
            walk(children, out);
        }
        if matches!(
            kind,
            "paragraph"
                | "heading"
                | "listItem"
                | "taskItem"
                | "blockquote"
                | "codeBlock"
                | "horizontalRule"
        ) {
            out.push(' ');
        }
    }

    let mut out = String::new();
    walk(content, &mut out);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ------------------------------------------------------------- markdown input

/// Result of turning a `.md` file into a document body.
pub struct ParsedMarkdown {
    pub content: Value,
    /// frontmatter `title:` (falls back to the caller: filename / first H1)
    pub title: Option<String>,
}

/// Internal links are stored as a link mark with this prefix plus the target
/// document *name*; the import pass rewrites the name into the real id.
pub const WIKI_PREFIX: &str = "novion://docname/";
/// Same prefix once a link points at a concrete document.
pub const DOC_PREFIX: &str = "novion://doc/";

fn indent_of(line: &str) -> usize {
    let mut n = 0;
    for ch in line.chars() {
        match ch {
            ' ' => n += 1,
            '\t' => n += 4,
            _ => break,
        }
    }
    n
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

fn strip_indent(line: &str, n: usize) -> String {
    let mut used = 0;
    let mut out = String::with_capacity(line.len());
    for ch in line.chars() {
        if used < n {
            match ch {
                ' ' => {
                    used += 1;
                    continue;
                }
                '\t' => {
                    used = used.saturating_add(4);
                    continue;
                }
                _ => {}
            }
        }
        out.push(ch);
    }
    out
}

/// ```lang / ~~~  — returns the fence marker and the info string.
fn fence_of(line: &str) -> Option<(char, String)> {
    let t = line.trim_start();
    let ch = t.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let run: String = t.chars().take_while(|c| *c == ch).collect();
    if run.len() < 3 {
        return None;
    }
    let info = t[run.len()..].trim().to_string();
    Some((ch, info))
}

fn heading_of(line: &str) -> Option<(usize, String)> {
    let t = line.trim_start();
    let hashes: String = t.chars().take_while(|c| *c == '#').collect();
    if hashes.is_empty() || hashes.len() > 6 {
        return None;
    }
    let rest = &t[hashes.len()..];
    if !rest.is_empty() && !rest.starts_with(' ') {
        return None;
    }
    let text = rest.trim().trim_end_matches('#').trim().to_string();
    Some((hashes.len(), text))
}

fn hr_of(line: &str) -> bool {
    let t = line.trim();
    if t.len() < 3 {
        return false;
    }
    let first = t.chars().next().unwrap();
    if !matches!(first, '-' | '*' | '_') {
        return false;
    }
    t.chars().all(|c| c == first || c == ' ')
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MdListKind {
    Bullet,
    Ordered,
    Task,
}

/// `(kind, indent width, checked?, body)` for a list item line.
///
/// The body is returned as a slice of the original line so the caller never has
/// to re-derive a column offset (markers are not whitespace, which made the
/// previous column arithmetic cut into the item text).
fn list_marker(line: &str) -> Option<(MdListKind, usize, bool, &str)> {
    let indent = indent_of(line);
    let rest = line.trim_start_matches([' ', '\t']);
    let mut chars = rest.char_indices();
    let (_, first) = chars.next()?;
    let mut end = 0usize;
    let kind;
    if matches!(first, '-' | '*' | '+') {
        end = first.len_utf8();
        kind = MdListKind::Bullet;
    } else if first.is_ascii_digit() {
        let mut n = first.len_utf8();
        for (i, ch) in rest[n..].char_indices() {
            if ch.is_ascii_digit() {
                n += ch.len_utf8();
            } else {
                let delim = ch;
                if delim != '.' && delim != ')' {
                    return None;
                }
                end = n + delim.len_utf8();
                let _ = i;
                break;
            }
        }
        if end == 0 {
            return None;
        }
        kind = MdListKind::Ordered;
    } else {
        return None;
    }

    let after = &rest[end..];
    if !after.is_empty() && !after.starts_with(' ') {
        return None;
    }
    let body = after.trim_start_matches(' ');

    // `- [ ] task` / `- [x] done`
    if kind == MdListKind::Bullet && body.len() >= 3 && body.starts_with('[') {
        let mark = body.chars().nth(1).unwrap_or(' ');
        if body.chars().nth(2) == Some(']') && matches!(mark, ' ' | 'x' | 'X') {
            let tail = &body[3..];
            return Some((MdListKind::Task, indent, mark != ' ', tail.trim_start_matches(' ')));
        }
    }

    Some((kind, indent, false, body))
}

/// True when `line` starts a block that may not continue a paragraph.
fn starts_block(line: &str) -> bool {
    let t = line.trim_start();
    if t.is_empty() {
        return true;
    }
    fence_of(line).is_some()
        || heading_of(line).is_some()
        || hr_of(line)
        || t.starts_with('>')
        || list_marker(line).is_some()
}

fn is_table_delimiter(line: &str) -> bool {
    let t = line.trim();
    if !t.contains('|') {
        return false;
    }
    t.chars()
        .all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
        && t.chars().filter(|c| *c == '-').count() >= 1
}

fn table_row(line: &str) -> Vec<String> {
    let t = line.trim().trim_start_matches('|').trim_end_matches('|');
    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut escaped = false;
    let mut in_code = false;
    for ch in t.chars() {
        if escaped {
            cur.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '`' => {
                in_code = !in_code;
                cur.push(ch);
            }
            '|' if !in_code => {
                cells.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    cells.push(cur.trim().to_string());
    cells
}

struct Parser {
    lines: Vec<String>,
    pos: usize,
}

impl Parser {
    fn new(lines: Vec<String>) -> Self {
        Self { lines, pos: 0 }
    }

    fn peek(&self) -> Option<&String> {
        self.lines.get(self.pos)
    }

    fn parse_blocks(&mut self, min_indent: usize) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        // cloned: the branches below call `&mut self` while still reading the line
        while let Some(line) = self.peek().cloned() {
            if is_blank(&line) {
                self.pos += 1;
                continue;
            }
            let indent = indent_of(&line);
            if indent < min_indent {
                break;
            }
            let trimmed = line.trim_start();

            if trimmed.starts_with("$$") {
                if let Some(node) = self.parse_math_block() {
                    out.push(node);
                    continue;
                }
            }
            if fence_of(&line).is_some() {
                if let Some(node) = self.parse_code() {
                    out.push(node);
                }
                continue;
            }
            if let Some((level, text)) = heading_of(&line) {
                self.pos += 1;
                out.push(json!({
                    "type": "heading",
                    "attrs": { "level": level.clamp(1, 6) },
                    "content": parse_inline(&text),
                }));
                continue;
            }
            if hr_of(&line) {
                self.pos += 1;
                out.push(json!({ "type": "horizontalRule" }));
                continue;
            }
            if trimmed.starts_with('>') {
                out.push(self.parse_quote(indent));
                continue;
            }
            if trimmed.contains('|')
                && self
                    .lines
                    .get(self.pos + 1)
                    .is_some_and(|next| is_table_delimiter(next))
            {
                if let Some(node) = self.parse_table() {
                    out.push(node);
                }
                continue;
            }
            if list_marker(&line).is_some() {
                out.push(self.parse_list(indent));
                continue;
            }
            out.extend(self.parse_paragraph(min_indent));
        }
        out
    }

    /// `$$latex$$` on one line, or a fenced pair of `$$` lines.
    fn parse_math_block(&mut self) -> Option<Value> {
        let line = self.peek()?.clone();
        let trimmed = line.trim();
        if !trimmed.starts_with("$$") {
            return None;
        }
        if trimmed.len() > 4 && trimmed.ends_with("$$") {
            let inner = trimmed[2..trimmed.len() - 2].trim().to_string();
            self.pos += 1;
            return Some(json!({ "type": "blockMath", "attrs": { "latex": inner } }));
        }
        if trimmed != "$$" {
            return None;
        }
        self.pos += 1;
        let mut body: Vec<String> = Vec::new();
        // `cloned()` ends the borrow before `pos` moves on
        while let Some(next) = self.lines.get(self.pos).cloned() {
            self.pos += 1;
            if next.trim() == "$$" {
                break;
            }
            body.push(next);
        }
        Some(json!({
            "type": "blockMath",
            "attrs": { "latex": body.join("\n").trim().to_string() },
        }))
    }

    fn parse_code(&mut self) -> Option<Value> {
        let first = self.peek()?.clone();
        let (marker, info) = fence_of(&first)?;
        let run = marker.to_string().repeat(3);
        self.pos += 1;
        let mut body: Vec<String> = Vec::new();
        while let Some(line) = self.peek() {
            let t = line.trim_start();
            if t.starts_with(&run)
                && t.chars().take_while(|c| *c == marker).count() >= 3
            {
                self.pos += 1;
                break;
            }
            body.push(line.clone());
            self.pos += 1;
        }
        let lang: String = info
            .split_whitespace()
            .next()
            .unwrap_or("")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '#' | '+' | '-' | '_'))
            .collect();
        let text = body.join("\n");
        let mut node = json!({
            "type": "codeBlock",
            "attrs": { "language": lang },
        });
        if !text.is_empty() {
            node["content"] = json!([{ "type": "text", "text": text }]);
        }
        Some(node)
    }

    fn parse_quote(&mut self, min_indent: usize) -> Value {
        let mut inner: Vec<String> = Vec::new();
        while let Some(line) = self.peek() {
            if is_blank(line) {
                // a blank line inside a quote keeps the block going when the
                // next line is still quoted
                let next_quoted = self
                    .lines
                    .get(self.pos + 1)
                    .is_some_and(|n| n.trim_start().starts_with('>'));
                if !next_quoted {
                    break;
                }
                inner.push(String::new());
                self.pos += 1;
                continue;
            }
            let indent = indent_of(line);
            if indent < min_indent {
                break;
            }
            let t = line.trim_start();
            let Some(rest) = t.strip_prefix('>') else { break };
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            inner.push(rest.to_string());
            self.pos += 1;
        }
        // Obsidian callouts: `> [!note]` on the first quoted line. A toggle
        // carries its summary on the same line (`> [!TOGGLE] 摘要`).
        let mut kind: Option<String> = None;
        let mut summary = String::new();
        if let Some(first) = inner.first() {
            let t = first.trim();
            if let Some(rest) = t.strip_prefix("[!") {
                if let Some(end) = rest.find(']') {
                    kind = Some(rest[..end].trim().to_string());
                    summary = rest[end + 1..].trim().to_string();
                    inner.remove(0);
                }
            }
        }

        let mut sub = Parser::new(inner);
        let mut blocks = sub.parse_blocks(0);
        if blocks.is_empty() {
            blocks.push(json!({ "type": "paragraph" }));
        }
        match kind {
            Some(kind) if kind.eq_ignore_ascii_case("toggle") => {
                let label = if summary.is_empty() { "折叠块" } else { &summary };
                let title = paragraph_blocks(parse_inline(label));
                let mut content = title;
                content.extend(blocks);
                json!({
                    "type": "toggle",
                    "attrs": { "open": true },
                    "content": content,
                })
            }
            Some(kind) => json!({
                "type": "callout",
                "attrs": { "kind": callout_kind(&kind) },
                "content": blocks,
            }),
            None => json!({ "type": "blockquote", "content": blocks }),
        }
    }

    fn parse_table(&mut self) -> Option<Value> {
        let header = table_row(self.peek()?);
        self.pos += 1;
        self.pos += 1; // delimiter row, alignment is not stored
        let mut rows: Vec<Vec<String>> = Vec::new();
        while let Some(line) = self.peek() {
            if is_blank(line) || !line.trim_start().contains('|') {
                break;
            }
            rows.push(table_row(line));
            self.pos += 1;
        }

        let cell = |kind: &str, text: &str| -> Value {
            let inline = parse_inline(text);
            let blocks = paragraph_blocks(inline);
            json!({
                "type": kind,
                "attrs": { "colspan": 1, "rowspan": 1, "colwidth": null },
                "content": if blocks.is_empty() {
                    json!([{ "type": "paragraph" }])
                } else {
                    Value::Array(blocks)
                },
            })
        };

        let mut table_rows = vec![json!({
            "type": "tableRow",
            "content": header.iter().map(|c| cell("tableHeader", c)).collect::<Vec<_>>(),
        })];
        for row in rows {
            table_rows.push(json!({
                "type": "tableRow",
                "content": row.iter().map(|c| cell("tableCell", c)).collect::<Vec<_>>(),
            }));
        }
        Some(json!({ "type": "table", "content": table_rows }))
    }

    fn parse_list(&mut self, indent: usize) -> Value {
        let kind = match self.peek().and_then(|l| list_marker(l)) {
            Some((kind, _, _, _)) => kind,
            None => return json!({ "type": "paragraph" }),
        };

        let mut items: Vec<Value> = Vec::new();
        while let Some(line) = self.peek() {
            if is_blank(line) {
                break;
            }
            let line_indent = indent_of(line);
            if line_indent != indent {
                break;
            }
            let Some((item_kind, _, checked, body)) = list_marker(line) else { break };
            if item_kind != kind {
                break;
            }

            let mut content: Vec<String> = vec![body.to_string()];
            self.pos += 1;

            // continuation: indented lines, and blank lines that are followed
            // by more indented content (a loose list)
            loop {
                let Some(next) = self.peek() else { break };
                if is_blank(next) {
                    let mut look = self.pos + 1;
                    let mut saw_content = false;
                    while let Some(candidate) = self.lines.get(look) {
                        if is_blank(candidate) {
                            look += 1;
                            continue;
                        }
                        saw_content = indent_of(candidate) > indent;
                        break;
                    }
                    if !saw_content {
                        break;
                    }
                    content.push(String::new());
                    self.pos += 1;
                    continue;
                }
                if indent_of(next) <= indent {
                    break;
                }
                content.push(next.clone());
                self.pos += 1;
            }

            // dedent the continuation block by its own first indent
            let base = content
                .iter()
                .skip(1)
                .find(|l| !is_blank(l))
                .map(|l| indent_of(l))
                .unwrap_or(0);
            let body: Vec<String> = content
                .iter()
                .enumerate()
                .map(|(i, l)| if i == 0 { l.clone() } else { strip_indent(l, base) })
                .collect();

            let mut sub = Parser::new(body);
            let mut blocks = sub.parse_blocks(0);
            if blocks.is_empty() {
                blocks.push(json!({ "type": "paragraph" }));
            }

            if kind == MdListKind::Task {
                items.push(json!({
                    "type": "taskItem",
                    "attrs": { "checked": checked },
                    "content": blocks,
                }));
            } else {
                items.push(json!({ "type": "listItem", "content": blocks }));
            }

            // absorb blank lines between items of the same list
            while self.peek().is_some_and(|l| is_blank(l)) {
                let next_has_item = self
                    .lines
                    .get(self.pos + 1)
                    .map(|l| (l.clone(), list_marker(l)))
                    .is_some_and(|(l, marker)| {
                        marker.is_some_and(|(k, ind, _, _)| k == kind && ind == indent)
                            && !is_blank(&l)
                    });
                if !next_has_item {
                    break;
                }
                self.pos += 1;
            }
        }

        let node_type = match kind {
            MdListKind::Bullet => "bulletList",
            MdListKind::Ordered => "orderedList",
            MdListKind::Task => "taskList",
        };
        json!({ "type": node_type, "content": items })
    }

    fn parse_paragraph(&mut self, min_indent: usize) -> Vec<Value> {
        let mut parts: Vec<String> = Vec::new();
        let mut hard_breaks: Vec<bool> = Vec::new();

        while let Some(line) = self.peek() {
            if is_blank(line) {
                break;
            }
            if !parts.is_empty() && (starts_block(line) || indent_of(line) < min_indent) {
                break;
            }
            let text = line.trim();
            let hard = text.ends_with("  ") || text.ends_with("\\");
            parts.push(text.trim_end().trim_end_matches('\\').to_string());
            hard_breaks.push(hard);
            self.pos += 1;
            // a standalone image line ends the paragraph
            if parts.last().is_some_and(|p| p.starts_with("![")) {
                break;
            }
        }

        let mut inline: Vec<Value> = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                if hard_breaks[i - 1] {
                    inline.push(json!({ "type": "hardBreak" }));
                } else {
                    push_text(&mut inline, " ");
                }
            }
            inline.extend(parse_inline(part));
        }
        paragraph_blocks(inline)
    }
}

/// Splits inline content into blocks: images are block nodes, so they end the
/// paragraph they were found in.
fn paragraph_blocks(inline: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut run: Vec<Value> = Vec::new();
    let flush = |run: &mut Vec<Value>, out: &mut Vec<Value>| {
        if run.is_empty() {
            return;
        }
        let content = std::mem::take(run);
        out.push(json!({ "type": "paragraph", "content": content }));
    };
    for node in inline {
        if node.get("type").and_then(Value::as_str) == Some("image") {
            flush(&mut run, &mut out);
            out.push(node);
        } else {
            run.push(node);
        }
    }
    flush(&mut run, &mut out);
    out
}

fn push_text(out: &mut Vec<Value>, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(Value::Object(last)) = out.last_mut() {
        let plain = last.get("marks").is_none() && last.get("type").and_then(Value::as_str) == Some("text");
        if plain {
            let merged = format!(
                "{}{}",
                last.get("text").and_then(Value::as_str).unwrap_or(""),
                text
            );
            last.insert("text".into(), Value::String(merged));
            return;
        }
    }
    out.push(json!({ "type": "text", "text": text }));
}

fn apply_mark(nodes: &mut [Value], mark: Value) {
    for node in nodes.iter_mut() {
        if node.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let marks = node
            .as_object_mut()
            .map(|map| map.entry("marks").or_insert_with(|| json!([])))
            .and_then(Value::as_array_mut);
        if let Some(marks) = marks {
            marks.insert(0, mark.clone());
        }
    }
}

fn plain_text_node(text: &str, marks: Value) -> Value {
    json!({ "type": "text", "text": text, "marks": marks })
}

/// Index of the closing fence run of the same length, searching from `from`.
fn find_run(chars: &[char], from: usize, ch: char, len: usize) -> Option<usize> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == ch {
            let mut n = 0;
            while i + n < chars.len() && chars[i + n] == ch {
                n += 1;
            }
            if n >= len {
                return Some(i);
            }
            i += n;
        } else {
            i += 1;
        }
    }
    None
}

fn find_unescaped(s: &str, needle: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let n = needle.as_bytes();
    let mut i = 0;
    while i + n.len() <= bytes.len() {
        if &bytes[i..i + n.len()] == n {
            let mut backslashes = 0;
            let mut j = i;
            while j > 0 && bytes[j - 1] == b'\\' {
                backslashes += 1;
                j -= 1;
            }
            if backslashes % 2 == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Inline markdown → TipTap inline nodes (text with marks, images, breaks).
fn parse_inline(src: &str) -> Vec<Value> {
    let chars: Vec<char> = src.chars().collect();
    let mut out: Vec<Value> = Vec::new();
    let mut buf = String::new();
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];

        // backslash escape
        if c == '\\' && i + 1 < chars.len() {
            buf.push(chars[i + 1]);
            i += 2;
            continue;
        }

        // `$inline math$` — a lone `$` stays literal, prices are more common
        if c == '$' && i + 1 < chars.len() && chars[i + 1] != '$' {
            let mut end = i + 1;
            while end < chars.len() && chars[end] != '$' && chars[end] != '\n' {
                end += 1;
            }
            if end < chars.len() && chars[end] == '$' {
                let latex: String = chars[i + 1..end].iter().collect();
                if !latex.trim().is_empty()
                    && !latex.starts_with(' ')
                    && !latex.ends_with(' ')
                {
                    push_text(&mut out, &buf);
                    buf.clear();
                    out.push(json!({
                        "type": "inlineMath",
                        "attrs": { "latex": latex },
                    }));
                    i = end + 1;
                    continue;
                }
            }
        }

        // `code span`
        if c == '`' {
            let mut run = 0;
            while i + run < chars.len() && chars[i + run] == '`' {
                run += 1;
            }
            if let Some(start) = find_run(&chars, i + run, '`', run) {
                let text: String = chars[i + run..start].iter().collect();
                let text = text.trim_matches(' ');
                push_text(&mut out, &buf);
                buf.clear();
                out.push(plain_text_node(text, json!([{ "type": "code" }])));
                i = start + run;
                continue;
            }
        }

        // ==highlight== (Obsidian syntax, also what the exporter writes)
        if c == '=' && i + 1 < chars.len() && chars[i + 1] == '=' {
            if let Some(end) = find_sub(&chars, i + 2, &['=', '=']) {
                let text: String = chars[i + 2..end].iter().collect();
                if !text.trim().is_empty() {
                    push_text(&mut out, &buf);
                    buf.clear();
                    let mut inner = parse_inline(&text);
                    apply_mark(&mut inner, json!({ "type": "highlight" }));
                    out.extend(inner);
                    i = end + 2;
                    continue;
                }
            }
        }

        // ![alt](src)
        if c == '!' && i + 1 < chars.len() && chars[i + 1] == '[' {
            if let Some((consumed, alt, target)) = parse_link_like(&chars, i + 1) {
                push_text(&mut out, &buf);
                buf.clear();
                out.push(json!({
                    "type": "image",
                    "attrs": { "src": target, "alt": alt },
                }));
                i += 1 + consumed;
                continue;
            }
        }

        // [[wiki link]] / [[target|alias]]
        if c == '[' && i + 1 < chars.len() && chars[i + 1] == '[' {
            if let Some(end) = find_sub(&chars, i + 2, &[']', ']']) {
                let inner: String = chars[i + 2..end].iter().collect();
                let (target, label) = match inner.split_once('|') {
                    Some((t, l)) => (t.trim().to_string(), l.trim().to_string()),
                    None => (inner.trim().to_string(), inner.trim().to_string()),
                };
                let target = target.split('#').next().unwrap_or("").trim().to_string();
                if !target.is_empty() {
                    push_text(&mut out, &buf);
                    buf.clear();
                    if target.to_ascii_lowercase().ends_with(".md") || target.contains('.') && !label.eq_ignore_ascii_case(&target) {
                        // `![[x.png]]`-style embeds keep their file name
                    }
                    out.push(plain_text_node(
                        if label.is_empty() { &target } else { &label },
                        json!([{
                            "type": "link",
                            "attrs": { "href": format!("{WIKI_PREFIX}{target}"), "target": null, "rel": null, "class": null }
                        }]),
                    ));
                    i = end + 2;
                    continue;
                }
            }
        }

        // [text](href)
        if c == '[' {
            if let Some((consumed, label, target)) = parse_link_like(&chars, i) {
                push_text(&mut out, &buf);
                buf.clear();
                let mut inner = parse_inline(&label);
                if !inner.is_empty() {
                    apply_mark(
                        &mut inner,
                        json!({
                            "type": "link",
                            "attrs": { "href": target, "target": null, "rel": null, "class": null }
                        }),
                    );
                    out.extend(inner);
                }
                i += consumed;
                continue;
            }
        }

        // ~~strike~~
        if c == '~' && i + 1 < chars.len() && chars[i + 1] == '~' {
            let rest: String = chars[i + 2..].iter().collect();
            if let Some(rel) = find_unescaped(&rest, "~~") {
                let inner_text: String = rest[..rel].to_string();
                push_text(&mut out, &buf);
                buf.clear();
                let mut inner = parse_inline(&inner_text);
                apply_mark(&mut inner, json!({ "type": "strike" }));
                out.extend(inner);
                i += 2 + rest[..rel].chars().count() + 2;
                continue;
            }
        }

        // **strong** / __strong__
        if (c == '*' || c == '_') && i + 1 < chars.len() && chars[i + 1] == c {
            let marker: String = std::iter::repeat(c).take(2).collect();
            let rest: String = chars[i + 2..].iter().collect();
            if let Some(rel) = find_unescaped(&rest, &marker) {
                let inner_text: String = rest[..rel].to_string();
                push_text(&mut out, &buf);
                buf.clear();
                let mut inner = parse_inline(&inner_text);
                apply_mark(&mut inner, json!({ "type": "bold" }));
                out.extend(inner);
                i += 2 + inner_text.chars().count() + 2;
                continue;
            }
        }

        // *em* / _em_
        if c == '*' || c == '_' {
            let rest: String = chars[i + 1..].iter().collect();
            let marker = c.to_string();
            if let Some(rel) = find_unescaped(&rest, &marker) {
                let inner_text: String = rest[..rel].to_string();
                if !inner_text.trim().is_empty() && !inner_text.starts_with(' ') {
                    push_text(&mut out, &buf);
                    buf.clear();
                    let mut inner = parse_inline(&inner_text);
                    apply_mark(&mut inner, json!({ "type": "italic" }));
                    out.extend(inner);
                    i += 1 + inner_text.chars().count() + 1;
                    continue;
                }
            }
        }

        buf.push(c);
        i += 1;
    }

    push_text(&mut out, &buf);
    out
}

/// `[label](target)` starting at `at` (which must be `[`).
/// Returns (consumed chars, label, target).
fn parse_link_like(chars: &[char], at: usize) -> Option<(usize, String, String)> {
    if chars.get(at) != Some(&'[') {
        return None;
    }
    let close = find_sub(chars, at + 1, &[']'])?;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = find_sub(chars, close + 2, &[')'])?;
    let label: String = chars[at + 1..close].iter().collect();
    let mut target: String = chars[close + 2..end].iter().collect();
    target = target.trim().to_string();
    // strip an optional title: ![alt](src "title")
    if let Some(space) = target.rfind(' ') {
        let tail = &target[space + 1..];
        if tail.starts_with('"') || tail.starts_with('\'') {
            target.truncate(space);
        }
    }
    Some((end - at + 1, label, target))
}

/// Position of the two-character sequence `needle` from `from`.
fn find_sub(chars: &[char], from: usize, needle: &[char]) -> Option<usize> {
    if needle.is_empty() || chars.len() < needle.len() {
        return None;
    }
    let mut i = from;
    while i + needle.len() <= chars.len() {
        if chars[i..i + needle.len()] == *needle {
            let mut backslashes = 0;
            let mut j = i;
            while j > 0 && chars[j - 1] == '\\' {
                backslashes += 1;
                j -= 1;
            }
            if backslashes % 2 == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// Splits YAML-ish frontmatter from the body. Returns (frontmatter, body).
fn split_frontmatter(text: &str) -> (Option<String>, String) {
    let mut lines = text.lines();
    let Some(first) = lines.next() else {
        return (None, text.to_string());
    };
    if first.trim() != "---" {
        return (None, text.to_string());
    }
    let mut front = String::new();
    let mut body = String::new();
    let mut closed = false;
    for line in lines.by_ref() {
        if !closed && (line.trim() == "---" || line.trim() == "...") {
            closed = true;
            continue;
        }
        if closed {
            body.push_str(line);
            body.push('\n');
        } else {
            front.push_str(line);
            front.push('\n');
        }
    }
    if !closed {
        return (None, text.to_string());
    }
    (Some(front), body)
}

fn frontmatter_values(front: &str, keys: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut collecting = false;
    let mut key_indent = 0usize;
    for line in front.lines() {
        let indent = indent_of(line);
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let matches_key = keys.iter().any(|k| {
            t.to_ascii_lowercase().starts_with(&format!("{k}:"))
        });
        if matches_key {
            collecting = true;
            key_indent = indent;
            let value = t.split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
            for item in split_yaml_list(value) {
                out.push(item);
            }
            continue;
        }
        if collecting {
            // a YAML list under the key
            if t.starts_with("- ") && indent >= key_indent {
                out.extend(split_yaml_list(t.trim_start_matches("- ")));
                continue;
            }
            collecting = false;
        }
    }
    out
}

fn split_yaml_list(value: &str) -> Vec<String> {
    let v = value.trim().trim_start_matches('[').trim_end_matches(']');
    if v.is_empty() {
        return Vec::new();
    }
    v.split(',')
        .map(|item| item.trim().trim_matches('"').trim_matches('\'').trim_start_matches('#').trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// Parses a Markdown document into a TipTap body.
/// Parses a Markdown snippet into a TipTap document. Used when text is pasted
/// into the editor: the same parser that imports whole files keeps the two
/// paths from drifting apart.
pub fn parse_markdown_body(text: &str) -> Value {
    parse_markdown(text).content
}

pub fn parse_markdown(text: &str) -> ParsedMarkdown {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let (front, body) = split_frontmatter(&normalized);

    let mut title = None;
    if let Some(front) = &front {
        if let Some(value) = frontmatter_values(front, &["title"]).into_iter().next() {
            if !value.is_empty() {
                title = Some(value);
            }
        }
    }

    let lines: Vec<String> = body.lines().map(|l| l.to_string()).collect();
    let mut parser = Parser::new(lines);
    let blocks = parser.parse_blocks(0);

    let content = json!({
        "type": "doc",
        "content": if blocks.is_empty() {
            json!([{ "type": "paragraph" }])
        } else {
            Value::Array(blocks)
        },
    });

    ParsedMarkdown { content, title }
}

/// Rewrites `novion://docname/<name>` links into `novion://doc/<id>`.
/// `lookup` maps a lowercased document name (and file stem) to a document id.
pub fn resolve_wiki_links(content: &mut Value, lookup: &std::collections::HashMap<String, String>) -> bool {
    fn walk(node: &mut Value, lookup: &std::collections::HashMap<String, String>, changed: &mut bool) {
        match node {
            Value::Array(items) => {
                for item in items.iter_mut() {
                    walk(item, lookup, changed);
                }
            }
            Value::Object(map) => {
                if let Some(marks) = map.get_mut("marks").and_then(Value::as_array_mut) {
                    for mark in marks.iter_mut() {
                        let Some(attrs) = mark.get_mut("attrs").and_then(Value::as_object_mut) else {
                            continue;
                        };
                        let Some(href) = attrs.get("href").and_then(Value::as_str).map(str::to_string) else {
                            continue;
                        };
                        let Some(name) = href.strip_prefix(WIKI_PREFIX) else { continue };
                        let key = name.to_lowercase();
                        if let Some(id) = lookup.get(&key) {
                            attrs.insert("href".into(), Value::String(format!("{DOC_PREFIX}{id}")));
                            *changed = true;
                        }
                    }
                }
                for value in map.values_mut() {
                    walk(value, lookup, changed);
                }
            }
            _ => {}
        }
    }
    let mut changed = false;
    walk(content, lookup, &mut changed);
    changed
}

/// Collects local asset references (`![](img.png)`, `![[img.png]]`) from a body.
pub fn collect_local_images(content: &Value) -> Vec<(String, String)> {
    fn walk(node: &Value, out: &mut Vec<(String, String)>) {
        match node {
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            Value::Object(map) => {
                if map.get("type").and_then(Value::as_str) == Some("image") {
                    let src = map
                        .get("attrs")
                        .and_then(|a| a.get("src"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let alt = map
                        .get("attrs")
                        .and_then(|a| a.get("alt"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !src.is_empty() {
                        out.push((src, alt));
                    }
                }
                for value in map.values() {
                    walk(value, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(content, &mut out);
    out
}

/// Replaces the `src` of every image node using `map` (old src → new src).
pub fn rewrite_image_srcs(content: &mut Value, map: &std::collections::HashMap<String, String>) {
    match content {
        Value::Array(items) => items.iter_mut().for_each(|item| rewrite_image_srcs(item, map)),
        Value::Object(obj) => {
            if obj.get("type").and_then(Value::as_str) == Some("image") {
                if let Some(attrs) = obj.get_mut("attrs").and_then(Value::as_object_mut) {
                    if let Some(src) = attrs.get("src").and_then(Value::as_str).map(str::to_string) {
                        if let Some(next) = map.get(&src) {
                            attrs.insert("src".into(), Value::String(next.clone()));
                        }
                    }
                }
            }
            for value in obj.values_mut() {
                rewrite_image_srcs(value, map);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Value {
        json!({
            "type": "doc",
            "content": [
                { "type": "heading", "attrs": { "level": 2 },
                  "content": [{ "type": "text", "text": "标题" }] },
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "普通 " },
                    { "type": "text", "marks": [{ "type": "bold" }], "text": "加粗" },
                    { "type": "text", "text": " 与 " },
                    { "type": "text", "marks": [{ "type": "code" }], "text": "a*b" },
                    { "type": "text", "marks": [{ "type": "link", "attrs": { "href": "https://example.com" } }], "text": "链接" }
                ] },
                { "type": "bulletList", "content": [
                    { "type": "listItem", "content": [
                        { "type": "paragraph", "content": [{ "type": "text", "text": "一项" }] },
                        { "type": "bulletList", "content": [
                            { "type": "listItem", "content": [
                                { "type": "paragraph", "content": [{ "type": "text", "text": "子项" }] } ] } ] }
                    ] }
                ] },
                { "type": "taskList", "content": [
                    { "type": "taskItem", "attrs": { "checked": true },
                      "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "做完的" }] }] },
                    { "type": "taskItem", "attrs": { "checked": false },
                      "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "没做的" }] }] }
                ] },
                { "type": "codeBlock", "attrs": { "language": "ts" },
                  "content": [{ "type": "text", "text": "const a = 1" }] },
                { "type": "blockquote", "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "引用" }] } ] },
                { "type": "horizontalRule" },
                { "type": "image", "attrs": { "src": "assets/img_a.png", "alt": "图" } }
            ]
        })
    }

    #[test]
    fn markdown_covers_every_block_type() {
        let md = to_markdown(&doc(), "");
        assert!(md.starts_with("## 标题\n\n"), "{md}");
        assert!(md.contains("普通 **加粗** 与 `a*b`[链接](https://example.com)"), "{md}");
        assert!(md.contains("- 一项\n  - 子项"), "{md}");
        assert!(md.contains("- [x] 做完的\n- [ ] 没做的"), "{md}");
        assert!(md.contains("```ts\nconst a = 1\n```"), "{md}");
        assert!(md.contains("> 引用"), "{md}");
        assert!(md.contains("\n---\n"), "{md}");
        assert!(md.ends_with("![图](assets/img_a.png)\n"), "{md}");
    }

    #[test]
    fn asset_prefix_follows_nesting_depth() {
        let md = to_markdown(&doc(), "../");
        assert!(md.contains("![图](../assets/img_a.png)"), "{md}");
    }

    #[test]
    fn prose_stays_readable_without_stray_escapes() {
        let body = json!({
            "type": "doc",
            "content": [{ "type": "paragraph", "content": [
                { "type": "text", "text": "2 * 3 = 6，文件名 a_b.txt" } ] }]
        });
        let md = to_markdown(&body, "");
        assert_eq!(md, "2 \\* 3 = 6，文件名 a\\_b.txt\n");
    }

    #[test]
    fn html_escapes_and_keeps_structure() {
        let body = json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "<script>" },
                    { "type": "text", "marks": [{ "type": "bold" }], "text": "粗" } ] },
                { "type": "codeBlock", "attrs": { "language": "js" },
                  "content": [{ "type": "text", "text": "a && b" }] }
            ]
        });
        let html = html_document("标题 & 结尾", &body);
        assert!(html.contains("&lt;script&gt;"), "{html}");
        assert!(html.contains("<strong>粗</strong>"), "{html}");
        assert!(html.contains("language-js"), "{html}");
        assert!(html.contains("a &amp;&amp; b"), "{html}");
        assert!(html.contains("标题 &amp; 结尾"), "{html}");
    }

    // ---------------------------------------------------------- markdown in

    fn blocks(md: &str) -> Vec<Value> {
        let parsed = parse_markdown(md);
        parsed.content["content"].as_array().cloned().unwrap_or_default()
    }

    fn kinds(md: &str) -> Vec<String> {
        blocks(md)
            .iter()
            .map(|b| b["type"].as_str().unwrap_or("").to_string())
            .collect()
    }

    #[test]
    fn parses_headings_paragraphs_and_inline_marks() {
        let parsed = parse_markdown("# 标题\n\n正文 **加粗** 与 *斜体* 和 `代码` 以及 ~~删除~~\n");
        assert_eq!(parsed.content["content"][0]["type"], "heading");
        assert_eq!(parsed.content["content"][0]["attrs"]["level"], 1);
        let text = serde_json::to_string(&parsed.content).unwrap();
        assert!(text.contains("\"bold\""), "{text}");
        assert!(text.contains("\"italic\""), "{text}");
        assert!(text.contains("\"code\""), "{text}");
        assert!(text.contains("\"strike\""), "{text}");
    }

    #[test]
    fn parses_nested_lists_and_tasks() {
        let md = "- 一\n  - 一.a\n  - 一.b\n- 二\n\n- [x] 做完\n- [ ] 没做\n";
        let list = &blocks(md)[0];
        assert_eq!(list["type"], "bulletList");
        let first = &list["content"][0];
        assert_eq!(first["content"][0]["content"][0]["text"], "一");
        let nested = &first["content"][1];
        assert_eq!(nested["type"], "bulletList", "{}", serde_json::to_string(list).unwrap());

        let tasks = &blocks(md)[1];
        assert_eq!(tasks["type"], "taskList");
        assert_eq!(tasks["content"][0]["attrs"]["checked"], true);
        assert_eq!(tasks["content"][1]["attrs"]["checked"], false);
    }

    #[test]
    fn parses_code_quotes_and_rules() {
        let md = "```ts\nconst a = 1;\n```\n\n> 引用\n\n---\n";
        assert_eq!(kinds(md), vec!["codeBlock", "blockquote", "horizontalRule"]);
        let code = &blocks(md)[0];
        assert_eq!(code["attrs"]["language"], "ts");
        assert_eq!(code["content"][0]["text"], "const a = 1;");
    }

    #[test]
    fn parses_gfm_tables() {
        let md = "| 列一 | 列二 |\n| --- | --- |\n| a | b |\n";
        let table = &blocks(md)[0];
        assert_eq!(table["type"], "table");
        assert_eq!(table["content"].as_array().unwrap().len(), 2);
        assert_eq!(table["content"][0]["content"][0]["type"], "tableHeader");
        assert_eq!(table["content"][1]["content"][1]["type"], "tableCell");
        assert_eq!(
            table["content"][1]["content"][1]["content"][0]["content"][0]["text"],
            "b"
        );
    }

    #[test]
    fn parses_links_images_and_wiki_links() {
        let md = "看 [例子](https://example.com) 和 [[另一篇]]\n\n![图](img.png)\n";
        let text = serde_json::to_string(&blocks(md)).unwrap();
        assert!(text.contains("https://example.com"), "{text}");
        assert!(text.contains("novion://docname/另一篇"), "{text}");
        assert!(text.contains("\"alt\":\"图\""), "{text}");
        // the image becomes its own block, never inline inside a paragraph
        assert_eq!(kinds(md), vec!["paragraph", "image"]);
    }

    #[test]
    fn frontmatter_gives_the_title() {
        let md = "---\ntitle: 我的笔记\ntags: [工作, 计划]\n---\n\n正文\n";
        let parsed = parse_markdown(md);
        assert_eq!(parsed.title.as_deref(), Some("我的笔记"));
        assert_eq!(parsed.content["content"][0]["type"], "paragraph");
    }

    #[test]
    fn wiki_links_resolve_to_document_ids() {
        let mut parsed = parse_markdown("参见 [[另一篇]]\n");
        let mut lookup = std::collections::HashMap::new();
        lookup.insert("另一篇".to_string(), "d_abc".to_string());
        assert!(resolve_wiki_links(&mut parsed.content, &lookup));
        let text = serde_json::to_string(&parsed.content).unwrap();
        assert!(text.contains("novion://doc/d_abc"), "{text}");
    }

    #[test]
    fn local_image_refs_are_collected_and_rewritten() {
        let mut parsed = parse_markdown("![a](img/a.png)\n\n![b](b.png)\n");
        let refs = collect_local_images(&parsed.content);
        assert_eq!(refs.len(), 2);
        let mut map = std::collections::HashMap::new();
        map.insert("img/a.png".to_string(), "assets/img_1.png".to_string());
        rewrite_image_srcs(&mut parsed.content, &map);
        let text = serde_json::to_string(&parsed.content).unwrap();
        assert!(text.contains("assets/img_1.png"), "{text}");
    }

    #[test]
    fn escaped_markdown_survives_the_round_trip() {
        let md = "2 \\* 3 = 6 与 a\\_b\n";
        let parsed = parse_markdown(md);
        let text = parsed.content["content"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(text, "2 * 3 = 6 与 a_b");
    }

    #[test]
    fn export_of_parsed_markdown_keeps_the_structure() {
        let md = "## 小标题\n\n- 一项\n- 二项\n\n```js\nlet a = 1\n```\n";
        let parsed = parse_markdown(md);
        let out = to_markdown(&parsed.content, "");
        assert!(out.contains("## 小标题"), "{out}");
        assert!(out.contains("- 一项"), "{out}");
        assert!(out.contains("```js\nlet a = 1\n```"), "{out}");
    }

    #[test]
    fn document_text_flattens_blocks() {
        let text = document_text(&doc());
        assert!(text.contains("标题"), "{text}");
        assert!(text.contains("[图片]"), "{text}");
        assert!(!text.contains('\n'), "{text}");
    }
}
