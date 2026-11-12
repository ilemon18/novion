import { resolveLanguage, type LanguageSpec } from "./languages";

export type TokenType =
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "builtin"
  | "literal"
  | "attr"
  | "tag"
  | "operator"
  | "punct"
  | "heading"
  | "emphasis"
  | "strong"
  | "code"
  | "link"
  | "quote"
  | "added"
  | "removed"
  | "meta";

export interface Token {
  /** byte-free offsets into the code block's text (0 = first character) */
  from: number;
  to: number;
  type: TokenType;
}

/* ------------------------------------------------------------- utilities */

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const NUMBER_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)[a-zA-Z%]*/;
const OPERATORS = new Set("=+-*/%<>!&|^~?:.@".split(""));
const PUNCT = new Set("{}()[],;".split(""));

function isNumberStart(code: string, i: number): boolean {
  const ch = code[i];
  if (DIGIT.test(ch)) return true;
  // a leading `.5` is a number, `.foo` is not
  return ch === "." && DIGIT.test(code[i + 1] ?? "");
}

/** Scans a quoted string, honouring backslash escapes and multi-line quotes. */
function scanString(code: string, start: number, quote: string): number {
  let i = start + quote.length;
  while (i < code.length) {
    if (code[i] === "\\") {
      i += 2;
      continue;
    }
    if (code.startsWith(quote, i)) return i + quote.length;
    // an unterminated single-line quote ends at the line break
    if (code[i] === "\n" && quote.length === 1) return i;
    i += 1;
  }
  return code.length;
}

function scanLineEnd(code: string, start: number): number {
  const at = code.indexOf("\n", start);
  return at < 0 ? code.length : at;
}

/* --------------------------------------------------------------- scanning */

function scanCode(code: string, spec: LanguageSpec): Token[] {
  const tokens: Token[] = [];
  const keywords = new Set(spec.keywords);
  const builtins = new Set(spec.builtins ?? []);
  const literals = new Set(spec.literals ?? []);
  const quotes = spec.quotes ?? [];
  const lineComments = spec.lineComment ?? [];
  const blockComments = spec.blockComment ?? [];
  const fold = spec.caseInsensitive ? (word: string) => word.toLowerCase() : (word: string) => word;

  let i = 0;
  const push = (from: number, to: number, type: TokenType) => {
    if (to > from) tokens.push({ from, to, type });
  };

  while (i < code.length) {
    // block comments first: they can contain anything, quotes included
    let matched = false;
    for (const [open, close] of blockComments) {
      if (!code.startsWith(open, i)) continue;
      const end = code.indexOf(close, i + open.length);
      const to = end < 0 ? code.length : end + close.length;
      push(i, to, "comment");
      i = to;
      matched = true;
      break;
    }
    if (matched) continue;

    for (const mark of lineComments) {
      if (!code.startsWith(mark, i)) continue;
      const to = scanLineEnd(code, i);
      push(i, to, "comment");
      i = to;
      matched = true;
      break;
    }
    if (matched) continue;

    const quote = quotes.find((q) => code.startsWith(q, i));
    if (quote) {
      const to = scanString(code, i, quote);
      // JSON/object keys read better as attributes than as plain strings
      const after = code.slice(to, to + 24).trimStart();
      push(i, to, after.startsWith(":") ? "attr" : "string");
      i = to;
      continue;
    }

    if (isNumberStart(code, i)) {
      const rest = code.slice(i);
      const hit = NUMBER_RE.exec(rest);
      if (hit && hit[0].length > 0) {
        push(i, i + hit[0].length, "number");
        i += hit[0].length;
        continue;
      }
    }

    const ch = code[i];
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < code.length && IDENT_PART.test(code[j])) j += 1;
      const word = code.slice(i, j);
      const probe = fold(word);
      let type: TokenType | null = null;
      if (keywords.has(probe) || keywords.has(probe.replace(/^@/, ""))) type = "keyword";
      else if (builtins.has(probe)) type = "builtin";
      else if (literals.has(probe)) type = "literal";
      if (type) push(i, j, type);
      i = j;
      continue;
    }

    if (OPERATORS.has(ch)) {
      let j = i + 1;
      // keep runs such as `=>`, `===`, `::` in one token
      while (j < code.length && OPERATORS.has(code[j]) && j - i < 4) j += 1;
      push(i, j, "operator");
      i = j;
      continue;
    }

    if (PUNCT.has(ch)) {
      push(i, i + 1, "punct");
      i += 1;
      continue;
    }

    i += 1;
  }
  return tokens;
}

function scanMarkup(code: string, spec: LanguageSpec): Token[] {
  const tokens: Token[] = [];
  const push = (from: number, to: number, type: TokenType) => {
    if (to > from) tokens.push({ from, to, type });
  };
  const comment = spec.blockComment?.[0] ?? ["<!--", "-->"];

  let i = 0;
  while (i < code.length) {
    if (code.startsWith(comment[0], i)) {
      const end = code.indexOf(comment[1], i + comment[0].length);
      const to = end < 0 ? code.length : end + comment[1].length;
      push(i, to, "comment");
      i = to;
      continue;
    }

    const lt = code.indexOf("<", i);
    if (lt < 0) break;
    i = lt;

    if (code.startsWith("</", i) || code.startsWith("<!", i) || code.startsWith("<?", i)) {
      push(i, i + 2, "punct");
      i += 2;
    } else {
      push(i, i + 1, "punct");
      i += 1;
    }

    // tag name
    let j = i;
    while (j < code.length && /[A-Za-z0-9:_-]/.test(code[j])) j += 1;
    push(i, j, "tag");
    i = j;

    // attributes until the tag closes
    while (i < code.length && code[i] !== ">") {
      const ch = code[i];
      if (ch === '"' || ch === "'") {
        const to = scanString(code, i, ch);
        push(i, to, "string");
        i = to;
        continue;
      }
      if (/[A-Za-z_:@[]/.test(ch)) {
        let k = i + 1;
        while (k < code.length && /[A-Za-z0-9_:.@[\]-]/.test(code[k])) k += 1;
        push(i, k, "attr");
        i = k;
        continue;
      }
      if (ch === "=") {
        push(i, i + 1, "operator");
        i += 1;
        continue;
      }
      i += 1;
    }
    if (i < code.length) {
      push(i, i + 1, "punct");
      i += 1;
    }
  }
  return tokens;
}

function scanInline(line: string, offset: number, out: Token[]): void {
  const push = (from: number, to: number, type: TokenType) => {
    if (to > from) out.push({ from: offset + from, to: offset + to, type });
  };

  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);

    const fence = /^(`{1,2})([^`]+)\1/.exec(rest);
    if (fence) {
      push(i, i + fence[0].length, "code");
      i += fence[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]*)[^)]*\)/.exec(rest);
    if (link) {
      push(i, i + link[0].length, "link");
      i += link[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong) {
      push(i, i + strong[0].length, "strong");
      i += strong[0].length;
      continue;
    }

    const emphasis = /^(\*|_)(?=[^\s*_])([^*_]*[^\s*_])\1/.exec(rest);
    if (emphasis) {
      push(i, i + emphasis[0].length, "emphasis");
      i += emphasis[0].length;
      continue;
    }

    i += 1;
  }
}

function scanMarkdown(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let fenced = false;

  while (i < code.length) {
    const end = code.indexOf("\n", i);
    const lineEnd = end < 0 ? code.length : end;
    const line = code.slice(i, lineEnd);

    if (/^\s*(```|~~~)/.test(line)) {
      tokens.push({ from: i, to: lineEnd, type: "meta" });
      fenced = !fenced;
      i = end < 0 ? code.length : end + 1;
      continue;
    }

    if (fenced) {
      tokens.push({ from: i, to: lineEnd, type: "code" });
      i = end < 0 ? code.length : end + 1;
      continue;
    }

    const heading = /^(#{1,6})\s/.exec(line);
    if (heading) {
      tokens.push({ from: i, to: lineEnd, type: "heading" });
    } else if (/^\s*>/.test(line)) {
      tokens.push({ from: i, to: lineEnd, type: "quote" });
    } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      const mark = /^\s*([-*+]|\d+[.)])\s/.exec(line);
      const markEnd = mark ? mark[0].length : 0;
      tokens.push({ from: i, to: i + markEnd, type: "keyword" });
      scanInline(line.slice(markEnd), i + markEnd, tokens);
    } else if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      tokens.push({ from: i, to: lineEnd, type: "meta" });
    } else {
      scanInline(line, i, tokens);
    }

    i = end < 0 ? code.length : end + 1;
  }
  return tokens;
}

/**
 * CSS is its own little language: selectors outside the braces, declarations
 * inside them. Treating it as generic code left property names and hex colours
 * uncoloured, which is exactly the part readers scan for.
 */
function scanCss(code: string): Token[] {
  const tokens: Token[] = [];
  const push = (from: number, to: number, type: TokenType) => {
    if (to > from) tokens.push({ from, to, type });
  };

  let i = 0;
  let depth = 0;
  while (i < code.length) {
    if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      const to = end < 0 ? code.length : end + 2;
      push(i, to, "comment");
      i = to;
      continue;
    }
    const ch = code[i];

    if (ch === '"' || ch === "'") {
      const to = scanString(code, i, ch);
      push(i, to, "string");
      i = to;
      continue;
    }

    // hex colours read as numbers, `#` included
    if (ch === "#" && /[0-9a-fA-F]/.test(code[i + 1] ?? "")) {
      let j = i + 1;
      while (j < code.length && /[0-9a-fA-F]/.test(code[j])) j += 1;
      push(i, j, "number");
      i = j;
      continue;
    }

    if (isNumberStart(code, i)) {
      const hit = NUMBER_RE.exec(code.slice(i));
      if (hit && hit[0].length > 0) {
        push(i, i + hit[0].length, "number");
        i += hit[0].length;
        continue;
      }
    }

    if (ch === "@") {
      let j = i + 1;
      while (j < code.length && /[A-Za-z-]/.test(code[j])) j += 1;
      push(i, j, "keyword");
      i = j;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      push(i, i + 1, "punct");
      i += 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      push(i, i + 1, "punct");
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "," || ch === "(" || ch === ")" || ch === "[" || ch === "]") {
      push(i, i + 1, "punct");
      i += 1;
      continue;
    }

    if (IDENT_START.test(ch) || ch === "-" || ch === "." || ch === "#") {
      const start = i;
      if (ch === "-" || ch === "." || ch === "#") i += 1;
      let j = i;
      while (j < code.length && (IDENT_PART.test(code[j]) || code[j] === "-")) j += 1;
      if (j === i) {
        // a lone `.` / `#` / `-` (child combinator, minus, …)
        push(start, start + 1, "operator");
        i = start + 1;
        continue;
      }
      const rest = code.slice(j).trimStart();
      let type: TokenType | null;
      if (depth === 0) type = "tag"; // selector
      else if (rest.startsWith(":")) type = "attr"; // property name
      else if (rest.startsWith("(")) type = "builtin"; // function, e.g. rgb(
      else type = null; // bare value keyword such as `solid`
      if (type) push(start, j, type);
      i = j;
      continue;
    }

    if ("=+>~*/!".includes(ch)) {
      push(i, i + 1, "operator");
      i += 1;
      continue;
    }

    i += 1;
  }
  return tokens;
}

function scanDiff(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const end = code.indexOf("\n", i);
    const lineEnd = end < 0 ? code.length : end;
    const line = code.slice(i, lineEnd);
    const type: TokenType =
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
        ? "meta"
        : line.startsWith("+")
          ? "added"
          : line.startsWith("-")
            ? "removed"
            : "comment";
    if (line.length > 0) tokens.push({ from: i, to: lineEnd, type });
    i = end < 0 ? code.length : end + 1;
  }
  return tokens;
}

/* ------------------------------------------------------------------ entry */

/** Tokenizes `code` with `spec`. Offsets are relative to the whole string. */
export function tokenize(code: string, spec: LanguageSpec): Token[] {
  switch (spec.mode) {
    case "markup":
      return scanMarkup(code, spec);
    case "markdown":
      return scanMarkdown(code);
    case "diff":
      return scanDiff(code);
    case "css":
      return scanCss(code);
    default:
      return scanCode(code, spec);
  }
}

/* ------------------------------------------------------------ auto-detect */

/**
 * Cheap language guess for code blocks that never had a language set (the
 * slash menu cannot know what the user is about to type).
 *
 * A table of blunt signals beats statistical cleverness here: each rule is a
 * pattern that essentially only appears in one language, the score is the sum
 * of what matched, and a wrong guess costs a different colour — never broken
 * text. Anything below the threshold is left as plain text.
 */
interface Signal {
  id: string;
  re: RegExp;
  points: number;
  /** multiply by the match count (capped) instead of a flat bonus */
  perMatch?: boolean;
  /** repeat up to this many times when `perMatch` is set */
  cap?: number;
}

const SIGNALS: Signal[] = [
  // markup: a matched open/close pair is decisive, a lone `<T>` is not
  { id: "html", re: /<([a-zA-Z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1>/g, points: 8 },
  { id: "html", re: /<!DOCTYPE\s+html/gi, points: 8 },
  { id: "html", re: /<\/[a-zA-Z][\w:-]*>/g, points: 4, perMatch: true, cap: 2 },

  // stylesheets
  { id: "css", re: /@media|@import|@supports|@keyframes/g, points: 5 },
  { id: "css", re: /!important/g, points: 4 },
  { id: "css", re: /#[0-9a-fA-F]{3,8}\b/g, points: 3, perMatch: true, cap: 2 },
  { id: "css", re: /\b\d+(px|rem|em|vh|vw|fr|ms)\b/g, points: 2, perMatch: true, cap: 2 },
  // a declaration inside braces: `{ color: red; }` — weak, but it adds up
  { id: "css", re: /\{[^}]*[\w-]+\s*:\s*[^;{}]+;/, points: 2 },

  // queries
  { id: "sql", re: /\bselect\b[\s\S]{0,400}?\bfrom\b/i, points: 6 },
  { id: "sql", re: /\b(insert\s+into|create\s+table|drop\s+table|alter\s+table)\b/i, points: 4 },

  // python
  { id: "python", re: /^\s*(async\s+)?def\s+\w+\s*\(/m, points: 6 },
  { id: "python", re: /^\s*(from\s+[\w.]+\s+)?import\s+[\w.]+/m, points: 3 },
  { id: "python", re: /^\s*(for|while|if|elif|else|try|except|finally|with|class)\b[^\n{]*:\s*$/m, points: 3 },
  { id: "python", re: /\b(self|None|True|False)\b/g, points: 2, perMatch: true, cap: 2 },
  { id: "python", re: /\b(print|len|range|enumerate|zip|isinstance)\(/g, points: 2, perMatch: true, cap: 2 },

  // rust
  { id: "rust", re: /\bfn\s+\w+/g, points: 7 },
  { id: "rust", re: /\blet\s+mut\b|::<|println!|->/g, points: 4, perMatch: true, cap: 1 },
  { id: "rust", re: /&'\w+/g, points: 3 },

  // go
  { id: "go", re: /\bfunc\s+(\w+\s*)?\(/g, points: 6 },
  { id: "go", re: /^\s*package\s+\w+\s*$/m, points: 5 },
  { id: "go", re: /:=/g, points: 3, perMatch: true, cap: 2 },

  // javascript / typescript
  { id: "javascript", re: /^\s*(export\s+)?(async\s+)?(function|const|let|var)\b/m, points: 4 },
  { id: "javascript", re: /=>/g, points: 3, perMatch: true, cap: 1 },
  { id: "javascript", re: /\bconsole\.\w+|\bdocument\.\w+/g, points: 3 },
  { id: "typescript", re: /:\s*(string|number|boolean|void|unknown|any|never)\b/g, points: 5, perMatch: true, cap: 1 },
  { id: "typescript", re: /\b(interface|type)\s+\w+\s*[={]/g, points: 4, perMatch: true, cap: 1 },

  // shells
  { id: "bash", re: /^#!\s*\S*(ba|z|k|da)?sh\b/m, points: 10 },
  { id: "bash", re: /^\s*(echo|printf|export|local|readonly|source|alias)\b/gm, points: 3, perMatch: true, cap: 2 },
  { id: "bash", re: /^\s*(fi|done|esac|then|else|do)\s*$/gm, points: 4, perMatch: true, cap: 1 },
  { id: "bash", re: /\$\(|\$\{/g, points: 2, perMatch: true, cap: 1 },

  // config
  { id: "yaml", re: /^\s*[\w.-]+\s*:\s+[^\s].*$/gm, points: 4, perMatch: true, cap: 2 },
  { id: "yaml", re: /^\s*-\s+\S/m, points: 2 },

  // diff
  { id: "diff", re: /^@@ .* @@/gm, points: 9 },
  { id: "diff", re: /^--- .+$/m, points: 5 },
  { id: "diff", re: /^\+\+\+ .+$/m, points: 5 },

  // markdown
  { id: "markdown", re: /^\s*(```|~~~)/m, points: 6 },
  { id: "markdown", re: /^#{1,6}\s+\S/m, points: 4 },
  { id: "markdown", re: /^\s*[-*+]\s+\S/gm, points: 2, perMatch: true, cap: 2 },
  { id: "markdown", re: /^\s*>\s+\S/m, points: 2 },

  // c-family fallback
  { id: "java", re: /\b(class|public|private|protected|void)\b/g, points: 2, perMatch: true, cap: 2 },
];

const THRESHOLD = 4;

export function detectLanguage(code: string): LanguageSpec | null {
  const text = code.trim();
  if (!text) return null;

  // JSON parses or it does not — the single most reliable signal available
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return resolveLanguage("json");
    } catch {
      /* not JSON */
    }
  }

  const score = new Map<string, number>();
  for (const signal of SIGNALS) {
    const matches = text.match(signal.re);
    if (!matches || matches.length === 0) continue;
    const hits = signal.perMatch ? Math.min(matches.length, signal.cap ?? 1) : 1;
    score.set(signal.id, (score.get(signal.id) ?? 0) + signal.points * hits);
  }

  // a JS/TS source that happens to contain markup (JSX) is still source
  if ((score.get("javascript") ?? 0) > 0 && /=>|\breturn\b/.test(text)) {
    score.set("javascript", (score.get("javascript") ?? 0) + 2);
  }

  let best: { id: string; points: number } | null = null;
  for (const [id, points] of score) {
    if (!best || points > best.points) best = { id, points };
  }
  if (!best || best.points < THRESHOLD) return null;
  return resolveLanguage(best.id);
}

/** Tokenizes with either the declared language or a best-effort guess. */
export function highlight(code: string, language?: string | null): Token[] {
  const spec = resolveLanguage(language) ?? detectLanguage(code);
  if (!spec) return [];
  return tokenize(code, spec);
}
