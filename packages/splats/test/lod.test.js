import test from 'node:test';
import assert from 'node:assert/strict';
import { Splats } from '../dist/index.js';
import { buildSplatLod, chooseSplatNodes, SplatLod } from '../dist/lod.js';

// A side x side sheet of small splats on y = 0, 0.1 apart (25,600 by default).
function sheet(side = 160) {
  const n = side * side,
    positions = new Float32Array(n * 3),
    covariances = new Float32Array(n * 6),
    colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    positions.set([(i % side) * 0.1, 0, Math.floor(i / side) * 0.1], i * 3);
    covariances.set([0.001, 0, 0, 0.0001, 0, 0.001], i * 6);
    colors.set([(i % 7) / 7, 0.5, 0.25, 0.9], i * 4);
  }
  return { positions, covariances, colors };
}
const key = (p, i) => `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('buildSplatLod: leaves keep every splat once, every node fits leafSize, inner nodes cover their children', async () => {
  const data = sheet(),
    source = buildSplatLod(data, { leafSize: 1024 }),
    { nodes } = source,
    signal = new AbortController().signal;
  assert.equal(source.coefficients, 0);
  assert.ok(nodes.length > 25, `${nodes.length} nodes`);
  const leaves = [];
  for (const [i, n] of nodes.entries()) {
    assert.ok(n.count >= 1 && n.count <= 1024, `node ${i}: ${n.count}`);
    assert.ok(n.children.every((c) => c > i));
    if (!n.children.length) {
      assert.equal(n.error, 0);
      leaves.push(i);
    } else {
      assert.ok(n.error > 0, `inner node ${i} has an error`);
      // Float32 positions against float64 spheres: allow rounding of the largest coordinate (16 x 2^-24 < 1e-5).
      for (const c of n.children)
        assert.ok(gap(nodes[c].center, n.center) + nodes[c].radius <= n.radius + 1e-5, `node ${i} contains child ${c}`);
    }
    const cloud = await source.load(i, signal);
    assert.equal(cloud.positions.length / 3, n.count);
    for (let s = 0; s < n.count; s++)
      assert.ok(gap(cloud.positions.subarray(s * 3), n.center) <= n.radius + 1e-5, `node ${i} contains its splat ${s}`);
  }
  const seen = new Map();
  for (let s = 0; s < data.positions.length / 3; s++) seen.set(key(data.positions, s), 0);
  for (const i of leaves) {
    const cloud = await source.load(i, signal);
    for (let s = 0; s < cloud.positions.length / 3; s++) {
      const k = key(cloud.positions, s);
      assert.ok(seen.has(k), 'a leaf splat is a capture splat');
      seen.set(k, seen.get(k) + 1);
    }
  }
  assert.ok([...seen.values()].every((v) => v === 1), 'each capture splat is in exactly one leaf');
  await assert.rejects(source.load(0, AbortSignal.abort()));
  assert.throws(() => buildSplatLod(data, { leafSize: 10 }), RangeError);
});

test('chooseSplatNodes refines by projected error, within the budget, only into loaded children', () => {
  const { nodes } = buildSplatLod(sheet(), { leafSize: 1024 }),
    all = () => true,
    view = (eye) => ({ eye, focal: 500, near: 0.05 }),
    leafTotal = nodes.reduce((s, n) => s + (n.children.length ? 0 : n.count), 0);
  // Far away the root's error is under 2 px: the root alone.
  assert.deepEqual(chooseSplatNodes(nodes, view([8, 1e5, 8]), { maxError: 2, budget: 1e9, loaded: all }).selected, [0]);
  // maxError 0 refines to every leaf.
  const full = chooseSplatNodes(nodes, view([8, 1, 8]), { maxError: 0, budget: 1e9, loaded: all });
  assert.ok(full.selected.every((i) => !nodes[i].children.length));
  assert.equal(full.selected.reduce((s, i) => s + nodes[i].count, 0), leafTotal);
  // Close to one corner (8 px allowed), nodes near it refine further than far ones.
  const near = chooseSplatNodes(nodes, view([0, 0.5, 0]), { maxError: 8, budget: 1e9, loaded: all }),
    distance = (i) => Math.hypot(nodes[i].center[0], nodes[i].center[2]),
    deep = near.selected.filter((i) => !nodes[i].children.length),
    shallow = near.selected.filter((i) => nodes[i].children.length);
  assert.ok(deep.length && shallow.length, 'a mixed cut');
  assert.ok(Math.min(...deep.map(distance)) < Math.min(...shallow.map(distance)), 'leaves are nearer than inner nodes');
  // A budget stops refining before it is exceeded.
  for (const budget of [1024, 3000, 8000]) {
    const cut = chooseSplatNodes(nodes, view([0, 0.5, 0]), { maxError: 0, budget, loaded: all });
    assert.ok(cut.selected.reduce((s, i) => s + nodes[i].count, 0) <= Math.max(budget, nodes[0].count));
  }
  // Unloaded children keep the parent and are asked for; an unloaded root is asked for first.
  assert.deepEqual(chooseSplatNodes(nodes, view([0, 0.5, 0]), { maxError: 0, budget: 1e9, loaded: () => false }), {
    selected: [],
    wanted: [0],
  });
  const rootOnly = chooseSplatNodes(nodes, view([0, 0.5, 0]), { maxError: 0, budget: 1e9, loaded: (i) => i === 0 });
  assert.deepEqual(rootOnly.selected, [0]);
  assert.deepEqual(rootOnly.wanted, nodes[0].children);
});

test('chooseSplatNodes walks a hierarchy far past 3,000,000 splats without its data', () => {
  // 4,096 leaves of 65,536 splats (268,435,456) under inner nodes of 16,384: nodes only, as a streamed source lists them.
  const nodes = [];
  const make = (x0, z0, size, level) => {
    const at = nodes.length;
    nodes.push(undefined);
    const children = [];
    if (level < 3)
      for (let a = 0; a < 4; a++)
        for (let b = 0; b < 4; b++) children.push(make(x0 + (a * size) / 4, z0 + (b * size) / 4, size / 4, level + 1));
    nodes[at] = { center: [x0 + size / 2, 0, z0 + size / 2], radius: size * 0.71, error: level < 3 ? size / 64 : 0, count: level < 3 ? 16384 : 65536, children };
    return at;
  };
  make(0, 0, 4096, 0);
  const cut = chooseSplatNodes(nodes, { eye: [10, 2, 10], focal: 800, near: 0.05 }, { maxError: 1, budget: 3_000_000, loaded: () => true }),
    drawn = cut.selected.reduce((s, i) => s + nodes[i].count, 0);
  assert.ok(drawn <= 3_000_000 && drawn > 65536, `${drawn} splats drawn of ${4096 * 65536}`);
  assert.ok(cut.selected.some((i) => !nodes[i].children.length), 'leaves by the camera');
});

test('SplatLod checks its source and options; Splats.reserve, write and clear check their ranges', () => {
  const source = buildSplatLod(sheet(40), { leafSize: 256 });
  assert.throws(() => new SplatLod({}), TypeError);
  assert.throws(() => new SplatLod({ ...source, coefficients: 3 }), RangeError);
  assert.throws(() => new SplatLod(source, { budget: 100 }), RangeError, 'under the largest node');
  assert.throws(() => new SplatLod(source, { maxError: -1 }), RangeError);
  assert.throws(() => new SplatLod({ ...source, nodes: [{ ...source.nodes[0], children: [0] }] }), RangeError);
  const lod = new SplatLod(source, { budget: 1000 }),
    slot = Math.max(...source.nodes.map((n) => n.count));
  assert.equal(lod.cloud.count, Math.floor(1000 / slot) * slot, 'whole slots of the largest node');
  assert.deepEqual(lod.selected, []);
  lod.dispose();
  // Regression: the pool was the whole budget even for a small source, so a 1,000,000 budget of degree-3 SH for the
  // 8,385-splat raccoon went past a Radeon 680M's storage limit. A cut holds at most one node per leaf.
  const big = new SplatLod(source, { budget: 1_000_000 }),
    leaves = source.nodes.filter((n) => !n.children.length).length;
  assert.equal(big.cloud.count, leaves * slot, 'no more slots than leaves');
  big.dispose();
  const pool = Splats.reserve(10, 4);
  assert.equal(pool.count, 10);
  assert.equal(pool.coefficients, 4);
  assert.throws(() => Splats.reserve(0), RangeError);
  assert.throws(() => Splats.reserve(5, 3), RangeError);
  const one = { positions: new Float32Array(3), covariances: new Float32Array([1, 0, 0, 1, 0, 1]), colors: new Float32Array([1, 1, 1, 1]) };
  assert.throws(() => pool.write(0, one), RangeError, 'SH count must match');
  const plain = Splats.reserve(3);
  plain.write(2, one).clear(0, 3);
  assert.throws(() => plain.write(3, one), RangeError);
  assert.throws(() => plain.clear(2, 2), RangeError);
  assert.throws(() => plain.write(-1, one), RangeError);
  plain.dispose();
  assert.throws(() => plain.clear(0, 1), { code: 'disposed' });
});
