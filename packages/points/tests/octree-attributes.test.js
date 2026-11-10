import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOctree } from '@margoengine/points/octree';

test('every node preserves scalar and vector attributes, typed precision and original row identity', () => {
  const n = 200,
    positions = Float32Array.from({ length: n * 3 }, (_, i) => Math.sin(i));
  const intensity = Uint16Array.from({ length: n }, (_, i) => i * 300);
  const gps = Float64Array.from({ length: n * 2 }, (_, i) => 1e10 + i / 16);
  const tree = buildOctree(
    { positions, attributes: { intensity, gps }, rowIds: Array.from({ length: n }, (_, i) => `row-${i}`) },
    { grid: 2, maxPointsPerNode: 10 },
  );
  const seen = new Set();
  for (const node of tree.nodes()) {
    const data = tree.load(node),
      indices = tree.indices.get(node);
    assert(data.attributes.intensity instanceof Uint16Array);
    assert(data.attributes.gps instanceof Float64Array);
    for (let i = 0; i < indices.length; i++) {
      const original = indices[i];
      seen.add(original);
      assert.equal(data.attributes.intensity[i], intensity[original]);
      assert.equal(data.attributes.gps[i * 2 + 1], gps[original * 2 + 1]);
      assert.equal(data.rowIds[i], `row-${original}`);
    }
  }
  assert.equal(seen.size, n);
  assert.throws(() => buildOctree({ positions, attributes: { bad: new Float32Array(3) } }), /components/);
  assert.throws(() => buildOctree({ positions, rowIds: [1] }), /rowIds/);
  const plain = buildOctree({ positions });
  assert.deepEqual(plain.load(plain.root).rowIds, plain.indices.get(plain.root));
});
