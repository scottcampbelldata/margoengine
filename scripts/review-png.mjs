// Makes a PNG small enough to be looked at as it is.
//
// An image-reading tool that sends a picture to a model holds it to a 5 MiB base64 limit, 3,932,160 file bytes, and
// quietly re-encodes a bigger file with a reduced palette. Measured on 2026-10-31: the same pixels at 3,932,160 bytes
// come through true, at 3,932,161 bytes the sky shows wide bands and the whole frame shifts colour, which read as an
// engine bug for a day (docs/known-bugs.md). A 1920x1080 frame from canvas.convertToBlob sits right at that size, so
// a shot may cross it with no change that matters. Judge a shot by reading this script's output, or by its numbers.
//
// The output has the same pixels, proven by decoding it again. A frame that still does not fit stops with an error
// rather than passing on a picture nobody can see truly.
//   node scripts/review-png.mjs <in.png> [out.png] [--limit=bytes]   (default out: <in>.review.png)
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { margoError } from '../packages/shared/errors.js';
import { decodePNG } from '../tests/support/png.js';
import { exitOnHelp } from './support/help.mjs';

/** The largest file an image-reading tool passes on unchanged: 5 MiB of base64 is 3,932,160 bytes. */
export const REVIEW_LIMIT = 5 * 1024 * 1024 * 0.75;

const crcTable = Int32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]),
    head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  let crc = -1;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE((crc ^ -1) >>> 0);
  return Buffer.concat([head, body, tail]);
}

/** Lossless PNG of RGBA pixels: no alpha channel when all are opaque, the smallest filter per row, deflate level 9. */
function encode({ width, height, data }) {
  let opaque = true;
  for (let i = 3; i < data.length && opaque; i += 4) opaque = data[i] === 255;
  const bpp = opaque ? 3 : 4,
    stride = width * bpp,
    raw = Buffer.alloc((stride + 1) * height),
    candidate = new Uint8Array(stride);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < width; x++) for (let c = 0; c < bpp; c++) row[x * bpp + c] = data[(y * width + x) * 4 + c];
    let best = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0,
          b = previous[i],
          c = i >= bpp ? previous[i - bpp] : 0,
          p = a + b - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c),
          predicted = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
        candidate[i] = row[i] - predicted;
        sum += candidate[i] < 128 ? candidate[i] : 256 - candidate[i];
      }
      if (sum < best) {
        best = sum;
        raw[y * (stride + 1)] = filter;
        raw.set(candidate, y * (stride + 1) + 1);
      }
    }
    previous = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The same pixels in a file of at most `limit` bytes. A file that already fits comes back as it is.
 * @throws {Error} code `REVIEW_PNG_TOO_LARGE` when the smallest lossless file is still over the limit.
 */
export async function shrinkForReview(bytes, { limit = REVIEW_LIMIT } = {}) {
  if (bytes.length <= limit) return bytes;
  const image = await decodePNG(bytes),
    small = encode(image);
  if (small.length > limit)
    throw margoError(
      'REVIEW_PNG_TOO_LARGE',
      `This frame is ${small.length} bytes as a lossless PNG, over the ${limit} a viewing tool passes on unchanged; shoot a smaller canvas so the picture you judge is the true one`,
    );
  const back = await decodePNG(small);
  if (Buffer.compare(Buffer.from(back.data), Buffer.from(image.data)) !== 0)
    throw new RangeError('review-png wrote different pixels; report this with the input file');
  return small;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  exitOnHelp('node scripts/review-png.mjs <in.png> [out.png] [--limit=bytes]');
  const args = process.argv.slice(2),
    limit = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? REVIEW_LIMIT),
    [input, output = `${input}.review.png`] = args.filter((a) => !a.startsWith('--'));
  if (!input) throw new TypeError('Name a PNG: node scripts/review-png.mjs <in.png> [out.png] [--limit=bytes]');
  const bytes = readFileSync(input),
    result = await shrinkForReview(bytes, { limit });
  writeFileSync(output, result);
  console.log(`${output}: ${bytes.length} -> ${result.length} bytes, same pixels, limit ${limit}`);
}
