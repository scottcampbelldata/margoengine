import assert from 'node:assert/strict';
import test from 'node:test';
import { PointsMaterial } from '../dist/index.js';
import { OctreeCloud, buildOctree } from '../dist/octree.js';

// A dense 400 x 400 plane at y = 0.5 of a unit cube's worth of world: a scan's surface.
function plane(n = 400) {
  const positions = new Float32Array(n * n * 3);
  for (let i = 0; i < n * n; i++)
    positions.set([((i % n) + 0.5) / n, 0.5, (Math.floor(i / n) + 0.5) / n], i * 3);
  return { positions };
}
function host() {
  const clouds = new Set();
  return { clouds, add: (c) => (clouds.add(c), c), remove: (c) => clouds.delete(c) };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
async function converge(oc, view) {
  for (let i = 0; i < 2000; i++) {
    oc.select(view);
    if (oc.stats.loading === 0) {
      oc.select(view);
      if (oc.stats.loading === 0) return oc.visible;
    }
    await settle();
  }
  throw new Error('did not converge');
}
const cloudOf = (oc, node) => oc['loaded'].get(node).cloud;
const octree = () => buildOctree(plane(), { maxPointsPerNode: 8000, grid: 32 });

test('a coarse node alone grows its points to its own spacing; off by default', async () => {
  const tree = octree(),
    root = tree.root,
    far = { position: [0.5, 0.5, 1000], screenHeight: 800 },
    grown = new OctreeCloud(host(), tree, { adaptiveSize: true, minNodePixels: 1e9 }),
    plain = new OctreeCloud(host(), tree, { minNodePixels: 1e9 });
  await converge(grown, far);
  await converge(plain, far);
  assert.deepEqual(grown.visible, [root]);
  const sizes = cloudOf(grown, root).sizes;
  const spacing = Math.max(root.spacing, (root.bounds[3] - root.bounds[0]) / Math.sqrt(root.count));
  for (const size of sizes) assert.ok(Math.abs(size - 1.5 * spacing) < 1e-6);
  assert.equal(cloudOf(plain, root).sizes, null);
  assert.equal(plain.material.sizeUnits, 'pixels');
});

test('points shrink where children are drawn and stay large in the octants that have none', async () => {
  const tree = octree(),
    root = tree.root,
    h = host(),
    oc = new OctreeCloud(h, tree, { adaptiveSize: { scale: 1 }, minNodePixels: 1e9 }),
    far = { position: [0.5, 0.5, 1000], screenHeight: 800 };
  await converge(oc, far);
  const before = Float32Array.from(cloudOf(oc, root).sizes);
  // Refine only the corner near the camera, with planes that keep x < 0.5.
  oc.minNodePixels = 0.01;
  const view = { ...far, planes: [-1, 0, 0, 0.4, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const nodes = await converge(oc, view);
  assert.ok(nodes.length > 1 && nodes.some((n) => n.parent === root));
  assert.ok(
    nodes.every((n) => n === root || n.bounds[0] < 0.5),
    'children only on the low x side',
  );
  const cloud = cloudOf(oc, root),
    { sizes, positions } = cloud;
  let shrank = 0,
    kept = 0;
  for (let i = 0; i < cloud.count; i++) {
    if (positions[i * 3] >= root.bounds[0] + (root.bounds[3] - root.bounds[0]) / 2) {
      assert.equal(sizes[i], before[i], 'no drawn child here, the size stays');
      kept++;
    } else {
      assert.ok(sizes[i] < before[i], 'a drawn child adds density here');
      shrank++;
    }
  }
  assert.ok(shrank > 0 && kept > 0);
  assert.ok(cloud.dirty.sizes.length > 0, 'the rewrite reaches the GPU');
  // Back to the far view: the children stop drawing and the root's points grow back exactly.
  oc.minNodePixels = 1e9;
  await converge(oc, far);
  assert.deepEqual(cloudOf(oc, root).sizes, before);
});

test('sizes are not rewritten while the drawn nodes stay the same', async () => {
  const tree = octree(),
    oc = new OctreeCloud(host(), tree, { adaptiveSize: true, minNodePixels: 1 }),
    view = { position: [0.5, 0.5, 3], screenHeight: 800 };
  await converge(oc, view);
  for (const node of oc.visible) cloudOf(oc, node).dirty.sizes.length = 0;
  oc.select(view);
  for (const node of oc.visible) assert.equal(cloudOf(oc, node).dirty.sizes.length, 0);
});

test('a jump over more points than one selection sizes finishes on the next selections', async () => {
  const positions = new Float32Array(3 * 1_500_000);
  let s = 7;
  const random = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < positions.length; i += 3) positions.set([random(), 0.5, random()], i);
  const tree = buildOctree({ positions }, { maxPointsPerNode: 300_000, grid: 512 }),
    oc = new OctreeCloud(host(), tree, { adaptiveSize: true, minNodePixels: 1e9, pointBudget: 2_000_000 }),
    view = { position: [0.5, 0.5, 2], screenHeight: 800 };
  await converge(oc, view);
  oc.minNodePixels = 1;
  await converge(oc, view);
  oc.minNodePixels = 1e9;
  oc.select(view);
  oc.minNodePixels = 1;
  await converge(oc, view);
  oc.select(view);
  assert.equal(oc['sizesPending'], false);
  const shown = new Set(oc.visible);
  for (const node of oc.visible) {
    const cloud = cloudOf(oc, node),
      again = Float32Array.from(cloud.sizes);
    oc['sizeNode'](node, cloud, shown);
    assert.deepEqual(cloud.sizes, again, `node ${node.id} sized for the drawn nodes`);
  }
});

test('a pixel size becomes the smallest size, a world size the smallest diameter', async () => {
  const tree = octree(),
    view = { position: [0.5, 0.5, 1000], screenHeight: 800 },
    pixels = new OctreeCloud(host(), tree, { adaptiveSize: true, material: { size: 3 } });
  assert.equal(pixels.material.sizeUnits, 'world');
  assert.equal(pixels.material.size, 1);
  assert.equal(pixels.material.minPixelSize, 3);
  const capped = new OctreeCloud(host(), tree, { adaptiveSize: true, material: { size: 40, maxPixelSize: 8 } });
  assert.equal(capped.material.minPixelSize, 8);
  const world = new OctreeCloud(host(), tree, {
    adaptiveSize: true,
    minNodePixels: 1e9,
    material: { size: 5, sizeUnits: 'world' },
  });
  await converge(world, view);
  assert.ok(cloudOf(world, tree.root).sizes.every((v) => v === 5));
  assert.equal(world.material.minPixelSize, 1);
  for (const scale of [0, -1, Number.NaN, Infinity])
    assert.throws(() => new OctreeCloud(host(), tree, { adaptiveSize: { scale } }), RangeError);
});

test('one material is shared by every node, a given one included', async () => {
  const tree = octree(),
    view = { position: [0.5, 0.5, 3], screenHeight: 800 },
    h = host(),
    material = new PointsMaterial({ size: 3 }),
    oc = new OctreeCloud(h, tree, { material, minNodePixels: 1 });
  await converge(oc, view);
  assert.ok(h.clouds.size > 1);
  for (const cloud of h.clouds) assert.equal(cloud.material, material);
  assert.equal(oc.material, material);
});
