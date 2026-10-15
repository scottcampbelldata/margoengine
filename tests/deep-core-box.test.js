import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '../packages/core/dist/index.js';

test('Box compaction retains exact geometry and avoids per-face index maps', () => {
  const original = Array.prototype.map;
  let maps = 0;
  Array.prototype.map = function (...args) {
    maps++;
    return original.apply(this, args);
  };
  let geometry;
  try {
    geometry = box(2, 3, 4);
  } finally {
    Array.prototype.map = original;
  }
  assert.equal(maps, 1, 'Only the bounds center requires a map');
  const positions = [],
    normals = [],
    indices = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [-1, 1]) {
      const start = positions.length / 3,
        u = (axis + 1) % 3,
        v = (axis + 2) % 3;
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const p = [0, 0, 0],
          n = [0, 0, 0];
        p[axis] = side;
        p[u] = a;
        p[v] = b;
        n[axis] = side;
        positions.push((p[0] * 2) / 2, (p[1] * 3) / 2, (p[2] * 4) / 2);
        normals.push(...n);
      }
      indices.push(...(side > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map((i) => start + i));
    }
  const vertices = new Float32Array(positions.length * 2);
  for (let i = 0; i < positions.length / 3; i++)
    for (let j = 0; j < 3; j++) {
      vertices[i * 6 + j] = positions[i * 3 + j];
      vertices[i * 6 + 3 + j] = normals[i * 3 + j];
    }
  assert.deepEqual(Buffer.from(geometry.vertices.buffer), Buffer.from(vertices.buffer));
  assert.deepEqual(geometry.indices, new Uint32Array(indices));
  assert.deepEqual(geometry.bounds, new Float32Array([0, 0, 0, Math.hypot(1, 1.5, 2)]));
});

test('Material hex conversion uses one map and retains exact sRGB decoding', () => {
  const original = Array.prototype.map;
  let maps = 0;
  Array.prototype.map = function (...args) {
    maps++;
    return original.apply(this, args);
  };
  let material;
  try {
    material = new PbrMaterial({ color: '#01a0ff', roughness: 0.6, metalness: 0.3 });
  } finally {
    Array.prototype.map = original;
  }
  assert.equal(maps, 1);
  const reference = [1, 160, 255]
    .map((value) => value / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  assert.deepEqual(material.data, new Float32Array([...reference, 1, 0.6, 0.3, 1, 0]));
});
