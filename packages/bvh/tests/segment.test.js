import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBVH } from '../dist/index.js';
import { MeshBVH as TreeBVH } from '../dist/tree.js';

const unit = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const build = (positions = unit, options) => MeshBVH.build({ positions: Float32Array.from(positions) }, options);

test('a segment is blocked only by triangles strictly between its ends', () => {
  const bvh = build();
  for (const [p, q, side, hit] of [
    [[0.25, 0.25, 1], [0.25, 0.25, -1], 'double', true],
    [[0.25, 0.25, 1], [0.25, 0.25, -1], 'front', true],
    [[0.25, 0.25, -1], [0.25, 0.25, 1], 'front', false],
    [[0.25, 0.25, -1], [0.25, 0.25, 1], 'back', true],
    [[0.25, 0.25, 0], [0.25, 0.25, 1], 'double', false], // starts on the triangle
    [[0.25, 0.25, 1], [0.25, 0.25, 0], 'double', false], // ends on the triangle
    [[0.25, 0.25, 1], [0.25, 0.25, 0.5], 'double', false], // stops short
    [[0.5, 0.5, 1], [0.5, 0.5, -1], 'double', true], // edge
    [[0, 0, 1], [0, 0, -1], 'double', true], // vertex
    [[2, 2, 1], [2, 2, -1], 'double', false],
  ])
    assert.equal(bvh.intersectsSegment(p, q, { side }), hit, `${p} -> ${q} ${side}`);
  assert.throws(() => bvh.intersectsSegment([0, 0, 1], [0, 0, 1]), RangeError);
  assert.throws(() => bvh.intersectsSegment([0, 0, NaN], [0, 0, 1]), RangeError);
});

test('includeFace sees source face indices and skips only the faces it rejects', () => {
  // Face 0 at z = 0.5 above face 1 at z = 0; one triangle per leaf so leaf order differs from source order.
  const positions = [...unit.map((v, i) => (i % 3 === 2 ? 0.5 : v)), ...unit],
    p = [0.25, 0.25, 1],
    q = [0.25, 0.25, -1];
  const bvh = build(positions, { maxLeafTriangles: 1 }),
    restored = MeshBVH.deserialize(bvh.serialize(), { positions: Float32Array.from(positions) }),
    // Float64 positions through the engine-free ./tree entry take the same face filter.
    float64 = TreeBVH.build({ positions: Float64Array.from(positions), precision: 'float64' }, { maxLeafTriangles: 1 });
  assert.ok(float64.positions instanceof Float64Array);
  for (const t of [bvh, restored, float64]) {
    const seen = new Set();
    assert.equal(t.intersectsSegment(p, q, { includeFace: (f) => (seen.add(f), f === 1) }), true);
    assert.ok([...seen].every((f) => f === 0 || f === 1));
    assert.equal(t.intersectsSegment(p, q, { includeFace: () => false }), false);
    assert.equal(t.raycastFirst({ origin: p, direction: [0, 0, -1] }, { includeFace: (f) => f !== 0 }).faceIndex, 1);
  }
});

test('segment answers match a brute-force scan on random triangles', () => {
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 4 - 2;
  const positions = Array.from({ length: 60 * 9 }, random),
    bvh = build(positions, { maxLeafTriangles: 2 }),
    brute = MeshBVH.build({ positions: Float32Array.from(positions) }, { maxLeafTriangles: 65536 });
  for (let i = 0; i < 300; i++) {
    const p = [random(), random(), random()],
      q = [random(), random(), random()];
    assert.equal(bvh.intersectsSegment(p, q), brute.intersectsSegment(p, q));
  }
});
