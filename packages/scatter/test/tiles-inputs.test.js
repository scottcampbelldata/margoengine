import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { ScatterTiles } from '../dist/tiles.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('tile rectangles reject sparse and nonrepresentable GPU inputs before replacing held data', () => {
  for (const bounds of [[0, 0, Infinity, 1], [0, 0, 1e40, 1], [0, 0, 1e-46, 1], [1, 0, 1 + 1e-8, 1], [0, , 1, 1]])
    assert.throws(() => new ScatterTiles(box(), { bounds }), RangeError);
  const h = optionalGPU(), tiles = new ScatterTiles(box(), { bounds: [0, 0, 256, 256] });
  h.engine.use(tiles);
  tiles.setTile('a', [0, 0], 256, new Uint8Array(8));
  h.frame();
  const snapshot = () => h.resources.filter(r => !r.destroyed && [16 * 64 * 8, 17 * 16].includes(r.size))
    .map(r => Buffer.from(new Uint8Array(r.data)));
  const before = snapshot();
  for (const [origin, side] of [[[0, 0], Infinity], [[0, 0], 1e40], [[0, 0], 1e-40], [[0, 0], '2'], [[1e40, 0], 1], [[0, ,], 1]]) {
    assert.throws(() => tiles.setTile('a', origin, side, new Uint8Array(0)), RangeError);
    assert.equal(tiles.size, 1);
    h.frame();
    assert.deepEqual(snapshot(), before);
  }
  tiles.dispose();
});

test('tile records accept byte-aligned subarrays and preserve their eight bytes', () => {
  const h = optionalGPU(), tiles = new ScatterTiles(box(), { bounds: [0, 0, 256, 256] });
  h.engine.use(tiles);
  const bytes = Uint8Array.from([99, 10, 0, 20, 0, 3, 128, 42, 7, 99]);
  tiles.setTile('a', [0, 0], 256, bytes.subarray(1, 9));
  h.frame();
  const records = h.resources.find(r => !r.destroyed && r.size === 16 * 64 * 8);
  assert.deepEqual(new Uint8Array(records.data).slice(0, 8), bytes.slice(1, 9));
  tiles.dispose();
});
