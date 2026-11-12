import { convertFileSrc } from "@tauri-apps/api/core";

const ASSET_URL_RE =
  /^(?:asset:\/\/localhost|http:\/\/asset\.localhost|https?:\/\/asset\.localhost)\/(.*)$/i;
const REMOTE_RE = /^(https?:|data:|blob:|asset:)/i;

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Walks TipTap-style JSON and rewrites `image.attrs.src`.
 *
 * Returns the *same reference* when nothing was rewritten. Documents without
 * images (the overwhelming majority) therefore travel through this function
 * without any copying at all, and an unchanged image keeps its object identity.
 */
function mapImageSrc(node: unknown, fn: (src: string) => string): unknown {
  if (Array.isArray(node)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < node.length; i += 1) {
      const next = mapImageSrc(node[i], fn);
      if (next !== node[i]) {
        out ??= node.slice();
        out[i] = next;
      }
    }
    return out ?? node;
  }
  if (!isJson(node)) return node;

  if (node.type === "image" && isJson(node.attrs) && typeof node.attrs.src === "string") {
    const src = node.attrs.src;
    const next = fn(src);
    if (next === src) return node;
    return { ...node, attrs: { ...node.attrs, src: next } };
  }

  let out: Json | null = null;
  for (const [key, value] of Object.entries(node)) {
    const next = mapImageSrc(value, fn);
    if (next !== value) {
      out ??= { ...node };
      out[key] = next;
    }
  }
  return out ?? node;
}

/** Windows paths arrive with backslashes; compare and slice on one separator. */
function toSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** JSON on disk stores `assets/x.png`; the editor needs an asset:// URL. */
export function absolutizeContent(content: unknown, root: string): unknown {
  if (!root) return content;
  return mapImageSrc(content, (src) => {
    if (!src || REMOTE_RE.test(src)) return src;
    return convertFileSrc(`${root}/${src.replace(/^\.?[\\/]/, "")}`);
  });
}

/** Inverse of absolutizeContent so documents stay portable. */
export function relativizeContent(content: unknown, root: string): unknown {
  if (!root) return content;
  // Root is an OS path (`/Users/me/...` or `C:\Users\me\...`) while the asset
  // URL is percent-encoded and has its own leading slash eaten by the scheme
  // (`asset://localhost/Users/...` captures `Users/...`). Both sides are folded
  // to `/` and stripped of leading separators before the prefix test, otherwise
  // the absolute URL is written into the document and the image stops
  // travelling with it.
  const base = toSlashes(root).replace(/^\/+|\/+$/g, "");
  const prefix = `${base}/`;
  return mapImageSrc(content, (src) => {
    const match = src.match(ASSET_URL_RE);
    if (!match) return src;
    let abs = match[1];
    try {
      abs = decodeURIComponent(abs);
    } catch {
      /* keep raw */
    }
    const normalized = toSlashes(abs).replace(/^\/+/, "");
    return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : src;
  });
}

/**
 * Turns the snapshot the editor hands over into plain JSON.
 *
 * The editor passes its immutable ProseMirror document (see `DocEditor`), which
 * is only converted here — at save time — instead of on every keystroke. Plain
 * JSON is passed through untouched, so both shapes are accepted.
 */
export function serializeContent(snapshot: unknown): unknown {
  if (isJson(snapshot) && typeof snapshot.toJSON === "function") {
    return (snapshot as { toJSON: () => unknown }).toJSON();
  }
  return snapshot;
}
