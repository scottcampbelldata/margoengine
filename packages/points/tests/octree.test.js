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
  for (let i = 0; i < 400; i++) {
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

const multiply = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
/** Rotation about y, a uniform scale and a move, as a column-major matrix, with its inverse. */
function placed(angle, scale, [tx, ty, tz]) {
  const c = Math.cos(angle) * scale,
    s = Math.sin(angle) * scale,
    matrix = [c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, tx, ty, tz, 1],
    q = 1 / (scale * scale),
    r = [c * q, 0, s * q, 0, 0, scale * q, 0, 0, -s * q, 0, c * q, 0];
  const t = multiply([...r, 0, 0, 0, 1], tx, ty, tz);
  r.push(-t[0], -t[1], -t[2], 1);
  return { matrix, inverse: r };
}
/** Half-spaces of a box around a world point, as `planes` takes them. */
function boxPlanes([x, y, z], h) {
  return [1, 0, 0, h - x, -1, 0, 0, h + x, 0, 1, 0, h - y, 0, -1, 0, h + y, 0, 0, 1, h - z, 0, 0, -1, h + z];
}

test('OctreeCloud under a transform selects the nodes the same camera sees of the moved cloud', async () => {
  const tree = buildOctree(cloud(50_000), { maxPointsPerNode: 3000, grid: 16 });
  for (const [angle, scale, move] of [
    [0.7, 1, [2000, 0, -900]],
    [2.1, 0.25, [-300, 40, 800]],
    [-1.3, 3, [0, -500, 0]],
  ]) {
    const { matrix, inverse } = placed(angle, scale, move),
      world = multiply(matrix, -300, 10, -200),
      moved = new OctreeCloud(host(), tree, { minNodePixels: 80 }),
      still = new OctreeCloud(host(), tree, { minNodePixels: 80 });
    moved.matrix.set(matrix);
    const eye = multiply(matrix, -450, 300, -450),
      a = await converge(moved, { position: eye, screenHeight: 800, planes: boxPlanes(world, 260 * scale) }),
      // The same view, carried into the cloud's own coordinates by hand.
      local = multiply(inverse, ...world);
    assert.ok(Math.hypot(local[0] + 300, local[1] - 10, local[2] + 200) < 1e-6, 'the inverse is right');
    const corner = (i, sign) => {
        const p = [...world];
        p[i] += sign * 260 * scale;
        return multiply(inverse, ...p);
      },
      planes = [];
    for (let i = 0; i < 3; i++)
      for (const sign of [1, -1]) {
        const onFace = corner(i, sign),
          n = [matrix[i], matrix[i + 4], matrix[i + 8]].map((v) => -sign * v);
        planes.push(...n, -(n[0] * onFace[0] + n[1] * onFace[1] + n[2] * onFace[2]));
      }
    const b = await converge(still, { position: [-450, 300, -450], screenHeight: 800, planes });
    assert.deepEqual(a.map((n) => n.id).sort(), b.map((n) => n.id).sort());
    assert.ok(a.length > 1 && a.length < [...tree.nodes()].length, `a part of the tree: ${a.length}`);
    moved.dispose();
    still.dispose();
  }
});

test('OctreeCloud: moving the cloud away and back drops and returns its nodes; every node shares the matrix', async () => {
  const tree = buildOctree(cloud(30_000), { maxPointsPerNode: 3000, grid: 16 }),
    h = host(),
    oc = new OctreeCloud(h, tree, { minNodePixels: 50 }),
    view = { position: [0, 300, 900], screenHeight: 800, planes: boxPlanes([0, 0, 0], 600) },
    here = await converge(oc, view);
  assert.ok(here.length > 1);
  for (const c of h.clouds) assert.equal(c.matrix, oc.matrix);
  oc.matrix[12] = 5000;
  assert.deepEqual(await converge(oc, view), []);
  assert.ok([...h.clouds].every((c) => !c.visible));
  oc.matrix[12] = 0;
  assert.deepEqual((await converge(oc, view)).map((n) => n.id).sort(), here.map((n) => n.id).sort());
});

test('OctreeCloud: refinement follows the camera distance in world units, not local ones', async () => {
  const tree = buildOctree(cloud(50_000), { maxPointsPerNode: 3000, grid: 16 }),
    view = { position: [0, 0, 1500], screenHeight: 800 },
    big = new OctreeCloud(host(), tree, { minNodePixels: 100 }),
    small = new OctreeCloud(host(), tree, { minNodePixels: 100 });
  big.matrix[0] = big.matrix[5] = big.matrix[10] = 2;
  small.matrix[0] = small.matrix[5] = small.matrix[10] = 0.1;
  const a = await converge(big, view),
    b = await converge(small, view);
  assert.ok(a.length > b.length, `a larger cloud refines further: ${a.length} against ${b.length}`);
});

test('adaptive size follows the transform through the material; the sizes stay', async () => {
  const tree = buildOctree(cloud(30_000), { maxPointsPerNode: 3000, grid: 16 }),
    h = host(),
    oc = new OctreeCloud(h, tree, { adaptiveSize: true, minNodePixels: 1e9 }),
    view = { position: [0, 0, 900], screenHeight: 800 };
  await converge(oc, view);
  const [root] = h.clouds,
    before = Float32Array.from(root.sizes);
  root.dirty.sizes.length = 0;
  oc.matrix[0] = oc.matrix[5] = oc.matrix[10] = 4;
  oc.select(view);
  assert.equal(oc.material.size, 4);
  assert.deepEqual(root.sizes, before);
  assert.equal(root.dirty.sizes.length, 0, 'scaling rewrites no point');
});

test('PointCloud takes a shared matrix and refuses a wrong one', async () => {
  const { PointCloud } = await import('../dist/index.js'),
    matrix = new Float32Array(16),
    positions = [0, 0, 0];
  assert.equal(new PointCloud({ positions, matrix }).matrix, matrix);
  assert.throws(() => new PointCloud({ positions, matrix: new Float32Array(3) }), TypeError);
  assert.throws(() => new PointCloud({ positions, matrix: [1] }), TypeError);
});
