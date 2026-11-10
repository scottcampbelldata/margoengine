// parametricGeometry validates each sample from the three coordinates it reads once, without a temporary array.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parametricGeometry } from '../dist/extras.js';
import { klein } from '../../../bench/scenes/parity/margo-geometry.js';

const digest = (g) => {
  const hash = createHash('sha256');
  for (const k of ['positions', 'normals', 'uvs', 'indices'])
    hash.update(new Uint8Array(g[k].buffer, g[k].byteOffset, g[k].byteLength));
  return hash.digest('hex');
};
// A sphere returning arrays (poles take the inset and fallback normal paths), a torus writing into target and a
// surface returning a Float32Array.
const sphere = (u, v) => {
  const phi = u * 2 * Math.PI, theta = (v - 0.5) * Math.PI;
  return [Math.cos(theta) * Math.sin(phi), Math.sin(theta), Math.cos(theta) * Math.cos(phi)];
};
const torus = (u, v, target) => {
  const a = u * 2 * Math.PI, b = v * 2 * Math.PI;
  target[0] = (1 + 0.3 * Math.cos(b)) * Math.cos(a);
  target[1] = (1 + 0.3 * Math.cos(b)) * Math.sin(a);
  target[2] = 0.3 * Math.sin(b);
};
const cone = (u, v) => Float32Array.of(v * Math.cos(u * 6), v * Math.sin(u * 6), v);
// Parent digests, captured before the change (Klein is the p-geometry-misc surface).
const cases = [
  ['klein 128 x 128', () => parametricGeometry(klein, 128, 128), 'bcb3806e49585e415b9789b27ec08b80ffdb4e490a7c3280762b144394fb99b8'],
  ['sphere 24 x 12', () => parametricGeometry(sphere, 24, 12), '86683decf25a8a7513c5e9531b856c088e667e647a10d55e5e8086d772078167'],
  ['torus 9 x 7', () => parametricGeometry(torus, 9.5, 7), '38c54001d2c0046c3a4ec9266fd456e68a0fafabaaa02ab78c7e172cfe99fb0d'],
  ['cone 5 x 3', () => parametricGeometry(cone, 5, 3), 'ff706a5ab6f34edb64650636c07770a6de5e6b9949b38c818822869891f64a4e'],
];
for (const [name, build, expected] of cases) test(`parametric parent bytes: ${name}`, () => assert.equal(digest(build()), expected));

test('parametricGeometry reads each returned coordinate once', () => {
  let reads = 0;
  const counted = (u, v) => new Proxy(sphere(u, v), {
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
