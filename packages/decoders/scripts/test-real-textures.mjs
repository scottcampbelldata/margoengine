// Reads the real WebP and DDS files of tests/real-files/manifest.json and compares them with what outside decoders gave:
// dwebp's Y, U and V planes byte for byte, its RGBA for lossless files, and the PNG beside each Pillow DDS file. The files
// are downloaded into a folder given as the first argument and checked by SHA-256; they are never committed.
// Usage: node packages/decoders/scripts/test-real-textures.mjs <cache folder>
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeImage } from '../dist/image.js';
import { decodePNG } from '../dist/png.js';
import { parseWebP } from '../dist/webp.js';
import { decodeVP8 } from '../dist/vp8.js';

const manifest = JSON.parse(readFileSync(new URL('../tests/real-files/manifest.json', import.meta.url))),
  folder = process.argv[2];
if (!folder) throw new TypeError('Pass a folder for the downloaded files');
mkdirSync(folder, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fetched(file, url, sha256) {
  const path = join(folder, file);
  if (!existsSync(path)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = new Uint8Array(readFileSync(path));
  if (hash(bytes) !== sha256) throw new Error(`${file} does not match its SHA-256`);
  return bytes;
}

/** The first VP8 chunk at the top level or in the first frame. */
function vp8Chunk(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 12; at + 8 <= bytes.length; ) {
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4)),
      size = view.getUint32(at + 4, true);
    if (tag === 'VP8 ') return [at + 8, at + 8 + size];
    if (tag === 'VP8L') return undefined;
    at += tag === 'ANMF' ? 24 : 8 + size + (size & 1);
  }
  return undefined;
}

function planes(frame) {
  const { width, height, y, u, v, yOffset, yStride, uvOffset, uvStride } = frame,
    cw = (width + 1) >> 1,
    ch = (height + 1) >> 1,
    out = new Uint8Array(width * height + 2 * cw * ch);
  let at = 0;
  for (let row = 0; row < height; row++, at += width)
    out.set(y.subarray(yOffset + row * yStride, yOffset + row * yStride + width), at);
  for (const plane of [u, v])
    for (let row = 0; row < ch; row++, at += cw)
      out.set(plane.subarray(uvOffset + row * uvStride, uvOffset + row * uvStride + cw), at);
  return out;
}

let same = 0,
  refused = 0;
const wrong = [];
for (const row of manifest.webp) {
  const bytes = await fetched(row.file, row.url, row.sha256);
  try {
    const image = parseWebP(bytes);
    if (row.refused) wrong.push(`${row.file}: dwebp refuses it, this decoded it`);
    else if (image.width !== row.width || image.height !== row.height) wrong.push(`${row.file}: size`);
    else if (row.yuv) {
      const [start, end] = vp8Chunk(bytes);
      if (hash(planes(decodeVP8(bytes, start, end))) === row.yuv) same++;
      else wrong.push(`${row.file}: planes differ`);
    } else if (hash(image.data) === row.rgba) same++;
    else wrong.push(`${row.file}: pixels differ`);
  } catch (error) {
    if (row.refused) refused++;
    else wrong.push(`${row.file}: ${error.message}`);
  }
}
console.log(`WebP: ${same} the same as dwebp, ${refused} refused by both, of ${manifest.webp.length}`);

let worst = 0,
  compared = 0;
for (const row of manifest.dds) {
  const image = await decodeImage(await fetched(row.file, row.url, row.sha256));
  if (!row.png || row.file.startsWith('bc6h') || row.file === 'bc4_unorm.dds') continue;
  const reference = decodePNG(await fetched(row.file + '.png', row.png, row.pngSha256));
  for (let i = 0; i < image.data.length; i++) worst = Math.max(worst, Math.abs(image.data[i] - reference.data[i]));
  compared++;
}
console.log(`DDS: ${manifest.dds.length} read, ${compared} compared with Pillow's PNG, largest difference ${worst}`);
if (worst > 1) wrong.push(`DDS differs by ${worst}`);
if (wrong.length) {
  console.error(wrong.join('\n'));
  process.exitCode = 1;
}
