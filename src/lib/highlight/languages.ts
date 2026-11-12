/**
 * Language descriptions for the built-in highlighter.
 *
 * Deliberately data-only: the tokenizer is language agnostic and reads these
 * tables, so adding a language costs a few lines and no bundler weight. The
 * lists cover the common cases rather than every reserved word of every
 * standard — a notes app only needs the code to be scannable.
 */
export type LanguageId =
  | "plaintext"
  | "javascript"
  | "typescript"
  | "json"
  | "python"
  | "rust"
  | "bash"
  | "html"
  | "css"
  | "sql"
  | "markdown"
  | "yaml"
  | "go"
  | "c"
  | "java"
  | "diff";

/** How the generic scanner should treat the source. */
export type Mode = "code" | "markup" | "markdown" | "diff" | "css";

export interface LanguageSpec {
  id: LanguageId;
  /** labels users type in the code-block language field */
  aliases: string[];
  mode: Mode;
  keywords: string[];
  /** well-known identifiers that deserve their own colour */
  builtins?: string[];
  /** `true` / `false` / `null` style literals */
  literals?: string[];
  lineComment?: string[];
  blockComment?: [string, string][];
  /** quote characters that open a string */
  quotes?: string[];
  /** template literals / raw strings that only end on the same quote */
  caseInsensitive?: boolean;
}

export const LANGUAGES: LanguageSpec[] = [
  {
    id: "javascript",
    aliases: ["javascript", "js", "jsx", "mjs", "cjs", "node"],
    mode: "code",
    keywords: [
      "const", "let", "var", "function", "return", "if", "else", "for", "while",
      "do", "switch", "case", "default", "break", "continue", "new", "delete",
      "typeof", "instanceof", "in", "of", "class", "extends", "super", "this",
      "try", "catch", "finally", "throw", "async", "await", "yield", "import",
      "from", "export", "as", "static", "get", "set", "void", "with", "debugger",
    ],
    builtins: [
      "console", "window", "document", "Object", "Array", "String", "Number",
      "Boolean", "Math", "JSON", "Promise", "Map", "Set", "Date", "RegExp",
      "Error", "Symbol", "require", "module", "process", "globalThis",
    ],
    literals: ["true", "false", "null", "undefined", "NaN", "Infinity"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ["'", '"', "`"],
  },
  {
    id: "typescript",
    aliases: ["typescript", "ts", "tsx", "mts", "cts"],
    mode: "code",
    keywords: [
      "const", "let", "var", "function", "return", "if", "else", "for", "while",
      "do", "switch", "case", "default", "break", "continue", "new", "delete",
      "typeof", "instanceof", "in", "of", "class", "extends", "implements",
      "interface", "type", "enum", "namespace", "declare", "abstract", "public",
      "private", "protected", "readonly", "static", "super", "this", "try",
      "catch", "finally", "throw", "async", "await", "yield", "import", "from",
      "export", "as", "satisfies", "keyof", "infer", "is", "asserts", "override",
    ],
    builtins: [
      "console", "Object", "Array", "String", "Number", "Boolean", "Math",
      "JSON", "Promise", "Map", "Set", "Date", "RegExp", "Error", "Record",
      "Partial", "Readonly", "Pick", "Omit", "unknown", "never", "any", "void",
    ],
    literals: ["true", "false", "null", "undefined", "NaN", "Infinity"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ["'", '"', "`"],
  },
  {
    id: "json",
    aliases: ["json", "jsonc", "json5"],
    mode: "code",
    keywords: [],
    builtins: [],
    literals: ["true", "false", "null"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"'],
  },
  {
    id: "python",
    aliases: ["python", "py", "py3"],
    mode: "code",
    keywords: [
      "def", "class", "return", "if", "elif", "else", "for", "while", "break",
      "continue", "import", "from", "as", "with", "try", "except", "finally",
      "raise", "pass", "lambda", "yield", "global", "nonlocal", "assert", "del",
      "in", "is", "not", "and", "or", "async", "await", "match", "case",
    ],
    builtins: [
      "print", "len", "range", "str", "int", "float", "bool", "list", "dict",
      "set", "tuple", "sum", "min", "max", "sorted", "enumerate", "zip", "open",
      "isinstance", "type", "super", "self", "None", "True", "False",
    ],
    literals: ["True", "False", "None"],
    lineComment: ["#"],
    blockComment: [],
    quotes: ["'", '"'],
  },
  {
    id: "rust",
    aliases: ["rust", "rs"],
    mode: "code",
    keywords: [
      "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait",
      "pub", "use", "mod", "crate", "self", "super", "as", "if", "else", "match",
      "for", "while", "loop", "break", "continue", "return", "where", "async",
      "await", "move", "ref", "dyn", "unsafe", "extern", "type", "in",
    ],
    builtins: [
      "Vec", "String", "Option", "Result", "Some", "None", "Ok", "Err", "Box",
      "HashMap", "HashSet", "Rc", "Arc", "Mutex", "i8", "i16", "i32", "i64",
      "u8", "u16", "u32", "u64", "f32", "f64", "usize", "isize", "bool", "str",
      "println", "format", "vec", "panic", "todo", "unwrap",
    ],
    literals: ["true", "false"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"'],
  },
  {
    id: "go",
    aliases: ["go", "golang"],
    mode: "code",
    keywords: [
      "func", "package", "import", "var", "const", "type", "struct", "interface",
      "map", "chan", "go", "defer", "select", "case", "default", "if", "else",
      "for", "range", "break", "continue", "return", "switch", "fallthrough",
      "goto",
    ],
    builtins: [
      "fmt", "string", "int", "int64", "float64", "bool", "byte", "rune",
      "error", "make", "new", "len", "cap", "append", "copy", "delete", "panic",
      "recover", "print", "println", "nil",
    ],
    literals: ["true", "false", "nil", "iota"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"', "`"],
  },
  {
    id: "c",
    aliases: ["c", "h", "cpp", "c++", "cxx", "hpp", "objc", "objective-c"],
    mode: "code",
    keywords: [
      "auto", "break", "case", "char", "const", "continue", "default", "do",
      "double", "else", "enum", "extern", "float", "for", "goto", "if", "inline",
      "int", "long", "register", "return", "short", "signed", "sizeof", "static",
      "struct", "switch", "typedef", "union", "unsigned", "void", "volatile",
      "while", "class", "namespace", "template", "public", "private", "protected",
      "virtual", "override", "constexpr", "nullptr", "using",
    ],
    builtins: [
      "printf", "malloc", "free", "memcpy", "strlen", "std", "string", "vector",
      "size_t", "uint32_t", "int32_t", "NULL",
    ],
    literals: ["true", "false", "nullptr", "NULL"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"', "'"],
  },
  {
    id: "java",
    aliases: ["java", "kotlin", "kt", "scala", "swift"],
    mode: "code",
    keywords: [
      "class", "interface", "enum", "extends", "implements", "public", "private",
      "protected", "static", "final", "abstract", "void", "int", "long",
      "double", "float", "boolean", "char", "byte", "short", "new", "return",
      "if", "else", "for", "while", "do", "switch", "case", "default", "break",
      "continue", "try", "catch", "finally", "throw", "throws", "import",
      "package", "this", "super", "var", "val", "fun", "object", "when", "let",
      "guard", "struct", "protocol", "extension",
    ],
    builtins: [
      "String", "Object", "System", "List", "Map", "Set", "ArrayList", "HashMap",
      "Integer", "Boolean", "Double", "Exception", "Optional", "Stream",
    ],
    literals: ["true", "false", "null", "nil"],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"', "'"],
  },
  {
    id: "bash",
    aliases: ["bash", "sh", "shell", "zsh", "console", "shellscript"],
    mode: "code",
    keywords: [
      "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
      "case", "esac", "function", "in", "select", "time", "return", "break",
      "continue", "export", "local", "readonly", "declare", "source", "alias",
      "unset", "shift", "eval", "exec", "trap",
    ],
    builtins: [
      "echo", "printf", "cd", "pwd", "ls", "cp", "mv", "rm", "mkdir", "cat",
      "grep", "sed", "awk", "find", "chmod", "chown", "curl", "git", "sudo",
      "npm", "pnpm", "node", "python", "cargo", "make", "open", "which", "test",
    ],
    literals: ["true", "false"],
    lineComment: ["#"],
    blockComment: [],
    quotes: ['"', "'"],
  },
  {
    id: "sql",
    aliases: ["sql", "mysql", "postgres", "postgresql", "sqlite"],
    mode: "code",
    keywords: [
      "select", "from", "where", "insert", "into", "values", "update", "set",
      "delete", "create", "table", "alter", "drop", "index", "join", "left",
      "right", "inner", "outer", "full", "on", "group", "by", "order", "having",
      "limit", "offset", "union", "all", "distinct", "as", "and", "or", "not",
      "null", "is", "in", "between", "like", "exists", "case", "when", "then",
      "else", "end", "primary", "key", "foreign", "references", "default",
      "constraint", "begin", "commit", "rollback",
    ],
    builtins: [
      "count", "sum", "avg", "min", "max", "coalesce", "cast", "now", "date",
      "varchar", "integer", "text", "boolean", "timestamp", "serial",
    ],
    literals: ["true", "false", "null"],
    caseInsensitive: true,
    lineComment: ["--"],
    blockComment: [["/*", "*/"]],
    quotes: ["'", '"'],
  },
  {
    id: "yaml",
    aliases: ["yaml", "yml", "toml", "ini", "properties"],
    mode: "code",
    keywords: [],
    builtins: [],
    literals: ["true", "false", "null", "yes", "no", "on", "off"],
    lineComment: ["#"],
    blockComment: [],
    quotes: ['"', "'"],
  },
  {
    id: "html",
    aliases: ["html", "xml", "svg", "vue", "svelte", "htm"],
    mode: "markup",
    keywords: [],
    lineComment: [],
    blockComment: [["<!--", "-->"]],
    quotes: ['"', "'"],
  },
  {
    id: "css",
    aliases: ["css", "scss", "sass", "less", "stylus"],
    mode: "css",
    keywords: [
      "@media", "@import", "@supports", "@keyframes", "@font-face", "@layer",
      "important", "from", "to", "and", "not", "only",
    ],
    builtins: [],
    literals: [],
    lineComment: ["//"],
    blockComment: [["/*", "*/"]],
    quotes: ['"', "'"],
  },
  {
    id: "markdown",
    aliases: ["markdown", "md", "mdx"],
    mode: "markdown",
    keywords: [],
    lineComment: [],
    blockComment: [],
    quotes: [],
  },
  {
    id: "diff",
    aliases: ["diff", "patch"],
    mode: "diff",
    keywords: [],
    lineComment: [],
    blockComment: [],
    quotes: [],
  },
  {
    id: "plaintext",
    aliases: ["plaintext", "text", "txt", "log", "output", ""],
    mode: "code",
    keywords: [],
    lineComment: [],
    blockComment: [],
    quotes: [],
  },
];

const BY_ALIAS = new Map<string, LanguageSpec>();
for (const language of LANGUAGES) {
  BY_ALIAS.set(language.id, language);
  for (const alias of language.aliases) BY_ALIAS.set(alias, language);
}

/** Resolves a `language` attribute (`"ts"`, `"js"`, `"C++"`, …) to a spec. */
export function resolveLanguage(name: string | null | undefined): LanguageSpec | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return BY_ALIAS.get(key) ?? null;
}
