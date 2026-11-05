// The biomes shadows check without a GPU. On an Apple M6 (2026-11-05) it failed with "shadows brighten nothing" on 52
// to 60 pixels, yet two views without shadows already differed in 428 pixels there: a 4x MSAA frame's edge pixels
// followed the order scatter's GPU cull appended instances in (fixed 2026-11-05: the cull keeps candidate order; see
// "Apple GPUs: 4x MSAA edges of scatter instances" in the fixed tables of docs/known-bugs.md). The check compares two
// views without shadows first and fails there, and draws single-sampled frames unless asked for 4x MSAA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareShadows, luma } from './shadows-compare.mjs';

const frame = (pixels) => new Float32Array(pixels.flatMap((v) => [v, v, v, 1]));

test('luma weighs red, green and blue by Rec. 709', () => {
  const [l] = luma(new Float32Array([1, 0, 0, 1]));
  assert.ok(Math.abs(l - 0.2126) < 1e-7);
  assert.ok(Math.abs(luma(new Float32Array([0, 1, 0, 1]))[0] - 0.7152) < 1e-7);
  assert.ok(Math.abs(luma(new Float32Array([0, 0, 1, 1]))[0] - 0.0722) < 1e-7);
});

test('a baseline that changes between two views shows as the control, not as shadows', () => {
  // The Mac's case: the second view draws one edge pixel brighter, and the shadowed frame catches that brighter state.
  const first = frame([0.1, 0.2, 0.3, 0.4]),
    again = frame([0.1, 0.2, 0.3, 0.44]),
    shadowed = frame([0.05, 0.2, 0.3, 0.44]);
  const r = compareShadows(first, again, shadowed, 2);
  assert.equal(r.control, 3, 'three channels of one pixel differ between the views');
  assert.equal(r.brighter, 1, 'the brighter pixel is still counted, but the control fails before it is read');
});

test('with an exact control, darker and brighter pixels are counted as before', () => {
  const first = frame([0.1, 0.2, 0.3, 0.4]),
    shadowed = frame([0.07, 0.2, 0.3030001, 0.405]);
  const r = compareShadows(first, first.slice(), shadowed, 2);
  assert.equal(r.control, 0);
  assert.equal(r.pixels, 4);
  assert.equal(r.darker, 0.25, '0.1 to 0.07 is 30 percent darker');
  assert.equal(r.brighter, 1, '0.4 to 0.405 is past 1 percent; 0.3 to 0.303 is within it');
  assert.deepEqual(
    r.bright.map(([x, y]) => [x, y]),
    [[1, 1]],
  );
  assert.equal(r.lit, 1);
});

test('the control compares bits: one value off by a float step fails it', () => {
  const first = frame([0.25, 0.5]),
    again = first.slice();
  again[4] = Math.fround(0.5 + 2 ** -24);
  assert.equal(compareShadows(first, again, first, 2).control, 1);
});

test('frames of another size or partial rows are refused', () => {
  assert.throws(() => compareShadows(frame([1, 2]), frame([1]), frame([1, 2]), 2), RangeError);
  assert.throws(() => compareShadows(frame([1, 2, 3]), frame([1, 2, 3]), frame([1, 2, 3]), 2), RangeError);
});

test('the check page draws single-sampled frames unless asked for 4x MSAA', () => {
  const page = readFileSync(join(import.meta.dirname, 'shadows-check.html'), 'utf8');
  assert.match(page, /has\('msaa'\)\?\{\}:\{exactSize:\[320,240\]\}/);
  assert.match(page, /compareShadows\(first,again,shadowed,/);
  const runner = readFileSync(join(import.meta.dirname, 'shadows-check.mjs'), 'utf8');
  assert.match(runner, /assert\.equal\(r\.control, 0,/);
  assert.ok(runner.indexOf('r.control, 0') < runner.indexOf('r.brighter, 0'), 'the control is asserted first');
});
