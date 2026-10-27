import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASPRS_CLASSES,
  classificationColors,
  measureAngle,
  measureArea,
  measurePointDistance,
  measureHeight,
  measurePath,
  rampColors,
  rgb16ToRgba8,
} from '../dist/index.js';
import { OctreeCloud, buildOctree } from '../dist/octree.js';

function cloud(n, seed = 5) {
  let s = seed;
  const random = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const positions = new Float32Array(n * 3),
    colors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    positions.set([random() * 1000 - 500, random() * 20, random() * 1000 - 500], i * 3);
    colors.set([i % 256, 100, 200, 255], i * 4);
  }
  return { positions, colors, colorComponents: 4 };
}

test('buildOctree: every point lands in exactly one node; nodes respect their size and sample spacing', () => {
  const data = cloud(60_000),
    octree = buildOctree(data, { maxPointsPerNode: 5000, grid: 32 });
  const seen = new Uint8Array(60_000);
  let total = 0;
  for (const node of octree.nodes()) {
    const index = octree.indices.get(node);
    assert.equal(index.length, node.count);
    total += index.length;
    const b = node.bounds;
    for (const p of index) {
      seen[p]++;
      for (let k = 0; k < 3; k++) {
        const v = data.positions[p * 3 + k];
        assert.ok(v >= b[k] - 1e-3 && v <= b[k + 3] + 1e-3, `point ${p} inside node ${node.id}`);
      }
    }
    // An inner node holds at most one point per grid cell.
    if (node.children.some(Boolean)) assert.ok(index.length <= 32 ** 3);
    else assert.ok(index.length <= 5000 || node.level === 16);
    for (const [o, child] of node.children.entries()) if (child) assert.equal(child.id, node.id + o);
  }
  assert.equal(total, 60_000);
  assert.ok(
    seen.every((v) => v === 1),
    'no point twice, none lost',
  );
  const loaded = octree.load(octree.root);
  assert.equal(loaded.positions.length, octree.root.count * 3);
  assert.equal(loaded.colors.length, octree.root.count * 4);
});

function host() {
  const clouds = new Set();
  return { clouds, add: (c) => (clouds.add(c), c), remove: (c) => clouds.delete(c) };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
async function converge(octreeCloud, view) {
  for (let i = 0; i < 60; i++) {
    octreeCloud.select(view);
    if (octreeCloud.stats.loading === 0) {
      octreeCloud.select(view);
      if (octreeCloud.stats.loading === 0) return octreeCloud.visible;
    }
    await settle();
  }
  throw new Error('did not converge');
}

test('OctreeCloud: refines near the camera, stays under the point budget, and is additive (parents stay drawn)', async () => {
  const octree = buildOctree(cloud(200_000), { maxPointsPerNode: 4000, grid: 16 });
  const h = host(),
    budget = 60_000,
    view = { position: [-450, 30, -450], screenHeight: 800, fov: 60 };
  const oc = new OctreeCloud(h, octree, { pointBudget: budget, minNodePixels: 100 });
  const nodes = await converge(oc, view);
  assert.ok(oc.stats.drawn <= budget, `drawn ${oc.stats.drawn}`);
  const drawn = new Set(nodes);
  for (const node of nodes) if (node.parent) assert.ok(drawn.has(node.parent), 'parents of drawn nodes are drawn');
  const deepNear = nodes
      .filter((n) => n.bounds[0] < -250 && n.bounds[2] < -250)
      .reduce((m, n) => Math.max(m, n.level), 0),
    deepFar = nodes.filter((n) => n.bounds[3] > 250 && n.bounds[5] > 250).reduce((m, n) => Math.max(m, n.level), 0);
  assert.ok(deepNear > deepFar, `more detail near the camera (${deepNear}) than far (${deepFar})`);
  assert.equal([...h.clouds].filter((c) => c.visible).length, nodes.length);
  // Moving to the other corner refines there; memory stays within maxLoadedPoints.
  const far = await converge(oc, { ...view, position: [450, 30, 450] });
  assert.ok(far.some((n) => n.bounds[0] >= 0 && n.level >= deepNear - 1));
  assert.ok(oc.stats.loaded <= oc.maxLoadedPoints + 4000 * 4);
  oc.dispose();
  assert.equal(h.clouds.size, 0);
  assert.throws(
    () => oc.select(view),
    (e) => e.code === 'disposed',
  );
});

test('OctreeCloud: a failing node is reported and skipped; retry() loads it again', async () => {
  const octree = buildOctree(cloud(20_000), { maxPointsPerNode: 2000, grid: 8 });
  let broken = true;
  const source = {
    root: octree.root,
    load: (node) => (broken && node.level === 1 ? Promise.reject(new Error('offline')) : octree.load(node)),
  };
  const errors = [],
    oc = new OctreeCloud(host(), source, { minNodePixels: 1 });
  oc.onError((node, error) => errors.push([node.id, error.message]));
  await converge(oc, { position: [0, 30, 0], screenHeight: 800 });
  assert.ok(errors.length > 0 && errors.every(([id, m]) => id.length === 2 && m === 'offline'));
  assert.ok(oc.visible.every((n) => n.level === 0));
  broken = false;
  oc.retry();
  const nodes = await converge(oc, { position: [0, 30, 0], screenHeight: 800 });
  assert.ok(nodes.some((n) => n.level >= 1));
});

test('colours: ASPRS classes, ramps, 16-bit RGB; measures: distance, path, area, height, angle', () => {
  assert.equal(ASPRS_CLASSES[2], 'Ground');
  const c = classificationColors([2, 6, 99], { hidden: [6], palette: { 99: [1, 2, 3] } });
  assert.deepEqual([...c.slice(8, 12)], [1, 2, 3, 255]);
  assert.equal(c[7], 0, 'hidden class has alpha 0');
  const r = rampColors([0, 50, 100, Number.NaN], { min: 0, max: 100 });
  assert.deepEqual([...r.slice(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...r.slice(4, 7)], [128, 128, 128]);
  assert.equal(r[15], 0);
  assert.deepEqual([...rgb16ToRgba8([65535, 256, 0])], [255, 1, 0, 255]);
  assert.deepEqual([...rgb16ToRgba8([200, 100, 0])], [200, 100, 0, 255], '8-bit values in 16-bit fields');
  assert.equal(measurePointDistance([0, 0, 0], [3, 4, 0]), 5);
  assert.equal(
    measurePath(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      true,
    ),
    2 + Math.SQRT2,
  );
  assert.equal(
    measureArea([
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 3],
      [0, 0, 3],
    ]),
    6,
  );
  assert.equal(measureHeight([0, 1, 0], [5, 4, 2]), 3);
  assert.ok(Math.abs(measureAngle([1, 0, 0], [0, 0, 0], [0, 0, 1]) - 90) < 1e-12);
});
