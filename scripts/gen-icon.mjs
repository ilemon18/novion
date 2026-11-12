// Generates src-tauri/icons/icon.png (1024×1024).
//
// Design: white "paper" tile (rounded square, warm edge) with a low-saturation
// blue "N" mark built from three round-capped capsules, so it stays legible at
// 16px. Regenerate the platform sizes afterwards with:
//   node scripts/gen-icon.mjs && npx tauri icon src-tauri/icons/icon.png
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const S = 1024;
const px = new Uint8Array(S * S * 4);

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function writePng(path) {
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

// ------------------------------------------------------------------ geometry

const R = 224; // tile corner radius (macOS-ish squircle approximation)

/** Signed distance (px) to a rounded square centred on the canvas. */
function tileDistance(x, y, inset = 0) {
  const half = S / 2 - inset;
  const r = Math.max(1, R - inset);
  const dx = Math.abs(x - S / 2) - (half - r);
  const dy = Math.abs(y - S / 2) - (half - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

/** Distance from a point to a segment (used for the capsule glyph strokes). */
function segmentDistance(px_, py_, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px_ - ax) * dx + (py_ - ay) * dy) / len2));
  return Math.hypot(px_ - (ax + t * dx), py_ - (ay + t * dy));
}

/** Coverage of a capsule (round-capped stroke) at a point. */
function capsuleCoverage(x, y, ax, ay, bx, by, radius) {
  const d = segmentDistance(x, y, ax, ay, bx, by) - radius;
  return Math.min(1, Math.max(0, 0.5 - d));
}

// The "N": two stems + a diagonal, all built from the same 92px-wide capsule.
const STROKE = 46; // capsule radius
const TOP = 330;
const BOTTOM = 694;
const LEFT = 344;
const RIGHT = 680;
const GLYPH = [
  [LEFT, TOP, LEFT, BOTTOM],
  [RIGHT, TOP, RIGHT, BOTTOM],
  [LEFT, TOP, RIGHT, BOTTOM],
];

function glyphCoverage(x, y) {
  let best = 0;
  for (const [ax, ay, bx, by] of GLYPH) {
    const c = capsuleCoverage(x, y, ax, ay, bx, by, STROKE);
    if (c > best) best = c;
  }
  return best;
}

// ------------------------------------------------------------------- palette

const light = [255, 255, 255];
const paperBottom = [244, 242, 237]; // very faint warm shade at the bottom
const edge = [226, 224, 219]; // #E2E0DB, the app border tone
const inkTop = [74, 111, 165]; // #4A6FA5
const inkBottom = [56, 84, 128]; // slightly deeper, so the mark has body

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [
  Math.round(lerp(a[0], b[0], t)),
  Math.round(lerp(a[1], b[1], t)),
  Math.round(lerp(a[2], b[2], t)),
];

// ---------------------------------------------------------------------- draw

for (let y = 0; y < S; y++) {
  const v = y / (S - 1);
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;

    const alpha = Math.min(1, Math.max(0, 0.5 - tileDistance(x + 0.5, y + 0.5)));
    if (alpha <= 0) continue;

    // paper: white on top, a whisper of warmth at the bottom
    let color = mix(light, paperBottom, Math.pow(v, 2.2) * 0.85);

    // hairline rim so the tile keeps an edge on white backgrounds; at 1024px a
    // 7px stroke survives downscaling to 32px (dOuter is negative inside the tile)
    const dOuter = tileDistance(x + 0.5, y + 0.5);
    const ring = Math.min(1, Math.max(0, 3.5 - Math.abs(dOuter + 6)));
    if (ring > 0) color = mix(color, edge, Math.min(1, ring) * 0.85);

    // mark
    const g = glyphCoverage(x + 0.5, y + 0.5);
    if (g > 0) color = mix(color, mix(inkTop, inkBottom, v), g);

    px[i] = color[0];
    px[i + 1] = color[1];
    px[i + 2] = color[2];
    px[i + 3] = Math.round(alpha * 255);
  }
}

mkdirSync("src-tauri/icons", { recursive: true });
writePng("src-tauri/icons/icon.png");
console.log("wrote src-tauri/icons/icon.png (1024×1024, white paper tile)");
