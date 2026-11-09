// scripts/support/mirror-compare.mjs: the 4x mirror check holds the flat pixels of the reference to rounding and leaves
// edges to the mirror-view comparison, so a correct mirror whose edge pixels happen to be just over 1 percent of the
// region no longer fails a p99 bound (environment test:gpu:mirror on the Radeon 680M, 2026-11-08: 285 of 28374 channel
// values over 4, p99 5), while an error away from edges still fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFlat } from '../scripts/support/mirror-compare.mjs';

const W = 40,
  H = 30;
// A grey picture with a dark square from x = 10 to 29, y = 8 to 21 (an edge on four sides).
const scene = () => {
  const pixels = new Array(W * H * 4).fill(255);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = x >= 10 && x < 30 && y >= 8 && y < 22 ? 40 : 180;
      pixels.splice((y * W + x) * 4, 3, v, v, v);
    }
  return { pixels };
};
const all = new Uint8Array(W * H).fill(1);
const set = (image, x, y, v) => image.pixels.splice((y * W + x) * 4, 3, v, v, v);

test('an equal picture matches; pixels next to an edge are left out', () => {
  const { pixels, max } = compareFlat(scene(), scene(), all, W, H);
  assert.equal(max, 0);
  // Two pixel columns or rows on each side of each edge of the square are not flat.
  assert.equal(pixels, W * H - (2 * 20 * 2 + 2 * 14 * 2));
});

test('edge pixels mixed differently (another coverage) pass; that many in a p99 would have failed', () => {
  const image = scene();
  // Every pixel on the square's left edge takes a quarter step of the 140 contrast, as a flipped sample pattern gives.
  for (let y = 8; y < 22; y++) set(image, 10, y, 75);
  assert.equal(compareFlat(image, scene(), all, W, H).max, 0);
  // The same differences over the whole picture: 42 of 3600 channel values over 4, above 1 percent.
  assert.ok((14 * 3) / (W * H * 3) > 0.01);
});

test('a flat pixel off by more than rounding fails', () => {
  const image = scene();
  set(image, 20, 15, 43);
  assert.equal(compareFlat(image, scene(), all, W, H).max, 3);
  set(image, 20, 15, 41);
  assert.equal(compareFlat(image, scene(), all, W, H).max, 1);
});

test('a reference with a soft gradient still counts as flat within two steps', () => {
  const reference = scene(),
    image = scene();
  set(reference, 3, 3, 182);
  set(image, 3, 3, 182);
  set(image, 4, 4, 183);
  const { max } = compareFlat(image, reference, all, W, H);
  assert.equal(max, 3);
});

test('only masked pixels count', () => {
  const image = scene(),
    mask = new Uint8Array(W * H);
  set(image, 20, 15, 90);
  mask[0] = 1;
  assert.deepEqual(compareFlat(image, scene(), mask, W, H), { pixels: 1, max: 0 });
});
