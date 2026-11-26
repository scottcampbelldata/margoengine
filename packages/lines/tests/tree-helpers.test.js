import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBVH } from '../../bvh/dist/index.js';
import { buildOctree } from '../../points/dist/octree.js';
import { BVHHelper, OctreeHelper, RaycasterHelper } from '../dist/tree-helpers.js';

// Spatial query helpers: box edges of a tree down to a depth, and a ray with its hits.

// 200 small triangles scattered through the unit cube.
const soup = new Float32Array(200 * 9).map((_, i) => ((i * 7919 + (i % 9) * 131) % 1000) / 1000);
const boxes = (line) => line.count / 24;
const points = (line) => Array.from(line.points).filter((_, i) => i % 4 !== 3);

test('BVHHelper draws one box per node at the depth, plus the leaves above it', () => {
  const bvh = MeshBVH.build({ positions: soup }, { maxLeafTriangles: 4 }),
    helper = new BVHHelper(bvh, { depth: 0 });
  assert.equal(boxes(helper), 1, 'depth 0 is the root');
  const { min, max } = bvh.getBoundingBox(),
    corner = points(helper);
  assert.deepEqual(
    [Math.min(...corner.filter((_, i) => i % 3 === 0)), Math.max(...corner.filter((_, i) => i % 3 === 0))],
    [min[0], max[0]],
  );
  assert.ok(helper.maxDepth >= 4);
  helper.setDepth(2);
  assert.ok(boxes(helper) >= 2 && boxes(helper) <= 4, `level 2 has up to 4 boxes, got ${boxes(helper)}`);
  helper.setDepth(64);
  let leaves = 0;
  for (let n = 0; n < bvh.nodeCount; n++) if (bvh.isLeaf(n)) leaves++;
  assert.equal(boxes(helper), leaves, 'past the deepest level every leaf is drawn');
  assert.throws(() => helper.setDepth(-1), /depth/);
  assert.throws(() => new BVHHelper({ nodeBounds: new Float32Array(), nodeData: new Uint32Array() }), /BVH shape/);
});

test('OctreeHelper draws the cube of every node at the depth and the leaves above it', () => {
  const positions = new Float32Array(3 * 2000);
  for (let i = 0; i < positions.length; i++) positions[i] = ((i * 7919) % 1000) / 1000;
  const octree = buildOctree({ positions }, { maxPointsPerNode: 200, grid: 4 }),
    helper = new OctreeHelper(octree, { depth: 0 });
  assert.equal(boxes(helper), 1);
  assert.ok(helper.maxDepth >= 1);
  helper.setDepth(1);
  const kids = octree.root.children.filter(Boolean).length;
  assert.ok(boxes(helper) >= kids, 'every level 1 node is drawn');
  helper.setDepth(64);
  assert.ok(boxes(helper) > kids);
  assert.throws(() => new OctreeHelper({}), /Invalid octree/);
});

test('RaycasterHelper draws the ray to the farthest hit with a cross and a normal tick on each', () => {
  const helper = new RaycasterHelper(
    { origin: [0, 0, 0], direction: [0, 0, -1], far: 100 },
    [{ point: [0, 0, -2], normal: [0, 1, 0] }, { point: [0, 0, -5] }],
    { markSize: 0.5 },
  );
  // Ray (1 segment) + 2 crosses (3 segments each) + 1 normal tick.
  assert.equal(helper.count, 2 * (1 + 6 + 1));
  const p = points(helper);
  assert.deepEqual(p.slice(0, 6), [0, 0, 0, 0, 0, -5]);
  helper.set({ origin: [0, 0, 0], direction: [1, 0, 0] });
  assert.deepEqual(points(helper).slice(3, 6), [10, 0, 0], 'no hit and far Infinity: the default length');
  assert.throws(() => helper.set({ origin: [0, 0], direction: [1, 0, 0] }), /ray origin/);
});

test('a cyclic or shared BVH layout throws instead of hanging', () => {
  const bounds = new Float32Array(8 * 3),
    cyclic = new Uint32Array(8 * 3);
  cyclic[7] = 0x80000000;
  cyclic[6] = 2;
  cyclic[8 + 7] = 0x80000000;
  cyclic[8 + 6] = 0; // Points back at the root.
  assert.throws(() => new BVHHelper({ nodeBounds: bounds, nodeData: cyclic }), /Invalid BVH node links/);
  const shared = new Uint32Array(8 * 3);
  shared[7] = 0x80000000;
  shared[6] = 1; // Right child equal to the left child.
  assert.throws(() => new BVHHelper({ nodeBounds: bounds, nodeData: shared }), /Invalid BVH node links/);
});

test('a cyclic or shared octree throws instead of hanging', () => {
  const bounds = [0, 0, 0, 1, 1, 1],
    root = { bounds, children: [] },
    child = { bounds, children: [root] };
  root.children.push(child);
  assert.throws(() => new OctreeHelper(root), /Invalid octree/);
  const leaf = { bounds, children: [] };
  assert.throws(() => new OctreeHelper({ bounds, children: [leaf, leaf] }), /Invalid octree/);
});
