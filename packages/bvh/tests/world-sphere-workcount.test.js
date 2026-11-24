// Batch 162 row 16.1: the per-ray, per-mesh world bounding sphere reads its 12 matrix and 4 sphere values once.
// Output is compared bit for bit with the parent formula, written out here as the reference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldSphere } from '../dist/raycaster.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
function parent(m, o, b, out) {
  const xy = Math.abs(m[o] * m[o + 4] + m[o + 1] * m[o + 5] + m[o + 2] * m[o + 6]);
  const xz = Math.abs(m[o] * m[o + 8] + m[o + 1] * m[o + 9] + m[o + 2] * m[o + 10]);
  const yz = Math.abs(m[o + 4] * m[o + 8] + m[o + 5] * m[o + 9] + m[o + 6] * m[o + 10]);
  const scale = Math.sqrt(Math.max(
    m[o] ** 2 + m[o + 1] ** 2 + m[o + 2] ** 2 + xy + xz,
    m[o + 4] ** 2 + m[o + 5] ** 2 + m[o + 6] ** 2 + xy + yz,
    m[o + 8] ** 2 + m[o + 9] ** 2 + m[o + 10] ** 2 + xz + yz,
  ));
  out[0] = m[o] * b[0] + m[o + 4] * b[1] + m[o + 8] * b[2] + m[o + 12];
  out[1] = m[o + 1] * b[0] + m[o + 5] * b[1] + m[o + 9] * b[2] + m[o + 13];
  out[2] = m[o + 2] * b[0] + m[o + 6] * b[1] + m[o + 10] * b[2] + m[o + 14];
  out[3] = b[3] * scale * (1 + 1e-5) + 1e-6;
  return out;
}
// Object.is equality is bit equality for every double except NaN, whose payload bits ECMAScript leaves to the engine.
const bytes = (a) => [...a].map((x) => (Number.isNaN(x) ? 'NaN' : [...new Uint8Array(Float64Array.of(x).buffer)].join()));

test('worldSphere matches the parent bit for bit: shear, mirror, offsets and extremes', () => {
  const pick = random(161), specials = [-0, 1e30, -1e-30, Infinity, NaN, 3.4e38];
  for (let round = 0; round < 500; round++) {
    // Several matrices in one store, read at a non-zero offset, as the Raycaster reads store.matrices.
    const store = new Float32Array(48), o = 16 * (round % 3);
    for (let i = 0; i < 48; i++) store[i] = (pick() - 0.5) * (round % 4 === 0 ? 1e4 : 4);
    if (round % 5 === 0) store[o + (round % 11)] *= -1; // mirror or shear term
    if (round % 25 === 0) store[o + (round % 15)] = specials[round % specials.length];
    const b = round % 2 ? [pick() * 10 - 5, pick() * 10 - 5, pick() * 10 - 5, pick() * 3] : Float64Array.of(-0, 2, -3, 0);
    const got = worldSphere(store, o, b, new Float64Array(4)), want = parent(store, o, b, new Float64Array(4));
    assert.deepEqual(bytes(got), bytes(want), `round ${round}`);
    const f64 = Float64Array.from(store.subarray(o, o + 16));
    assert.deepEqual(bytes(worldSphere(f64, 0, b, new Float64Array(4))), bytes(parent(f64, 0, b, new Float64Array(4))));
  }
});

test('worldSphere reads each matrix and sphere value once', () => {
  let reads = 0;
  const counted = (a) => new Proxy(a, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return target[key];
    },
  });
  const m = new Float32Array(32);
  m.set([2, 0.1, 0, 0, 0, 3, 0.2, 0, 0, 0, -1, 0, 5, 6, 7, 1], 16);
  worldSphere(counted(m), 16, counted([1, 2, 3, 0.5]), new Float64Array(4));
  // The parent read the matrix 39 times and the sphere 10 times.
  assert.equal(reads, 12 + 4);
});
