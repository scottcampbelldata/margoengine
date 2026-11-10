import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openTIFF } from '../dist/tiff.js';
const root = new URL('./fixtures/tiff-scientific/', import.meta.url),
  read = (name) => readFileSync(new URL(name, root));
const expected = JSON.parse(read('expected.json'));
test('independent tifffile output: classic/BigTIFF, endian, signed/unsigned/float, LZW/deflate, tiles/strips and predictors', {
  timeout: 30000,
}, () => {
  for (const [name, e] of Object.entries(expected)) {
    const file = openTIFF(read(name));
    assert.equal(file.length, 2, name);
    assert.equal(file.bigTIFF, name.startsWith('big-'), name);
    let sum = 0,
      index = 0;
    for (let p = 0; p < 2; p++) {
      const page = file.read(p);
      assert.equal(page.samplesPerPixel, 1, name);
      assert.equal(page.width, 21, name);
      assert.equal(page.height, 19, name);
      const want = new page.samples.constructor(page.samples.length);
      for (let i = 0; i < want.length; i++, index++)
        want[i] = e.dtype.startsWith('u') ? index * 31 + 50000 : index / 8 - 50;
      assert.deepEqual(page.samples, want, name + ' page ' + p);
      for (const value of page.samples) sum += value;
    }
    assert.equal(sum, e.sum, name);
  }
});
test('raw TIFF bounds, IFD cycles, unsafe BigTIFF pointers and lazy cancellation reject before pixel allocation', {
  timeout: 1000,
}, () => {
  const bytes = read('big-le-uint16-deflate-tile.tif');
  assert.throws(() => openTIFF(bytes, { maxPixels: 0 }), RangeError);
  const file = openTIFF(bytes, { maxPixels: 1 });
  assert.equal(file.length, 2);
  assert.throws(() => file.read(0), /bound/);
  assert.throws(() => file.read(2), /index/);
  const signal = AbortSignal.abort();
  assert.throws(() => file.read(0, signal), { name: 'AbortError' });
  const bad = Uint8Array.from(bytes);
  new DataView(bad.buffer).setBigUint64(8, 2n ** 60n, true);
  assert.throws(() => openTIFF(bad), /safe/);
  const cycle = Uint8Array.from(bytes),
    v = new DataView(cycle.buffer),
    ifd = Number(v.getBigUint64(8, true)),
    count = Number(v.getBigUint64(ifd, true));
  v.setBigUint64(ifd + 8 + count * 20, BigInt(ifd), true);
  assert.throws(() => openTIFF(cycle), /cyclic/);
});
