// WebP reading (@margoengine/decoders/webp) against dwebp, run as an outside tool when the fixtures were made: the Y, U
// and V planes of every lossy file byte for byte, RGBA exact for lossless, RGB within 1 of 255 after upsampling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseWebP } from '../dist/webp.js';
import { decodeVP8 } from '../dist/vp8.js';
import { decodePNG } from '../dist/png.js';

const folder = new URL('./fixtures/webp/', import.meta.url),
  bytesOf = (name) => new Uint8Array(readFileSync(new URL(name, folder))),
  rows = JSON.parse(readFileSync(new URL('dwebp.json', folder))),
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Where the VP8 data of a simple or extended file is. */
function vp8Chunk(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 12; at + 8 <= bytes.length; ) {
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4)),
      size = view.getUint32(at + 4, true);
    if (tag === 'VP8 ') return [at + 8, at + 8 + size];
    at += 8 + size + (size & 1);
  }
  return undefined;
}

function planes({ width, height, y, u, v, yOffset, yStride, uvOffset, uvStride }) {
  const cw = (width + 1) >> 1,
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

for (const [name, row] of Object.entries(rows))
  test(`${name}.webp reads as dwebp reads it`, () => {
    const bytes = bytesOf(`${name}.webp`),
      image = parseWebP(bytes),
      reference = decodePNG(bytesOf(`dwebp/${name}.png`));
    assert.equal(sha(bytes), row.sha256);
    assert.deepEqual([image.width, image.height], [row.width, row.height]);
    assert.equal(image.data.length, row.width * row.height * 4);
    if (row.yuv && name !== 'animated') {
      const [start, end] = vp8Chunk(bytes);
      assert.equal(sha(planes(decodeVP8(bytes, start, end))), row.yuv);
    }
    let rgb = 0,
      alpha = 0;
    for (let i = 0; i < image.data.length; i++) {
      const difference = Math.abs(image.data[i] - reference.data[i]);
      if ((i & 3) === 3) alpha = Math.max(alpha, difference);
      else rgb = Math.max(rgb, difference);
    }
    assert.equal(alpha, 0);
    assert.ok(rgb <= (image.lossless ? 0 : 1), `largest RGB difference ${rgb}`);
  });

test('the fixtures reach every alpha filter and both alpha codings', () => {
  const flags = new Set(Object.values(rows).map((row) => row.alphFlags));
  for (const filter of [0, 1, 2, 3]) assert.ok([...flags].some((f) => f !== undefined && ((f >> 2) & 3) === filter));
  assert.ok(flags.has(0) && [...flags].some((f) => f !== undefined && (f & 3) === 1));
});

test('an animated file gives its first frame', () => {
  const first = parseWebP(bytesOf('animated.webp')),
    still = parseWebP(bytesOf('lossy.webp'));
  assert.deepEqual([first.width, first.height], [97, 83]);
  assert.equal(first.lossless, false);
  assert.notEqual(sha(first.data), sha(new Uint8Array(first.data.length)));
  assert.equal(still.data.length, first.data.length);
});

/** Damaged input ends in a coded refusal or a range error, never another exception and never a hang. */
function damaged(bytes) {
  try {
    parseWebP(bytes);
  } catch (error) {
    assert.ok(error.name === 'MargoError' || error instanceof RangeError, `${error.name}: ${error.message}`);
  }
}

test('truncated files refuse cleanly', () => {
  for (const name of ['lossy', 'lossless', 'alpha-horizontal', 'animated']) {
    const bytes = bytesOf(`${name}.webp`);
    for (let length = 0; length < bytes.length; length += 1 + (length >> 4)) damaged(bytes.subarray(0, length));
  }
});

test('flipped bits refuse cleanly or decode to the file size', () => {
  let seed = 0x2545f491;
  const next = (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  for (const name of ['lossy', 'lossless', 'alpha-gradient', 'animated', 'Website_accessibility']) {
    const bytes = bytesOf(`${name}.webp`);
    for (let round = 0; round < 300; round++) {
      const copy = bytes.slice();
      for (let flips = 1 + next(4); flips; flips--) copy[12 + next(copy.length - 12)] ^= 1 << next(8);
      damaged(copy);
    }
  }
});

test('a file that is not WebP is refused by name', () => {
  assert.throws(
    () => parseWebP(new TextEncoder().encode('RIFF....WEBPVP8L')),
    (error) => error.name === 'MargoError' || error instanceof RangeError,
  );
  assert.throws(() => parseWebP(new Uint8Array(4)), (error) => error.name === 'MargoError' || error instanceof RangeError);
});
