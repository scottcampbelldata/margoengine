// A shot over the viewing tool's size limit is re-encoded with a reduced palette on its way to the reader: bands in the
// sky and a colour shift, reported as an engine bug above "1.4 million objects" when only the file size had crossed it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { REVIEW_LIMIT, shrinkForReview } from '../scripts/review-png.mjs';
import { decodePNG } from './support/png.js';

const crcTable = Int32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]),
    out = Buffer.alloc(body.length + 8);
  let crc = -1;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ -1) >>> 0, body.length + 4);
  return out;
}
/** RGBA PNG as a browser might write it: no filter, weak deflate, `padding` bytes in a text chunk. */
function png(width, height, pixel, { padding = 0 } = {}) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y),
        at = y * (width * 4 + 1) + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    ...(padding ? [chunk('tEXt', Buffer.alloc(padding, 65))] : []),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const sky = (x, y) => [(x * 3 + y) & 255, (y * 2) & 255, 200, 255];

test('the limit is 5 MiB of base64', () => {
  assert.equal(REVIEW_LIMIT, 3932160);
  assert.equal((Math.ceil(REVIEW_LIMIT / 3) * 4) / (1024 * 1024), 5);
});

test('a file one byte over the limit comes back under it with the same pixels', async () => {
  const small = png(64, 64, sky),
    over = png(64, 64, sky, { padding: REVIEW_LIMIT + 1 - small.length - 12 });
  assert.equal(over.length, REVIEW_LIMIT + 1);
  const out = await shrinkForReview(over);
  assert.ok(out.length <= REVIEW_LIMIT, `${out.length} bytes`);
  assert.deepEqual((await decodePNG(out)).data, (await decodePNG(over)).data);
});

test('at a smaller limit a weakly compressed file shrinks losslessly under it', async () => {
  const input = png(256, 256, sky),
    limit = input.length - 1,
    out = await shrinkForReview(input, { limit });
  assert.ok(out.length <= limit && out.length < input.length * 0.8, `${input.length} -> ${out.length}`);
  assert.deepEqual((await decodePNG(out)).data, (await decodePNG(input)).data);
});

test('transparency survives', async () => {
  const input = png(32, 32, (x, y) => [x * 8, y * 8, 0, (x * y) & 255], { padding: 1000 }),
    out = await shrinkForReview(input, { limit: input.length - 1 });
  assert.deepEqual((await decodePNG(out)).data, (await decodePNG(input)).data);
});

test('a file at the limit is handed back untouched', async () => {
  const input = png(16, 16, sky);
  assert.equal(await shrinkForReview(input, { limit: input.length }), input);
});

test('a frame that cannot fit stops with a coded error that names the fix', async () => {
  let seed = 1;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  };
  const input = png(64, 64, () => [noise(), noise(), noise(), 255]);
  await assert.rejects(shrinkForReview(input, { limit: 1000 }), (error) => {
    assert.equal(error.code, 'REVIEW_PNG_TOO_LARGE');
    assert.match(error.message, /shoot a smaller canvas/);
    return true;
  });
});
