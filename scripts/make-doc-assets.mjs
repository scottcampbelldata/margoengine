// Writes the two small textures the guides use: examples/assets/docs/bricks.png (colour) and bricks-normal.png
// (tangent-space normal map, +Y up). Both are painted from arithmetic here, so they carry no third-party licence.
// The output is deterministic; docs-guides tests compare nothing to it, so rerun this only to change the pattern:
//   node scripts/make-doc-assets.mjs
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const size = 256,
  rows = 8,
  rowHeight = size / rows,
  brickWidth = 64,
  mortar = 4,
  out = resolve(import.meta.dirname, '../examples/assets/docs');

/** Same input, same number in [0, 1): a tiny integer hash, so every brick gets its own tint. */
const hash = (a, b) => {
  let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 2246822519, 3266489917);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const color = Buffer.alloc(size * size * 3),
  height = new Float32Array(size * size);
for (let y = 0; y < size; y++) {
  const row = Math.floor(y / rowHeight),
    shift = row % 2 ? brickWidth / 2 : 0;
  for (let x = 0; x < size; x++) {
    const column = Math.floor((x + shift) / brickWidth),
      u = (x + shift) % brickWidth,
      v = y % rowHeight,
      inMortar = u < mortar || v < mortar,
      tint = hash(column % (size / brickWidth), row),
      grain = hash(x, y) * 14,
      pixel = (y * size + x) * 3;
    height[y * size + x] = inMortar ? 0 : 1;
    const base = inMortar ? [168, 164, 156] : [150 + tint * 50, 70 + tint * 28, 52 + tint * 18];
    for (let c = 0; c < 3; c++) color[pixel + c] = Math.round(base[c] + grain - 7);
  }
}

// Normal map from the height field: central differences with wrap-around, so the texture tiles without a seam.
const normal = Buffer.alloc(size * size * 3),
  at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 1.2,
      dy = (at(x, y + 1) - at(x, y - 1)) * 1.2,
      // Image rows run downward and the normal map's +Y points up, so the y slope changes sign.
      n = [-dx, dy, 1],
      length = Math.hypot(...n),
      pixel = (y * size + x) * 3;
    for (let c = 0; c < 3; c++) normal[pixel + c] = Math.round((n[c] / length) * 127.5 + 127.5);
  }

mkdirSync(out, { recursive: true });
const png = { compressionLevel: 9, palette: false };
await sharp(color, { raw: { width: size, height: size, channels: 3 } })
  .png(png)
  .toFile(join(out, 'bricks.png'));
await sharp(normal, { raw: { width: size, height: size, channels: 3 } })
  .png(png)
  .toFile(join(out, 'bricks-normal.png'));
console.log(`wrote ${join(out, 'bricks.png')} and bricks-normal.png`);
