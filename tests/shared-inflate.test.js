// The shared zlib inflater (packages/shared/inflate.js, used by environment EXR and decoders PNG): output identical to
// node:zlib across levels, strategies and window sizes, and the RFC 1950 Adler-32 trailer enforced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, deflateSync } from 'node:zlib';
import { inflateZlib } from '../packages/shared/inflate.js';

let seed = 3;
const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 8;
const failed = { name: 'MargoError', code: 'failed' };

test('inflates what node:zlib deflates at every level, strategy and window size', () => {
  const strategies = [
    constants.Z_DEFAULT_STRATEGY,
    constants.Z_FILTERED,
    constants.Z_HUFFMAN_ONLY,
    constants.Z_RLE,
    constants.Z_FIXED,
  ];
  for (let i = 0; i < 300; i++) {
    const length = random() % (i < 250 ? 4000 : 70000),
      data = new Uint8Array(length);
    for (let k = 0; k < length; k++)
      data[k] =
        i % 3 === 0 ? random() & 255 : i % 3 === 1 ? (k >> 5) & 255 : (random() % 3 ? data[k - 1] : random()) & 255;
    const zlib = deflateSync(data, { level: i % 10, strategy: strategies[i % 5], windowBits: 8 + (i % 8) });
    assert.deepEqual(inflateZlib(zlib, length), data, `stream ${i}`);
  }
});

test('the Adler-32 trailer must be present and match the output', () => {
  const data = new TextEncoder().encode('Adler-32 covers the decompressed bytes. '.repeat(40)),
    zlib = new Uint8Array(deflateSync(data));
  assert.deepEqual(inflateZlib(zlib, data.length), data);
  for (let byte = 1; byte <= 4; byte++) {
    const flipped = zlib.slice();
    flipped[flipped.length - byte] ^= 0x10;
    assert.throws(() => inflateZlib(flipped, data.length), failed, `trailer byte ${byte} flipped`);
  }
  for (let cut = 1; cut <= 4; cut++)
    assert.throws(
      () => inflateZlib(zlib.subarray(0, zlib.length - cut), data.length),
      failed,
      `${cut} trailer bytes cut`,
    );
  assert.deepEqual(inflateZlib(new Uint8Array(deflateSync(new Uint8Array())), 0), new Uint8Array());
});

test('checkAdler false skips only the checksum, still requiring the trailer', () => {
  const data = new TextEncoder().encode('PNG chunk CRCs already cover these bytes. '.repeat(30)),
    zlib = new Uint8Array(deflateSync(data)),
    flipped = zlib.slice();
  flipped[flipped.length - 1] ^= 1;
  assert.deepEqual(inflateZlib(flipped, data.length, false), data);
  assert.throws(() => inflateZlib(flipped, data.length), failed);
  assert.throws(() => inflateZlib(zlib.subarray(0, zlib.length - 1), data.length, false), failed);
});
