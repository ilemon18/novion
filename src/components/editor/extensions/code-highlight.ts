import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { highlight, type Token } from "@/lib/highlight/tokenize";

/**
 * Syntax highlighting for code blocks.
 *
 * Pure decoration layer: the document (and therefore the JSON on disk) keeps
 * exactly one plain text node per code block, so highlighting can be removed or
 * changed without touching stored data.
 *
 * `language` comes from the node's own attribute (set by the Rust/JSON format
 * already); when it is missing the block is auto-detected once.
 */

/** Blocks above this size stay plain: highlighting must never make typing lag. */
const MAX_HIGHLIGHT_CHARS = 20_000;
/**
 * Small LRU of token lists, keyed by language + text.
 *
 * Bounded by *tokens* as well as by entries: a single 20 000-character code
 * block can produce thousands of tokens, so 48 entries alone could pin tens of
 * megabytes of decoration data for code the user has scrolled past.
 */
const CACHE_LIMIT = 48;
const CACHE_TOKEN_BUDGET = 40_000;
const tokenCache = new Map<string, Token[]>();
let cachedTokens = 0;

function forget(key: string) {
  const tokens = tokenCache.get(key);
  if (!tokens) return;
  cachedTokens -= tokens.length;
  tokenCache.delete(key);
}

function tokensFor(language: string | null, text: string): Token[] {
  const key = `${language ?? ""}\u0000${text}`;
  const cached = tokenCache.get(key);
  if (cached) {
    // refresh recency
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached;
  }
  const tokens = highlight(text, language);
  if (tokenCache.size >= CACHE_LIMIT) {
    const oldest = tokenCache.keys().next();
    if (!oldest.done) forget(oldest.value);
  }
  while (cachedTokens + tokens.length > CACHE_TOKEN_BUDGET && tokenCache.size > 0) {
    const oldest = tokenCache.keys().next();
    if (oldest.done) break;
    forget(oldest.value);
  }
  tokenCache.set(key, tokens);
  cachedTokens += tokens.length;
  return tokens;
}

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    const text = node.textContent;
    if (!text || text.length > MAX_HIGHLIGHT_CHARS) return false;

    const language = (node.attrs.language as string | null | undefined) ?? null;
    for (const token of tokensFor(language, text)) {
      // +1 skips the code block's opening token
      decorations.push(
        Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, {
          class: `tok-${token.type}`,
        }),
      );
    }
    return false;
  });

  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export const CodeHighlight = Extension.create({
  name: "codeHighlight",

  addProseMirrorPlugins() {
    // decorations are rebuild only when the document itself changed: a caret
    // move or a selection update re-runs `props.decorations` too
    let lastDoc: ProseMirrorNode | null = null;
    let lastSet: DecorationSet = DecorationSet.empty;

    return [
      new Plugin({
        key: new PluginKey("codeHighlight"),
        props: {
          decorations(state) {
            if (state.doc === lastDoc) return lastSet;
            lastDoc = state.doc;
            lastSet = buildDecorations(state.doc);
            return lastSet;
          },
        },
      }),
    ];
  },
});
