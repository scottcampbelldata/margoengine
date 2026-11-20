// The image writers refuse pixels a file cannot hold: zero or fractional sizes (PNG, JPEG and WebP all need at least
// one pixel a side: W3C PNG 11.2.2 IHDR, ITU T.81 B.2.2 with no DNL, WebP lossless 3.2 stores size minus one) and data
// whose length is not width x height x 4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePNG } from '../dist/index.js';
import { encodeJPEG, encodeWebP } from '../dist/formats.js';

const bad = [
  { width: 0, height: 0, data: new Uint8Array(0) },
  { width: 0, height: 3, data: new Uint8Array(0) },
  { width: 1.5, height: 2, data: new Uint8Array(12) },
  { width: 2, height: 2, data: new Uint8Array(4) },
  { width: 2, height: 2, data: undefined },
];

test('encodePNG refuses pixels a PNG cannot hold, before writing anything', async () => {
  for (const pixels of bad)
    await assert.rejects(encodePNG(pixels), { name: 'RangeError' }, `${pixels.width} x ${pixels.height}`);
  assert.equal((await encodePNG({ width: 1, height: 1, data: Uint8Array.of(1, 2, 3, 4) }))[1], 0x50);
});

test('encodeJPEG and encodeWebP refuse a zero or fractional size', async () => {
  for (const pixels of bad) {
    assert.throws(() => encodeJPEG(pixels), { name: 'RangeError' }, `${pixels.width} x ${pixels.height}`);
    await assert.rejects(encodeWebP(pixels), { name: 'RangeError' }, `${pixels.width} x ${pixels.height}`);
  }
});
