// Writes the texture-format demo fixtures into examples/assets/texture-formats/ with the decoders' own test encoders
// (tests/support/texture-encoders.js): one 64x64 checkerboard per file, each in its own colours so a viewer can tell
// them apart, then reads every file back with the built readers. Run `npm run build` in packages/decoders first.
//   node packages/decoders/scripts/texture-fixtures.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bc1Solid, bgra, dds, fileOrder, ktx, tga, tiff } from '../tests/support/texture-encoders.js';
import { parseDDS } from '../dist/dds.js';
import { parseKTX } from '../dist/ktx.js';
import { parseTGA } from '../dist/tga.js';
import { parseTIFF } from '../dist/tiff.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  folder = resolve(repository, 'examples/assets/texture-formats'),
  SIZE = 64,
  SQUARE = 8;
// Never write outside the fixture folder.
assert.ok(!relative(resolve(repository, 'examples/assets'), folder).startsWith('..'));

/** An RGBA8 checkerboard of `size` x `size` texels in squares of `square`, colours `a` and `b`. */
function checker(size, square, a, b) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      out.set([...((Math.floor(x / square) + Math.floor(y / square)) % 2 ? b : a), 255], (y * size + x) * 4);
  return out;
}
const RED = [220, 30, 30],
  WHITE = [255, 255, 255],
  GREEN = [30, 170, 60],
  BLACK = [0, 0, 0],
  BLUE = [40, 80, 220],
  YELLOW = [250, 210, 40],
  MAGENTA = [255, 0, 255],
  CYAN = [0, 255, 255],
  ORANGE = [255, 140, 0],
  PURPLE = [120, 40, 200];

const files = {};
// TGA: red and white, run-length encoded true colour (type 10), 24-bit, bottom-left origin (rows stored bottom up).
const tgaImage = checker(SIZE, SQUARE, RED, WHITE);
files['checker.tga'] = [
  tga({
    type: 10,
    width: SIZE,
    height: SIZE,
    bits: 24,
    pixels: fileOrder(tgaImage, SIZE, SIZE, false, false).map(bgra),
  }),
  (bytes) => assert.deepEqual(parseTGA(bytes).data, tgaImage),
];
// TIFF: green and black RGB, LZW with Predictor 2, eight-row strips.
const tiffImage = checker(SIZE, SQUARE, GREEN, BLACK),
  rgb = [...tiffImage].filter((_, i) => i % 4 !== 3);
files['checker-lzw.tif'] = [
  tiff({
    width: SIZE,
    height: SIZE,
    spp: 3,
    bits: 8,
    photometric: 2,
    compression: 5,
    predictor: 2,
    rowsPerStrip: 8,
    samples: rgb,
  }),
  (bytes) => assert.deepEqual(parseTIFF(bytes).data, tiffImage),
];
// KTX: blue and yellow RGBA8 with its full mip chain (squares shrink with each level, down to 1x1).
const levels = Array.from({ length: 7 }, (_, level) =>
  checker(SIZE >> level, Math.max(1, SQUARE >> level), BLUE, YELLOW),
);
files['checker.ktx'] = [
  ktx({ internal: 0x8058, width: SIZE, height: SIZE, rowBytes: (w) => w * 4, images: levels.map((l) => [l]) }),
  (bytes) =>
    assert.deepEqual(
      parseKTX(bytes).mipmaps.map((m) => m.data),
      levels,
    ),
];
// DDS: magenta and cyan BC1 (both colours exact in RGB565), one solid block per 4x4 texels.
const blocks = [];
for (let by = 0; by < SIZE / 4; by++)
  for (let bx = 0; bx < SIZE / 4; bx++)
    blocks.push(...bc1Solid(...((Math.floor((bx * 4) / SQUARE) + Math.floor((by * 4) / SQUARE)) % 2 ? CYAN : MAGENTA)));
files['checker-bc1.dds'] = [
  dds({ width: SIZE, height: SIZE, fourCC: 'DXT1', data: blocks }),
  (bytes) => assert.deepEqual(parseDDS(bytes).mipmaps[0].data, Uint8Array.from(blocks)),
];
// DDS: orange and purple uncompressed RGBA8 (A8B8G8R8 masks).
const rgbaImage = checker(SIZE, SQUARE, ORANGE, PURPLE);
files['checker-rgba.dds'] = [
  dds({ width: SIZE, height: SIZE, bits: 32, masks: [0xff, 0xff00, 0xff0000, 0xff000000], data: rgbaImage }),
  (bytes) => assert.deepEqual(parseDDS(bytes).mipmaps[0].data, rgbaImage),
];

await mkdir(folder, { recursive: true });
for (const [name, [bytes, check]] of Object.entries(files)) {
  check(bytes);
  await writeFile(resolve(folder, name), bytes);
  console.log(`${name} ${bytes.length} bytes`);
}
