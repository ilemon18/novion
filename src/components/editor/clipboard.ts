import type { Fragment, Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Copy / cut with a clipboard flavour that survives other applications.
 *
 * ProseMirror serialises a list item as `<li><p>…</p></li>`. That is valid
 * HTML, but any target that does not share our stylesheet — Word, Pages,
 * Notion, 飞书, 微信, Apple Notes, Slack — gives that inner `p` its default
 * top/bottom margin, so a copied bullet list arrives with a blank line
 * between every item while the in-app rendering looks tight.
 *
 * Unwrapping the paragraph of an item (and joining a second paragraph with a
 * hard break, the way those editors write it themselves) makes the spacing
 * travel with the text instead of depending on CSS we cannot ship. The rule
 * covers `<ul>`, `<ol>`, task lists and nested lists identically, so copy and
 * cut behave the same everywhere in the document.
 *
 * The `text/plain` flavour needs its own pass: ProseMirror's default is
 * `textBetween(…, "\n\n")`, which separates *every* block with a blank line and
 * has no notion of list markers. Targets that only keep plain text (chat
 * boxes, terminal, some editors' "paste as text") therefore showed a blank
 * line between list items and lost the numbering. `fragmentToText` walks the
 * document model instead and writes the markers itself.
 */

const LIST_NODES = new Set(["bulletList", "orderedList", "taskList"]);
/** nested lists are indented one step further than their parent item */
const INDENT = "  ";

function isList(node: PMNode): boolean {
  return LIST_NODES.has(node.type.name);
}

/**
 * Text of an inline container.
 *
 * A hard break is a newline; anything else that is a leaf (an image, for
 * example) contributes nothing, matching what ProseMirror's own plain-text
 * serialisation would have produced.
 */
function inlineText(node: PMNode): string {
  return node.textBetween(0, node.content.size, "\n", (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : "",
  );
}

/** Appends `node`'s text to `out`, one line per entry. */
function blockLines(node: PMNode, indent: string, out: string[]): void {
  const name = node.type.name;

  if (isList(node)) {
    listLines(node, indent, out);
    return;
  }
  if (name === "codeBlock") {
    for (const line of node.textContent.replace(/\r\n?/g, "\n").split("\n")) {
      out.push(indent + line);
    }
    return;
  }
  if (name === "blockquote") {
    const inner: string[] = [];
    node.forEach((child) => blockLines(child, "", inner));
    for (const line of inner) out.push(`${indent}> ${line}`);
    return;
  }
  if (name === "horizontalRule") {
    out.push(`${indent}---`);
    return;
  }
  if (name === "table") {
    tableLines(node, indent, out);
    return;
  }
  if (name === "image") {
    // an image has no text; its alt label is the only portable description
    const alt = String(node.attrs.alt ?? "").trim();
    if (alt) out.push(indent + alt);
    return;
  }
  if (node.isText) {
    for (const line of node.textContent.split("\n")) out.push(indent + line);
    return;
  }
  if (node.isTextblock) {
    for (const line of inlineText(node).split("\n")) out.push(indent + line);
    return;
  }
  // containers: doc, callout, toggle, or a list item copied on its own
  node.forEach((child) => blockLines(child, indent, out));
}

/** `- ` / `1. ` / `- [x] ` prefixes, one line per item, no blank lines. */
function listLines(list: PMNode, indent: string, out: string[]): void {
  const task = list.type.name === "taskList";
  const start = list.type.name === "orderedList" ? Number(list.attrs.start) || 1 : 0;

  list.forEach((item, _offset, index) => {
    const marker = task
      ? item.attrs.checked
        ? "- [x] "
        : "- [ ] "
      : start > 0
        ? `${start + index}. `
        : "- ";
    listItemLines(item, indent, marker, out);
  });
}

/**
 * One list item. The first block sits on the marker line; later blocks (and
 * the wrapped lines of a multi-line block) hang under the marker instead of
 * being pushed to a new line with a blank separator.
 */
function listItemLines(
  item: PMNode,
  indent: string,
  marker: string,
  out: string[],
): void {
  const hang = indent + " ".repeat(marker.length);
  let first = true;

  item.forEach((child) => {
    if (isList(child)) {
      listLines(child, indent + INDENT, out);
      first = false;
      return;
    }

    const inner: string[] = [];
    blockLines(child, "", inner);
    if (first) {
      inner.forEach((line, index) => {
        const pad = index === 0 ? "" : " ".repeat(marker.length);
        out.push(`${indent}${marker}${pad}${line}`);
      });
      first = false;
    } else {
      for (const line of inner) out.push(hang + line);
    }
  });

  if (first) out.push((indent + marker).trimEnd());
}

function tableLines(table: PMNode, indent: string, out: string[]): void {
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      const inner: string[] = [];
      cell.forEach((child) => blockLines(child, "", inner));
      cells.push(inner.join(" ").trim());
    });
    out.push(indent + cells.join(" | "));
  });
}

/**
 * Plain text for a copied slice.
 *
 * Top-level blocks are separated by one blank line (readable paragraphs); list
 * items stay on consecutive lines so a list travels as a list, not as a stack
 * of one-line paragraphs.
 */
export function fragmentToText(fragment: Fragment): string {
  const blocks: string[] = [];
  fragment.forEach((child) => {
    const lines: string[] = [];
    blockLines(child, "", lines);
    // a block that contributes no text (an image without alt) must not leave a
    // stray blank line behind: only blocks that produced something are joined
    if (lines.length) blocks.push(lines.join("\n"));
  });
  return blocks.join("\n\n");
}

/**
 * Flattens paragraphs inside every list item.
 *
 * `li > p > (inline)` becomes `li > (inline)`; a following `p` starts with a
 * `<br>` so multi-paragraph items keep their line breaks. Anything still
 * wrapped in a paragraph afterwards (task list items nest their text in a
 * `div`) gets an explicit zero margin, which is the portable way to say
 * "no gap" when the target reads inline styles instead of the element.
 */
function tightenListItems(root: ParentNode): void {
  for (const item of Array.from(root.querySelectorAll("li"))) {
    const paragraphs = Array.from(item.children).filter(
      (child): child is HTMLElement => child.tagName === "P",
    );
    paragraphs.forEach((paragraph, index) => {
      const fragment = item.ownerDocument.createDocumentFragment();
      if (index > 0) fragment.appendChild(item.ownerDocument.createElement("br"));
      while (paragraph.firstChild) fragment.appendChild(paragraph.firstChild);
      paragraph.replaceWith(fragment);
    });
  }

  for (const paragraph of Array.from(root.querySelectorAll("li p"))) {
    paragraph.setAttribute("style", "margin:0;padding:0");
  }
}

/**
 * Writes the current selection to the clipboard and returns `true` when it
 * took over the event, so the caller can short-circuit ProseMirror's own
 * handler (which would write the untightened HTML again).
 *
 * `view.serializeForClipboard` is ProseMirror's own serializer, so the
 * `data-pm-slice` marker that gives in-app paste its fidelity is preserved —
 * only the paragraph wrappers inside list items are rewritten.
 */
export function copySelection(
  view: EditorView,
  event: ClipboardEvent,
  cut: boolean,
): boolean {
  const selection = view.state.selection;
  if (selection.empty) return false;
  // a webview older than IE15/iOS604 has no usable clipboard API; let the
  // built-in handler fall back to its off-screen copy buffer
  const data = event.clipboardData;
  if (!data) return false;

  const slice = selection.content();
  const { dom } = view.serializeForClipboard(slice);
  tightenListItems(dom);

  event.preventDefault();
  data.clearData();
  data.setData("text/html", dom.innerHTML);
  data.setData("text/plain", fragmentToText(slice.content));

  if (cut) {
    view.dispatch(
      view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"),
    );
  }
  return true;
}