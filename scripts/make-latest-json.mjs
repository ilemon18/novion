#!/usr/bin/env node
/**
 * Writes `latest.json` for the release being published.
 *
 *   node scripts/make-latest-json.mjs --dist dist --version 0.0.2
 *
 * `latest.json` is uploaded as a **release asset** next to the bundles and is
 * what the app actually reads:
 *
 *   https://github.com/<owner>/<repo>/releases/latest/download/latest.json
 *
 * Serving it from the release CDN means update checks cost no GitHub API quota
 * (the unauthenticated REST limit is 60 requests per hour per IP).
 *
 * The bundle lookup is deliberately strict-but-tolerant: it selects the
 * `novion-<platform>-<version>.<ext>` files and *ignores everything else* in
 * `dist/` — the previous `latest.json`, checksum files, extra artifacts from
 * other workflows, debug dumps. A release that contains unrelated files must
 * not break the manifest, and a missing platform bundle is simply omitted
 * (macOS and Windows are built by independent jobs).
 *
 * Each entry carries the file size and SHA-256, so the app can reject a
 * truncated or tampered download before installing it.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TARGETS = {
  macos: { prefix: "novion-macos-", extension: ".dmg" },
  windows: { prefix: "novion-win-", extension: ".exe" },
};

function fail(message) {
  console.error(`\n[make-latest-json] ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { dist: "dist", version: "", repo: "", notes: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--dist") out.dist = value ?? "";
    else if (flag === "--version") out.version = value ?? "";
    else if (flag === "--repo") out.repo = value ?? "";
    else if (flag === "--notes") out.notes = value ?? "";
    else if (flag.startsWith("--")) fail(`unknown option ${flag}`);
    if (flag.startsWith("--")) i += 1;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const version = args.version.trim().replace(/^v/i, "");
if (!version) fail("--version is required (e.g. --version 0.0.2)");

const repo = (args.repo || process.env.GITHUB_REPOSITORY || "ilemon18/novion").trim();
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`"${repo}" is not an owner/repo pair`);

const dist = resolve(args.dist);
let entries;
try {
  entries = readdirSync(dist);
} catch (err) {
  fail(`cannot read ${dist}: ${err.message}`);
}

/** Exactly one bundle for this platform, or `null` when the job did not run. */
function pick(target) {
  const matches = entries.filter(
    (name) =>
      name.startsWith(target.prefix) &&
      name.endsWith(target.extension) &&
      // guard against `novion-macos-0.0.2.dmg.sha256` and similar side files
      name.slice(target.prefix.length).replace(target.extension, "").match(/^[0-9A-Za-z.\-+]+$/) !==
        null,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) fail(`expected one ${target.prefix}*${target.extension}, found ${matches.length}: ${matches.join(", ")}`);
  const name = matches[0];
  const path = join(dist, name);
  const bytes = readFileSync(path);
  return {
    name,
    url: `https://github.com/${repo}/releases/download/v${version}/${name}`,
    size: statSync(path).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const assets = {};
for (const [key, target] of Object.entries(TARGETS)) {
  const asset = pick(target);
  if (asset) assets[key] = asset;
  else console.warn(`[make-latest-json] no ${key} bundle in ${dist}; omitting it`);
}
if (Object.keys(assets).length === 0) fail(`no bundle found in ${dist}`);

const manifest = {
  version,
  tag: `v${version}`,
  pageUrl: `https://github.com/${repo}/releases/tag/v${version}`,
  publishedAt: new Date().toISOString(),
  ...(args.notes ? { notes: args.notes } : {}),
  assets,
};

const outFile = join(dist, "latest.json");
writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[make-latest-json] wrote ${outFile}`);
for (const [key, asset] of Object.entries(assets)) {
  console.log(`  ${key.padEnd(7)} ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB, sha256 ${asset.sha256.slice(0, 12)}…)`);
}