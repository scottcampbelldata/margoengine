// The blended-4x tolerance (docs/known-bugs.md, "4x MSAA blending is not repeatable") passes a 1 ulp difference and
// nothing larger, and applies to blended 4x views only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLENDED_4X_MAX_CHANNEL_DIFF, compareImages, halfUlp, toleranceFor } from './blend-tolerance.js';

const W = 8,
  image = (fill) => new Uint8ClampedArray(W * W * 4).fill(fill),
  withPixels = (img, list, delta) => {
    const out = img.slice();
    for (const [x, y] of list) out[(y * W + x) * 4 + 1] += delta;
    return out;
  },
  square = [
    [1, 1],
    [2, 1],
    [1, 2],
    [2, 2],
  ],
  bg = [0, 0, 0];

test('the tolerance applies to blended views at 4x only', () => {
  assert.equal(BLENDED_4X_MAX_CHANNEL_DIFF, 1);
  assert.equal(toleranceFor({ samples: 4, blended: true }), 1);
  assert.equal(toleranceFor({ samples: 4, blended: false }), 0);
  assert.equal(toleranceFor({ samples: 1, blended: true }), 0);
  assert.equal(toleranceFor({ samples: 1, blended: false }), 0);
});

test('a difference of 1 passes at tolerance 1, a difference of 2 fails, and strict counts both', () => {
  const a = image(100),
    one = compareImages(withPixels(a, square, 1), a, bg, W, 1);
  assert.equal(one.differing, 0);
  assert.equal(one.blocks, 0);
  assert.equal(one.strictDiffering, 4);
  assert.equal(one.strictBlocks, 1);
  const two = compareImages(withPixels(a, square, 2), a, bg, W, 1);
  assert.equal(two.differing, 4);
  assert.equal(two.blocks, 1);
  assert.equal(two.max, 2);
  assert.equal(compareImages(withPixels(a, square, 1), a, bg, W).differing, 4, 'exact by default');
});

test('one pixel off by 2 is caught among pixels off by 1', () => {
  const a = image(100),
    b = withPixels(
      withPixels(
        a,
        [
          [3, 3],
          [4, 4],
        ],
        1,
      ),
      [[5, 5]],
      2,
    ),
    r = compareImages(b, a, bg, W, 1);
  assert.equal(r.differing, 1);
  assert.deepEqual(r.at[0].slice(0, 2), [5, 5]);
});

test('a deliberate wrong draw order (a whole overlap area off by far more than 1) is caught', () => {
  const a = image(100),
    area = [];
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) area.push([x, y]);
  const r = compareImages(withPixels(a, area, 40), a, bg, W, BLENDED_4X_MAX_CHANNEL_DIFF);
  assert.equal(r.differing, 16);
  assert.ok(r.blocks > 0);
});

test('HDR images: 1 half-float ulp passes, 2 fail', () => {
  const a = new Float32Array(W * W * 4).fill(0.5),
    one = a.slice(),
    two = a.slice();
  one[0] += halfUlp(0.5);
  two[0] += 2 * halfUlp(0.5);
  assert.equal(halfUlp(0.5), 2 ** -11);
  assert.equal(compareImages(one, a, bg, W, 1).differing, 0);
  assert.equal(compareImages(two, a, bg, W, 1).differing, 1);
  assert.equal(compareImages(one, a, bg, W).differing, 1);
});
