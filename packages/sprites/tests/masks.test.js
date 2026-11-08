// Node checks of SpriteLayer masks: world units to layer pixels, and invalid masks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskPixels, SpriteLayer } from '../dist/index.js';

test('masks go to layer pixels through the camera: rect corners and a circle centre and radius', () => {
  const camera = { x: 1, y: -2, zoom: 3 };
  assert.deepEqual(maskPixels(undefined, camera), [0, 0, 0, 0, 0, 0, 0, 0]);
  // (3 - 1) * 3 = 6, (2 + 2) * 3 = 12, (3 + 4 - 1) * 3 = 18, (2 + 5 + 2) * 3 = 27.
  assert.deepEqual(maskPixels({ rect: [3, 2, 4, 5] }, camera), [1, 0, 0, 0, 6, 12, 18, 27]);
  assert.deepEqual(maskPixels({ circle: [2, 0, 1.5], outside: true }, camera), [2, 1, 0, 0, 3, 6, 4.5, 0]);
});

test('an invalid mask throws a RangeError that names both shapes', () => {
  const camera = { x: 0, y: 0, zoom: 1 };
  for (const mask of [
    {},
    { rect: [0, 0, 1] },
    { rect: [0, 0, -1, 1] },
    { circle: [0, 0, NaN] },
    { circle: [0, 0, -1] },
  ])
    assert.throws(() => maskPixels(mask, camera), /rect \[x, y, width, height\] or circle/);
});

test('a layer keeps its mask and lets it change', () => {
  const layer = new SpriteLayer({
    atlas: { width: 1, height: 1, data: new Uint8Array(4) },
    mask: { circle: [0, 0, 1] },
  });
  assert.deepEqual(layer.mask, { circle: [0, 0, 1] });
  layer.mask = undefined;
  assert.equal(layer.mask, undefined);
});
