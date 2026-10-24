// RGBA8 depth/distance packing: the WGSL margoPackDepth, run on the CPU, against the documented format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wgslModule } from './support/wgsl-subset.js';

const source = readFileSync(new URL('../src/depth-distance.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shader = wgslModule(/fn margoPackDepth[\s\S]*?\n\}\n/.exec(source)[0]);
// The rgba8unorm write: round(clamp(x) * 255).
const bytes = (value) =>
  shader.call('margoPackDepth', Math.fround(value)).map((c) => Math.round(Math.min(Math.max(c, 0), 1) * 255));
// The README decoder: v = R/2^8 + G/2^16 + B/2^24 + (A/255)/2^24, all-255 meaning exactly 1.
const decode = ([r, g, b, a]) =>
  r === 255 && g === 255 && b === 255 && a === 255 ? 1 : r / 256 + g / 65536 + (b + a / 255) / 16777216;

// [float32 input, RGBA bytes, decoded] from the documented format (binding: RGB exact, A +-1, decoded within 3e-6).
const vectors = [
  [-1, [0, 0, 0, 0], 0],
  [0, [0, 0, 0, 0], 0],
  [9.999999717180685e-10, [0, 0, 0, 4], 9.349748200061274e-10],
  [5.960464477539063e-8, [0, 0, 1, 0], 5.960464477539063e-8],
  [9.999999974752427e-7, [0, 0, 16, 198], 9.999555699965534e-7],
  [0.0010000000474974513, [0, 65, 137, 55], 0.0009999999813005036],
  [0.10000000149011612, [25, 153, 153, 159], 0.10000000140246224],
  [0.25, [64, 0, 0, 0], 0.25],
  [0.3333333134651184, [85, 85, 85, 0], 0.3333333134651184],
  [0.5, [128, 0, 0, 0], 0.5],
  [0.699999988079071, [179, 51, 51, 0], 0.699999988079071],
  [0.8999999761581421, [230, 102, 102, 0], 0.8999999761581421],
  [0.9990000128746033, [255, 190, 119, 0], 0.9990000128746033],
  [0.9999999403953552, [255, 255, 255, 0], 0.9999999403953552],
  [1, [255, 255, 255, 255], 1],
  [2, [255, 255, 255, 255], 1],
  [0.12345679104328156, [31, 154, 221, 64], 0.12345679110171748],
  [0.9876543283462524, [252, 214, 234, 0], 0.9876543283462524],
  [0.00390625, [1, 0, 0, 0], 0.00390625],
  [0.0000152587890625, [0, 1, 0, 0], 0.0000152587890625],
];

test('margoPackDepth matches the documented RGBA vectors', () => {
  for (const [input, expected, decoded] of vectors) {
    const actual = bytes(input);
    assert.deepEqual(actual.slice(0, 3), expected.slice(0, 3), `RGB of ${input}`);
    assert.ok(Math.abs(actual[3] - expected[3]) <= 1, `A of ${input}: ${actual[3]} vs ${expected[3]}`);
    assert.ok(Math.abs(decode(actual) - decoded) <= 3e-6, `decoded ${input}`);
  }
});

test('endpoints are exact and the packed bytes are integers in 0..255 before the unorm write', () => {
  assert.deepEqual(shader.call('margoPackDepth', 0), [0, 0, 0, 0]);
  assert.deepEqual(shader.call('margoPackDepth', -0.5), [0, 0, 0, 0]);
  assert.deepEqual(shader.call('margoPackDepth', 1), [1, 1, 1, 1]);
  assert.deepEqual(shader.call('margoPackDepth', 7), [1, 1, 1, 1]);
  for (const v of [0.1, 0.5, 0.75, 0.999]) {
    const rgb = shader.call('margoPackDepth', Math.fround(v)).slice(0, 3);
    for (const c of rgb)
      assert.ok(Number.isInteger(Math.fround(c * 255)) || Math.abs(c * 255 - Math.round(c * 255)) < 1e-4);
  }
});

test('round trip error stays within 3e-6 (in fact one 2^24 step) across [0, 1]', () => {
  let worst = 0;
  const check = (v) => {
    const x = Math.fround(v),
      error = Math.abs(decode(bytes(x)) - x);
    worst = Math.max(worst, error);
    // Exact 24-bit part plus at most half an alpha step of 2^-24/255.
    assert.ok(error <= 1 / 16777216, `${x}: error ${error}`);
  };
  for (let i = 0; i <= 20000; i++) check(i / 20000);
  for (let k = 1; k <= 24; k++) for (const d of [-1, 0, 1]) check(2 ** -k + d * 2 ** -30);
  let seed = 7;
  for (let i = 0; i < 5000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    check(seed / 2 ** 32);
  }
  assert.ok(worst <= 3e-6);
});

test('the integer split of q = floor(v * 2^24) is exact: bytes reassemble q', () => {
  for (const q of [0, 1, 255, 256, 65535, 65536, 0x123456, 0xfffffe, 0xffffff]) {
    const v = q / 16777216;
    if (v >= 1 || v <= 0) continue;
    const [r, g, b] = bytes(v);
    assert.equal(r * 65536 + g * 256 + b, q);
  }
});
