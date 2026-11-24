// Quickhull eye selection: each face keeps its farthest outside point as points are assigned, instead of
// measuring every outside point again when the face is processed (Barber, Dobkin and Huhdanpaa 1996).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { convexGeometry } from '../dist/extras.js';
import { convexHullTriangles } from '../dist/hull.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ball = (seed, n) => {
  const pick = random(seed), points = [];
  while (points.length < n * 3) {
    const p = [pick() * 2 - 1, pick() * 2 - 1, pick() * 2 - 1];
    if (p[0] ** 2 + p[1] ** 2 + p[2] ** 2 <= 1) points.push(...p);
  }
  return Float32Array.from(points);
};
const sphere = (seed, n) => {
  const pick = random(seed), points = [];
  for (let i = 0; i < n; i++) {
    const z = pick() * 2 - 1, a = pick() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    points.push([r * Math.cos(a), r * Math.sin(a), z]);
  }
  return points;
};
const grid = [];
for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) for (let z = 0; z < 5; z++) grid.push([x, y, z], [x, y, z]);
const ties = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2], [2, 2, 2], [2, 2, -2], [-2, 2, 2], [2, -2, 2], [1, 1, 1]];
const inputs = { ball: ball(29, 20000), sphere: sphere(7, 3000), grid, ties, offset: sphere(11, 500).map(([x, y, z]) => [x * 1e6 + 3e8, y * 1e5, z * 1e6]) };
// Parent digests of every output stream, captured before the change.
const expected = {
  ball: 'a559f82e5351de7e5dba06162c4e15548d847c372e06c5b9ccaf53d4c7e952ef',
  sphere: 'b6866cf30bdc79d91ec5006b9fab239f00b858ace0adeface7cf3990fb862aa5',
  grid: '3281ca885cb9d44d2c5b8cc7e358f4820a518d6745a2595158bbb34b21ca2a3a',
  ties: 'ea2ea59074711f157fcbf40175b75cf1d2f8a1a043ce530d75b4e67e5fc25745',
  offset: '8e4a434a0abd96e460e727b1b017bc8f9eea30d6206adc514d5dfe16dba759b5',
};
const digest = (arrays) => {
  const hash = createHash('sha256');
  for (const a of arrays) hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return hash.digest('hex');
};
const outputs = (points) => {
  const g = convexGeometry(points);
  return digest([g.positions, g.normals, g.uvs, g.indices, convexHullTriangles(points)]);
};
for (const [name, points] of Object.entries(inputs))
  test(`convex hull parent bytes: ${name}`, () => assert.equal(outputs(points), expected[name]));

test('convexGeometry reads each outside point once per assignment, not again to pick the eye', () => {
  const Real = Float64Array;
  let reads = 0;
  const handler = {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return target[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  };
  globalThis.Float64Array = class extends Real {
    constructor(...args) {
      super(...args);
      return new Proxy(this, handler);
    }
  };
  try {
    convexGeometry(inputs.ball);
  } finally {
    globalThis.Float64Array = Real;
  }
  // Parent: 1,922,724 coordinate reads; the eye rescan measured 30,785 outside points a second time (3 reads each).
  assert.equal(reads, 1_830_369);
});
