type Json = Record<string, unknown>;

const CONTAINERS = new Set(["bulletList", "orderedList", "taskList"]);
const BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "callout",
  "toggle",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "tableRow",
  "horizontalRule",
  "image",
  "blockMath",
]);

function inlineText(node: Json): string {
  if (typeof node.text === "string") return node.text;
  const kids = Array.isArray(node.content) ? (node.content as Json[]) : [];
  return kids.map((kid) => inlineText(kid)).join("");
}

function isBlock(node: Json): boolean {
  return typeof node.type === "string" && BLOCKS.has(node.type);
}

function blockLines(node: Json, depth: number): string[] {
  const type = String(node.type ?? "");
  const kids = Array.isArray(node.content) ? (node.content as Json[]) : [];

  if (type === "codeBlock") {
    return inlineText(node).split("\n");
  }
  if (type === "listItem" || type === "taskItem") {
    const checked = node.attrs && (node.attrs as Json).checked === true;
    const text = kids.map((kid) => inlineText(kid)).join(" ");
    return [`${"  ".repeat(depth)}- ${checked ? "[x] " : ""}${text}`];
  }
  if (type === "horizontalRule") return ["---"];
  if (type === "image") {
    const attrs = (node.attrs ?? {}) as Json;
    return [`[图片] ${String(attrs.alt ?? "")}`.trim()];
  }
  if (type === "tableRow") {
    return [`| ${kids.map((cell) => inlineText(cell)).join(" | ")} |`];
  }
  if (CONTAINERS.has(type)) {
    return kids.flatMap((kid) => blockLines(kid, depth + 1));
  }
  if (kids.some(isBlock)) {
    return kids.flatMap((kid) => (isBlock(kid) ? blockLines(kid, depth) : [inlineText(kid)]));
  }
  return [inlineText(node)];
}

/** Plain text of a TipTap document, one line per block (used by the diff view). */
export function docLines(content: unknown): string[] {
  if (!content || typeof content !== "object") return [];
  const root = content as Json;
  const kids = Array.isArray(root.content) ? (root.content as Json[]) : [];
  return kids.flatMap((kid) => (isBlock(kid) ? blockLines(kid, 0) : [inlineText(kid)]));
}

export function docText(content: unknown): string {
  return docLines(content).join("\n");
}