#!/usr/bin/env node
/**
 * Fails when a string rendered through `t()` has no translation row, when a
 * row is missing a language, or when a row's placeholders differ from the key.
 *
 *   node scripts/check-i18n.mjs
 *
 * The catalogue is keyed by English source text, so "missing" means a string a
 * non-English user would still see in English.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// `new URL(...).pathname` yields `/D:/a/...` on Windows, which `join` then turns
// into `D:\D:\a\...`; `fileURLToPath` decodes the drive letter correctly.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const MESSAGES = join(SRC, "i18n/messages.ts");

/** Windows file paths use `\`, so compare them with `/` instead. */
const toPosix = (path) => path.split(sep).join("/");

/** Data arrays whose values are rendered through `t()` at use time. */
const DATA_FILES = [
  "src/lib/commands.ts",
  "src/components/editor/slash-items.ts",
  "src/components/settings/SettingsDialog.tsx",
  "src/components/settings/EditorSection.tsx",
  "src/components/settings/AppearanceSection.tsx",
  "src/components/settings/StorageSection.tsx",
  "src/components/settings/NotionSection.tsx",
  "src/components/sidebar/BuiltinSections.tsx",
  "src/components/editor/SaveIndicator.tsx",
  "src/components/editor/EditorBubbleMenu.tsx",
  "src/components/editor/VersionHistoryDialog.tsx",
  "src/components/editor/extensions/callout.ts",
  "src/components/editor/extensions/doc-link.ts",
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    const info = statSync(file);
    if (info.isDirectory()) {
      if (entry !== "node_modules") walk(file, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(file);
    }
  }
  return out;
}

function unquote(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

const used = new Set();
for (const file of walk(SRC)) {
  if (toPosix(file).endsWith("i18n/messages.ts")) continue;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\b(?:t|translate)\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    used.add(unquote(match[1]));
  }
  for (const match of source.matchAll(/\b(?:t|translate)\(\s*`([^`]*)`/g)) {
    used.add(`TEMPLATE:${match[1]}`);
  }
}

for (const relative of DATA_FILES) {
  let source;
  try {
    source = readFileSync(join(ROOT, relative), "utf8");
  } catch {
    continue;
  }
  for (const match of source.matchAll(
    /(?:label|title|detail|hint|empty|description)\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  )) {
    const value = unquote(match[1]);
    if (/^[A-Z]/.test(value) && /[a-z]/.test(value)) used.add(value);
  }
}

const dictionary = readFileSync(MESSAGES, "utf8");
const rows = new Map();
for (const match of dictionary.matchAll(
  /^  "((?:[^"\\]|\\.)*)": \[([^\]]*)\],?$/gm,
)) {
  const key = unquote(match[1]);
  rows.set(key, match[2]);
}

const problems = [];

const placeholders = (text) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

for (const key of [...used].sort()) {
  if (key.startsWith("TEMPLATE:")) continue;
  const row = rows.get(key);
  if (row === undefined) {
    problems.push(`missing translation: ${JSON.stringify(key)}`);
    continue;
  }
  const values = [...row.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    unquote(m[1]),
  );
  if (values.length !== 4 || values.some((v) => v.trim() === "")) {
    problems.push(`expected 4 non-empty languages: ${JSON.stringify(key)}`);
    continue;
  }
  const expected = placeholders(key);
  for (const value of values) {
    if (placeholders(value) !== expected) {
      problems.push(
        `placeholder mismatch in ${JSON.stringify(key)} → ${JSON.stringify(value)}`,
      );
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log(`i18n ok: ${used.size} strings, ${rows.size} rows.`);