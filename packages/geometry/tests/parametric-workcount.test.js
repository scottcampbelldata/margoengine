// parametricGeometry validates each sample from the three coordinates it reads once, without a temporary array.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parametricGeometry } from '../dist/extras.js';

const digest = (g) => {
  const hash = createHash('sha256');
  for (const k of ['positions', 'normals', 'uvs', 'indices'])
    hash.update(new Uint8Array(g[k].buffer, g[k].byteOffset, g[k].byteLength));
  return hash.digest('hex');
};
// Sine and cosine from basic arithmetic only: the angle is reduced to [-pi, pi] and summed as a fixed Taylor series.
// +, -, * and / are correctly rounded IEEE 754 operations on every machine, so these are the same bits everywhere.
// Math.sin and Math.cos are not (ECMA-262 leaves them implementation-approximated): the x64 machine that first
// recorded these digests and an arm64 Mac disagree in the last bit of about 3% of the Klein samples.
const TAU = 2 * Math.PI;
const sin = (a) => {
  const r = a - Math.round(a / TAU) * TAU,
    r2 = r * r;
  let term = r,
    sum = r;
  for (let k = 2; k < 36; k += 2) {
    term *= -r2 / (k * (k + 1));
    sum += term;
  }
  return sum;
};
const cos = (a) => {
  const r = a - Math.round(a / TAU) * TAU,
    r2 = r * r;
  let term = 1,
    sum = 1;
  for (let k = 1; k < 36; k += 2) {
    term *= -r2 / (k * (k + 1));
    sum += term;
  }
  return sum;
};
// A sphere returning arrays, a torus writing into target, a surface returning a Float32Array and the Klein bottle of
// the p-geometry-misc scene (its formula, with products for the powers).
const sphere = (u, v) => {
  const phi = u * 2 * Math.PI,
    theta = (v - 0.5) * Math.PI;
  return [cos(theta) * sin(phi), sin(theta), cos(theta) * cos(phi)];
};
const torus = (u, v, target) => {
  const a = u * 2 * Math.PI,
    b = v * 2 * Math.PI;
  target[0] = (1 + 0.3 * cos(b)) * cos(a);
  target[1] = (1 + 0.3 * cos(b)) * sin(a);
  target[2] = 0.3 * sin(b);
};
const cone = (u, v) => Float32Array.of(v * cos(u * 6), v * sin(u * 6), v);
const klein = (u, v, target) => {
  u *= Math.PI;
  v *= 2 * Math.PI;
  const cu = cos(u),
    su = sin(u),
    cv = cos(v),
    sv = sin(v),
    cu2 = cu * cu,
    cu3 = cu2 * cu,
    cu4 = cu2 * cu2,
    cu5 = cu4 * cu,
    cu6 = cu4 * cu2,
    cu7 = cu6 * cu;
  target[0] = (-2 / 15) * cu * (3 * cv - 30 * su + 90 * cu4 * su - 60 * cu6 * su + 5 * cu * cv * su);
  target[1] =
    (-1 / 15) *
    su *
    (3 * cv -
      3 * cu2 * cv -
      48 * cu4 * cv +
      48 * cu6 * cv -
      60 * su +
      5 * cu * cv * su -
      5 * cu3 * cv * su -
      80 * cu5 * cv * su +
      80 * cu7 * cv * su);
  target[2] = (2 / 15) * (3 + 5 * cu * su) * sv;
};
// Parent digests: the parent of the sample-check change (b482ea72a) gives the same four on an arm64 Mac.
const cases = [
  [
    'klein 128 x 128',
    () => parametricGeometry(klein, 128, 128),
    '1f2ec53fe529d3f1cd20e9c591371d81663b5aacd41e902418cf09e4caadcb10',
  ],
  [
    'sphere 24 x 12',
    () => parametricGeometry(sphere, 24, 12),
    '39884a04175ec156d33f806f7899327474b33cc5ba4dd3b040a96eea81f45192',
  ],
  [
    'torus 9 x 7',
    () => parametricGeometry(torus, 9.5, 7),
    'eefb77d8156989b68a3724528ab1e7acb882e6b00518505df9cab310b97e64fe',
  ],
  [
    'cone 5 x 3',
    () => parametricGeometry(cone, 5, 3),
    'ff706a5ab6f34edb64650636c07770a6de5e6b9949b38c818822869891f64a4e',
  ],
];
for (const [name, build, expected] of cases)
  test(`parametric parent bytes: ${name}`, () => assert.equal(digest(build()), expected));

test('parametricGeometry reads each returned coordinate once', () => {
  let reads = 0;
  const counted = (u, v) =>
    new Proxy(sphere(u, v), {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return target[key];
      },
    });
  parametricGeometry(counted, 4, 2);
  // 15 vertices, each sampled once for its position and four times for its normal: 75 samples. The parent read
  // 6 coordinates per sample (450: a temporary array for the finite check, then the copy).
  assert.equal(reads, 75 * 3);
});

test('parametricGeometry still rejects a non-finite coordinate', () => {
  assert.throws(() => parametricGeometry(() => [0, NaN, 0], 2, 2), RangeError);
  assert.throws(() => parametricGeometry(() => [0, 0, Infinity], 2, 2), RangeError);
});
