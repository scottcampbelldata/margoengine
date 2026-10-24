// Checks the shared ACES-style display transform (packages/shared/aces.js) on the CPU: the curve and matrices are read
// back out of the WGSL text and evaluated in f32, then compared with a behaviour table in 8-bit sRGB codes, and
// checked for the properties the Tonemap 'acescg' curve promises (black to 0, greys stay grey, monotone, 0..1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { acesShader } from '../../shared/aces.js';

// Behaviour table the fit targets: display-linear outputs (before the sRGB encoding, clamped 0..1) of the ACES 1.x
// RRT + sRGB 100-nit ODT approximation this engine shipped before, sampled on the CPU. GREY[i] is the output for a
// grey input of 0.18 * 2^(i / 2 - 10), i.e. -10..+10 stops around mid grey in half stops.
const GREY = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0.0000961, 0.0003299, 0.0006965, 0.0012857, 0.0022577, 0.0039011, 0.0067393, 0.0117142,
  0.0204869, 0.0358632, 0.0622335, 0.1055912, 0.1722321, 0.2653406, 0.3806981, 0.5057754, 0.6249711, 0.7268592,
  0.8072255, 0.8673507, 0.9109444, 0.9420248, 0.9640058, 0.979501, 0.9904148, 0.9981035, 1, 1, 1, 1, 1, 1,
];
/** [input linear Rec.709, display-linear output] for primaries, secondaries (at 1 and 10) and mixed colours. */
const COLOUR = [
  [
    [4, 0.25, 0.1],
    [1, 0.3526466, 0.1306049],
  ],
  [
    [0.01, 3, 0.3],
    [0.543927, 0.883515, 0.4416677],
  ],
  [
    [1, 0, 0],
    [0.6880279, 0, 0.002639],
  ],
  [
    [0, 1, 0],
    [0.1016133, 0.623659, 0.0288437],
  ],
  [
    [0, 0, 1],
    [0, 0, 0.6017588],
  ],
  [
    [1, 1, 0],
    [0.6347105, 0.6182625, 0.0506385],
  ],
  [
    [0, 1, 1],
    [0.1228306, 0.6226817, 0.6119016],
  ],
  [
    [1, 0, 1],
    [0.6865096, 0, 0.6101574],
  ],
  [
    [10, 0, 0],
    [1, 0.4842714, 0.1726098],
  ],
  [
    [0, 10, 0],
    [0.8696601, 0.978639, 0.687368],
  ],
  [
    [0, 0, 10],
    [0.4637224, 0.0522099, 1],
  ],
  [
    [0.5, 0.25, 0.1],
    [0.3665486, 0.1727652, 0.0561292],
  ],
  [
    [0.05, 0.1, 0.4],
    [0.0103083, 0.0428704, 0.2730267],
  ],
  [
    [2, 2, 1],
    [0.8064454, 0.8031211, 0.6559737],
  ],
];

const f = Math.fround;
const numbers = (text) => text.split(',').map((v) => f(Number(v)));
/** Reads mat3x3f(vec3f(...),vec3f(...),vec3f(...)) columns from the WGSL text into row-major rows. */
function matrices(code) {
  return [...code.matchAll(/mat3x3f\(vec3f\(([^)]*)\),vec3f\(([^)]*)\),vec3f\(([^)]*)\)\)/g)].map((m) => {
    const cols = [numbers(m[1]), numbers(m[2]), numbers(m[3])];
    return [0, 1, 2].map((r) => cols.map((c) => c[r]));
  });
}
const [inMix, outMix] = matrices(acesShader);
const k = f(Number(/pow\(x,vec3f\(([-\d.]+)\)\)/.exec(acesShader)[1])),
  [, peak, s, q] = /let y=([-\d.]+)\*pow\(w\/\(w\+([-\d.]+)\),vec3f\(([-\d.]+)\)\)/.exec(acesShader).map(Number);
const mul = (M, v) => M.map((r) => f(f(f(r[0] * v[0]) + f(r[1] * v[1])) + f(r[2] * v[2])));
/** CPU twin of `fn aces` (f32 at each step). */
function aces(v) {
  const x = mul(inMix, v).map((c) => Math.max(0, c)),
    y = x.map((c) => {
      const w = f(c ** k);
      return f(f(peak) * f(f(w / f(w + f(s))) ** f(q)));
    });
  return mul(outMix, y).map((c) => Math.min(1, Math.max(0, c)));
}
const encode = (c) => (c < 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const codes = (a, b) => Math.abs(255 * (encode(a) - encode(b)));

test('aces WGSL is one self-contained function', () => {
  assert.match(acesShader, /^fn aces\(v:vec3f\)->vec3f\{/);
  assert.equal(acesShader.match(/\bfn /g).length, 1);
  assert.doesNotMatch(acesShader, /@group|@binding|var<|override|struct /);
  assert.equal(matrices(acesShader).length, 2);
  for (const M of [inMix, outMix]) for (const row of M) assert.ok(Math.abs(row[0] + row[1] + row[2] - 1) < 1e-6);
  assert.ok(peak > 1, 'the curve must pass display white at a finite input');
});

// Measured with the shipped constants: at most 1.27 codes (grey ramp 1.11, colours 1.27), mean 0.42 codes; in display-
// linear units at most 0.0104, mean 0.0018. Fit scripts: the clean-room scratch folder aces-fit-2 (fit, minimax, gen).
test('aces matches the behaviour table within 1.5 sRGB codes (mean under 0.5)', () => {
  const errors = [],
    rows = [];
  GREY.forEach((target, i) => {
    const g = 0.18 * 2 ** (i / 2 - 10);
    rows.push([
      [g, g, g],
      [target, target, target],
    ]);
  });
  rows.push(...COLOUR);
  for (const [input, target] of rows) {
    const out = aces(input);
    for (let c = 0; c < 3; c++) errors.push(codes(out[c], target[c]));
  }
  const max = Math.max(...errors),
    mean = errors.reduce((a, b) => a + b) / errors.length;
  assert.ok(max <= 1.5, `max ${max.toFixed(3)} codes`);
  assert.ok(mean <= 0.5, `mean ${mean.toFixed(3)} codes`);
});

test('aces keeps black at 0, greys grey and the grey axis monotone over 1e-4..1e4', () => {
  assert.deepEqual(aces([0, 0, 0]), [0, 0, 0]);
  let previous = 0;
  for (let e = -4; e <= 4; e += 1 / 64) {
    const x = 10 ** e,
      [r, g, b] = aces([x, x, x]);
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 1e-5, `grey ${x} -> ${r} ${g} ${b}`);
    assert.ok(g >= previous, `grey axis falls at ${x}`);
    previous = g;
  }
  assert.deepEqual(aces([1e3, 1e3, 1e3]), [1, 1, 1]);
  const mid = aces([0.18, 0.18, 0.18])[0];
  assert.ok(mid > 0.09 && mid < 0.12, `mid grey -> ${mid}`);
});

test('aces output stays within 0..1 and each channel rises with exposure', () => {
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 2000; i++) {
    const base = [next(), next(), next()],
      scale = 2 ** (24 * next() - 12),
      out = aces(base.map((c) => c * scale)),
      brighter = aces(base.map((c) => c * scale * 2));
    for (let c = 0; c < 3; c++) {
      assert.ok(out[c] >= 0 && out[c] <= 1);
      assert.ok(brighter[c] >= out[c] - 1e-6, `channel ${c} of ${base} falls when x${scale} doubles`);
    }
  }
});
