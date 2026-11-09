// Draws the install icons (icons/icon-180.png, -192, -512) with no dependencies: a pixel-art Heart
// Container on the dark theme green, with a gold frame, the same 9x8 heart the page header uses.
// The colours are theme.css's dark tokens (--bg, --heart, --accent). Re-run only to change the art:
//   node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HEART = [".XX...XX.", "XXXXXXXXX", "XXXXXXXXX", "XXXXXXXXX", ".XXXXXXX.", "..XXXXX..", "...XXX...", "....X...."];
const BG = [0x14, 0x26, 0x1a], SURFACE = [0x1c, 0x33, 0x23], GOLD = [0xe8, 0xc5, 0x47], RED = [0xe2, 0x57, 0x4c];
const SHINE = [0xf0, 0xa0, 0x98], SHADE = [0xa8, 0x3a, 0x32];

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) { const [r, g, b] = px(x, y); const o = y * (size * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Work on a 36-cell grid so every size is a whole number of pixels per cell where possible.
const GRID = 36, HX = 4, HY = 6, HS = 3; // heart occupies 27x24 cells starting at (4,6), 3 cells per heart pixel
function cell(cx, cy) {
  const edge = Math.min(cx, cy, GRID - 1 - cx, GRID - 1 - cy);
  if (edge === 1) return GOLD;
  if (edge < 1) return BG;
  const hx = Math.floor((cx - HX) / HS), hy = Math.floor((cy - HY) / HS);
  if (hx >= 0 && hx < 9 && hy >= 0 && hy < 8 && HEART[hy][hx] === "X") {
    if ((hy === 1 && (hx === 1 || hx === 2)) || (hy === 2 && hx === 1)) return SHINE;
    if (hy >= 6 || (hy === 5 && (hx === 2 || hx === 6))) return SHADE;
    return RED;
  }
  return SURFACE;
}
mkdirSync(fileURLToPath(new URL("../icons/", import.meta.url)), { recursive: true });
for (const size of [180, 192, 512]) {
  const buf = png(size, (x, y) => cell(Math.floor((x * GRID) / size), Math.floor((y * GRID) / size)));
  writeFileSync(fileURLToPath(new URL(`../icons/icon-${size}.png`, import.meta.url)), buf);
  console.log(`icons/icon-${size}.png ${buf.length} bytes`);
}
