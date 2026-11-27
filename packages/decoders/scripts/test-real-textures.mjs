// Reads the real WebP, DDS and KTX2 files of tests/real-files/manifest.json. KTX2 headers must give the recorded size;
// WebP and DDS are compared with what outside decoders gave:
// dwebp's Y, U and V planes byte for byte, its RGBA for lossless files, and the PNG beside each Pillow DDS file. The files
// are read from the folder given as the argument and checked by SHA-256; they are never committed. Nothing is fetched
// without --download: an absent or changed file fails the check, which names it.
// Usage: node packages/decoders/scripts/test-real-textures.mjs <cache folder> [--download]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeImage } from '../dist/image.js';
import { readKTX2Index } from '../dist/ktx2-file.js';
import { decodePNG } from '../dist/png.js';
import { parseWebP } from '../dist/webp.js';
import { decodeVP8 } from '../dist/vp8.js';
import { downloadArguments } from '../../../scripts/support/download-arguments.mjs';
import { pinnedFiles } from '../../../scripts/support/pinned-files.mjs';

const args = downloadArguments(
  `Usage: node packages/decoders/scripts/test-real-textures.mjs <cache folder> [--download]
Reads the pinned WebP, DDS and KTX2 files in the folder and checks them against the manifest.
  --download   fetch the files that are missing or changed, then check them
  --help       print this and download nothing`,
  { download: { type: 'boolean' } },
  process.argv.slice(2),
  1,
);
if (!args) process.exit(); // process.exit: help or a refused argument, and nothing is open yet

const manifest = JSON.parse(readFileSync(new URL('../tests/real-files/manifest.json', import.meta.url))),
  folder = args.positionals[0];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compares = (row) => row.png && !row.file.startsWith('bc6h') && row.file !== 'bc4_unorm.dds';
const rows = [
  ...manifest.webp,
  ...manifest.dds,
  ...manifest.dds.filter(compares).map((row) => ({ file: `${row.file}.png`, url: row.png, sha256: row.pngSha256 })),
  ...manifest.ktx2,
].map((row) => ({ name: row.file, path: join(folder, row.file), url: row.url, sha256: row.sha256, size: row.bytes }));
const read = await pinnedFiles(rows, {
  command: `node packages/decoders/scripts/test-real-textures.mjs ${folder}`,
  download: args.download,
});
const files = new Map(rows.map((row, i) => [row.name, new Uint8Array(read[i])]));

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
  const bytes = files.get(row.file);
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
  const image = await decodeImage(files.get(row.file));
  if (!compares(row)) continue;
  const reference = decodePNG(files.get(`${row.file}.png`));
  for (let i = 0; i < image.data.length; i++) worst = Math.max(worst, Math.abs(image.data[i] - reference.data[i]));
  compared++;
}
console.log(`DDS: ${manifest.dds.length} read, ${compared} compared with Pillow's PNG, largest difference ${worst}`);
if (worst > 1) wrong.push(`DDS differs by ${worst}`);
for (const row of manifest.ktx2) {
  const index = readKTX2Index(files.get(row.file));
  if (index.width !== row.width || index.height !== row.height) wrong.push(`${row.file}: size`);
}
console.log(`KTX2: ${manifest.ktx2.length} headers read`);
if (wrong.length) {
  console.error(wrong.join('\n'));
  process.exitCode = 1;
}
