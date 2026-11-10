import test from 'node:test';
import assert from 'node:assert/strict';
import { meshTree, generateParametricTree, meshTreeLODs } from '../dist/tree-mesh.js';
import { createTreeGenerator } from '../dist/trees.js';

function geometry(g) {
  assert.ok(g.positions.every(Number.isFinite));
  assert.ok(g.uvs.every(Number.isFinite));
  const n = g.positions.length / 3;
  assert.equal(g.normals.length, n * 3);
  assert.equal(g.tangents.length, n * 4);
  assert.equal(g.uvs.length, n * 2);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(Math.hypot(...g.normals.slice(i * 3, i * 3 + 3)) - 1) < 1e-5);
    assert.ok(Math.abs(Math.hypot(...g.tangents.slice(i * 4, i * 4 + 3)) - 1) < 1e-5);
    assert.ok(Math.abs(g.normals.slice(i * 3, i * 3 + 3).reduce((s, x, k) => s + x * g.tangents[i * 4 + k], 0)) < 1e-5);
  }
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = g.indices.slice(i, i + 3);
    assert.ok(Math.max(a, b, c) < n);
    const ab = [0, 1, 2].map((k) => g.positions[b * 3 + k] - g.positions[a * 3 + k]),
      ac = [0, 1, 2].map((k) => g.positions[c * 3 + k] - g.positions[a * 3 + k]);
    const face = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    assert.ok(Math.hypot(...face) > 1e-14, 'no degenerate triangles');
    assert.ok(
      face.reduce((s, x, k) => s + x * (g.normals[a * 3 + k] + g.normals[b * 3 + k] + g.normals[c * 3 + k]), 0) > 0,
      'outward winding agrees with normals',
    );
  }
}
const straight = {
  positions: new Float64Array([0, 0, 0, 0, 1, 0, 0, 2, 0]),
  parents: new Int32Array([-1, 0, 1]),
  radii: new Float64Array([0.3, 0.2, 0.1]),
};
test('tapered analytical cone normals, UV seam and arc length', () => {
  const tree = meshTree(straight, {
    branch: { segments: { 0: 8 } },
    leaves: { count: 0 },
    bark: { textureScale: [2, 3] },
  });
  geometry(tree.bark);
  assert.equal(tree.leaves.indices.length, 0);
  assert.deepEqual([...tree.radii], [0.3, 0.2, 0.1]);
  assert.deepEqual([...tree.bark.positions.slice(0, 3)], [...tree.bark.positions.slice(24, 27)]);
  assert.equal(tree.bark.uvs[16], 2);
  assert.equal(Math.max(...tree.bark.uvs.filter((_, i) => i % 2)), 6);
  const expected = 1 / Math.sqrt(1.01);
  assert.ok(Math.abs(tree.bark.normals[0] - expected) < 1e-6);
  assert.ok(Math.abs(tree.bark.normals[1] - expected * 0.1) < 1e-6);
});
test('seeded species, cards/clusters, atlases and flat bark', () => {
  for (const species of ['oak', 'ash', 'aspen', 'birch', 'pine', 'spruce', 'willow']) {
    const options = {
      species,
      seed: 19,
      branch: { levels: 1, children: { 0: 3 } },
      leaves: { count: 4, billboard: 'cluster' },
    };
    const a = generateParametricTree(options),
      b = generateParametricTree(options);
    assert.deepEqual(a, b);
    geometry(a.bark);
    geometry(a.leaves);
    assert.ok(a.materials.leaves.atlas.data.some((x, i) => i % 4 === 3 && x === 0));
    assert.ok(a.materials.leaves.atlas.data.some((x, i) => i % 4 === 3 && x === 255));
    assert.equal(a.materials.bark.atlas.data.length, 64 * 64 * 4);
  }
  geometry(generateParametricTree({ bark: { flatShading: true } }).bark);
  const a = meshTree(straight, { leaves: { billboard: 'single', count: 8 } }),
    b = meshTree(straight, { leaves: { billboard: 'double', count: 8 } });
  assert.equal(b.leaves.indices.length, a.leaves.indices.length * 2);
});
test('space-colonisation interoperability, pipe radii and LOD preserve endpoints', async () => {
  using generator = await createTreeGenerator();
  const skeleton = generator.generate({ seed: 7, attractionCount: 32, maxNodes: 128, maxIterations: 16 });
  const snapshot = skeleton.positions.slice();
  const lods = meshTreeLODs(skeleton);
  assert.deepEqual(skeleton.positions, snapshot);
  for (const { mesh } of lods) {
    geometry(mesh.bark);
    geometry(mesh.leaves);
    assert.ok(mesh.radii.every((x) => x > 0));
  }
  assert.ok(lods[1].mesh.bark.indices.length < lods[0].mesh.bark.indices.length);
  assert.ok(lods[2].mesh.leaves.indices.length < lods[0].mesh.leaves.indices.length);
  assert.deepEqual(lods[2].mesh.radii, lods[0].mesh.radii);
  assert.ok(lods[0].mesh.radii.at(-1) < lods[0].mesh.radii[0]);
});
test('all architecture fields affect the intended output', () => {
  const base = generateParametricTree();
  for (const branch of [
    { angle: { 1: 80 } },
    { children: { 0: 4 } },
    { force: { direction: [1, 0, 0], strength: 0.5 } },
    { gnarliness: { 0: 1 } },
    { length: { 0: 12 } },
    { radius: { 0: 0.5 } },
    { sections: { 0: 20 } },
    { segments: { 0: 20 } },
    { start: { 0: 0.8 } },
    { taper: { 0: 0.1 } },
    { twist: { 0: 50 } },
  ]) {
    const a = generateParametricTree({ branch });
    assert.notDeepEqual(a.bark.positions, base.bark.positions, JSON.stringify(branch));
  }
  const a = meshTree(straight, { seed: 1 }),
    b = meshTree(straight, { seed: 2 });
  assert.notDeepEqual(a.leaves.positions, b.leaves.positions);
});
test('reject malformed skeleton, settings, budgets and cancellation', () => {
  const root = meshTree({ positions: new Float64Array([0, 0, 0]), parents: new Int32Array([-1]) });
  assert.equal(root.bark.indices.length, 0);
  assert.equal(root.leaves.indices.length, 0);
  for (const input of [
    { ...straight, parents: new Int32Array([-1, 2, 1]) },
    { ...straight, positions: new Float64Array([0, 0, 0, 0, 0, 0, 0, 1, 0]) },
    { ...straight, radii: new Float64Array([1, NaN, 1]) },
  ])
    assert.throws(() => meshTree(input));
  for (const options of [
    { seed: -1 },
    { species: 'unknown' },
    { branch: { sections: { 0: 0 } } },
    { leaves: { count: 257 } },
    { detail: { leafStride: 0 } },
    { bark: { textureScale: [1, 0] } },
    { branch: { levels: 4, children: { 0: 64, 1: 64, 2: 64 } } },
  ])
    assert.throws(() => generateParametricTree(options));
  const signal = AbortSignal.abort('stop');
  assert.throws(
    () => meshTree(straight, { signal }),
    (e) => e === 'stop',
  );
  assert.throws(() => meshTreeLODs(straight, {}, [{ distance: 1 }]));
});
