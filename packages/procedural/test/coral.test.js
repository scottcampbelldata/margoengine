import test from 'node:test';
import assert from 'node:assert/strict';
import { coralGeometry } from '../dist/coral.js';

function checkGeometry(mesh) {
  const { positions, normals, indices, uvs } = mesh;
  const edges = new Map();
  const parent = positions.filter((_, i) => i % 3 === 0).map((_, i) => i);
  function root(i) {
    while (parent[i] !== i) i = parent[i];
    return i;
  }
  for (let i = 0; i < indices.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = indices[i + j],
        b = indices[i + ((j + 1) % 3)];
      assert.notEqual(a, b);
      const edge = Math.min(a, b) * parent.length + Math.max(a, b);
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
      parent[root(b)] = root(a);
    }
  }
  assert.ok(indices.length > 1500);
  assert.ok(
    [...edges.values()].every((count) => count === 2),
    'closed manifold',
  );
  assert.equal(parent.filter((_, i) => root(i) === i).length, 1, 'one attached colony');
  assert.ok(uvs.every(Number.isFinite));
  let minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minY = Math.min(minY, positions[i + 1]);
    maxY = Math.max(maxY, positions[i + 1]);
    assert.ok(Math.abs(Math.hypot(normals[i], normals[i + 1], normals[i + 2]) - 1) < 1e-5);
  }
  assert.ok(Math.abs(minY) < 1e-6);
  return maxY;
}

test('coral forms produce closed Y-up meshes with distinct silhouettes', () => {
  const branching = checkGeometry(coralGeometry({ form: 'branching', resolution: 76 }));
  const table = checkGeometry(coralGeometry({ form: 'table', resolution: 76 }));
  const brain = checkGeometry(coralGeometry({ form: 'brain', resolution: 76 }));
  assert.ok(branching > table + 0.07);
  assert.ok(brain > 0.35 && brain < 0.45);
});

test('seeded colonies reproduce and respect metre scale', () => {
  const options = { seed: 15, form: 'brain', resolution: 48 };
  const a = coralGeometry(options),
    b = coralGeometry({ ...options, diameter: 2 });
  assert.deepEqual(a, coralGeometry(options));
  assert.deepEqual(b.indices, a.indices);
  assert.ok(b.positions.every((value, i) => value === a.positions[i] * 2));
  assert.notDeepEqual(a.positions, coralGeometry({ ...options, seed: 16 }).positions);
  assert.throws(() => coralGeometry({ resolution: 129 }), RangeError);
});
