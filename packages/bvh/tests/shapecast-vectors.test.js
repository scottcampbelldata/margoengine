// MeshBVH.shapecast replayed against the recorded traces in bvh-shapecast.json: every callback call must arrive in
// the recorded order with the recorded arguments; each callback then returns the recorded result.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CONTAINED, INTERSECTED, MeshBVH, NOT_INTERSECTED } from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('./bvh-shapecast.json', import.meta.url), 'utf8'));

// The seven-node tree described by vectors.fourLeafTree, built by hand so the traversal does not depend on the builder.
function fourLeafTree() {
  const positions = new Float32Array(36);
  for (let face = 0; face < 4; face++)
    positions.set([face * 2 - 3, 0, 0, face * 2 - 2.5, 0, 0, face * 2 - 3, 1, 0], face * 9);
  const nodes = new ArrayBuffer(7 * 32),
    bounds = new Float32Array(nodes),
    data = new Uint32Array(nodes);
  for (const [node, face] of [
    [2, 0],
    [3, 1],
    [5, 2],
    [6, 3],
  ]) {
    const x = positions[face * 9];
    bounds.set([x, 0, 0, x + 0.5, 1, 0], node * 8);
    data[node * 8 + 6] = face;
    data[node * 8 + 7] = 1;
  }
  for (const [node, left, right] of [
    [4, 5, 6],
    [1, 2, 3],
    [0, 1, 4],
  ]) {
    bounds.set([bounds[left * 8], 0, 0, bounds[right * 8 + 3], 1, 0], node * 8);
    data[node * 8 + 6] = right;
    data[node * 8 + 7] = 0x80000000;
  }
  return new MeshBVH(
    { nodes, index: Uint32Array.from({ length: 12 }, (_, i) => i), triangles: new Uint32Array([0, 1, 2, 3]) },
    { positions },
  );
}

// grid(6) of vectors.gridMesh: vertices (i, sin(i + j) / 4, j), cells row by row in j, triangles (a, c, b), (b, c, d).
function gridMesh(n = 6) {
  const positions = new Float32Array((n + 1) * (n + 1) * 3),
    indices = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) positions.set([i, Math.sin(i + j) / 4, j], (j * (n + 1) + i) * 3);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i,
        b = a + 1,
        c = a + n + 1,
        d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  return MeshBVH.build({ positions, indices: new Uint32Array(indices) });
}

const decode = (s) => {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'undefined') return undefined;
  if (s === 'null') return null;
  if (s !== '' && !Number.isNaN(Number(s))) return Number(s);
  return s;
};
const scoreOf = (s) => (s === null ? Number.NaN : s);

// Callbacks that check each call against the next recorded event and return its recorded result.
function replay(events) {
  let at = 0;
  const next = (kind) => {
    assert.ok(at < events.length, `unexpected extra ${kind} call`);
    const event = events[at++];
    assert.equal(event[0], kind, `event ${at - 1}`);
    return event;
  };
  const has = (kind) => events.some((e) => e[0] === kind);
  const callbacks = {
    intersectsBounds(box, isLeaf, score, depth, node) {
      const e = next('bounds');
      assert.deepEqual([node, isLeaf, score === undefined ? 'undefined' : score, depth], e.slice(1, 5));
      return decode(e[5]);
    },
  };
  if (has('order'))
    callbacks.boundsTraverseOrder = (box) => {
      const e = next('order');
      assert.deepEqual([...box.min, ...box.max], e[1]);
      return scoreOf(e[2]);
    };
  if (has('range'))
    callbacks.intersectsRange = (offset, count, contained, depth, node) => {
      const e = next('range');
      assert.deepEqual([offset, count, contained, depth, node], e.slice(1, 6));
      return decode(e[6]);
    };
  if (has('triangle'))
    callbacks.intersectsTriangle = (tri, face, contained, depth) => {
      const e = next('triangle');
      assert.deepEqual([face, contained, depth, [...tri.a, ...tri.b, ...tri.c]], e.slice(1, 5));
      return decode(e[5]);
    };
  return { callbacks, done: () => assert.equal(at, events.length, 'missing calls') };
}

// NaN scores are logged as null in JSON; compare them as NaN.
const fixScores = (events) =>
  events.map((e) => (e[0] === 'bounds' && e[3] === null ? [e[0], e[1], e[2], Number.NaN, ...e.slice(4)] : e));

test('constants keep their public values', () => {
  assert.deepEqual({ NOT_INTERSECTED, INTERSECTED, CONTAINED }, vectors.constants);
});

test('four-leaf traces: order, arguments, containment, scores and stops match exactly', () => {
  const bvh = fourLeafTree();
  for (const row of vectors.fourLeafTraces) {
    const { callbacks, done } = replay(fixScores(row.events));
    assert.equal(bvh.shapecast(callbacks), row.returned, row.note);
    done();
  }
});

test('shapecast refuses a missing intersectsBounds with a TypeError', () => {
  const bvh = fourLeafTree();
  assert.throws(() => bvh.shapecast({}), TypeError);
  assert.throws(() => bvh.shapecast({ intersectsBounds: 1 }), { name: 'TypeError', message: /intersectsBounds/ });
  assert.throws(() => bvh.shapecast(undefined), TypeError);
});

test('one box and one triangle object per query, Float64Array components, new objects per query', () => {
  const bvh = fourLeafTree(),
    boxes = new Set(),
    tris = new Set();
  const run = () =>
    bvh.shapecast({
      intersectsBounds: (box) => (boxes.add(box), INTERSECTED),
      intersectsTriangle: (tri) => void tris.add(tri),
    });
  run();
  assert.equal(boxes.size, vectors.reuse.distinctBoxObjectsInOneQuery);
  assert.equal(tris.size, vectors.reuse.distinctTriangleObjectsInOneQuery);
  const [first] = boxes;
  assert.ok(first.min instanceof Float64Array && first.max instanceof Float64Array);
  run();
  assert.equal(boxes.size, 2, 'a second query uses a new box');
});

test('grid box query and nearest-centroid query replay exactly over the default build', () => {
  const bvh = gridMesh();
  assert.equal(bvh.nodeCount, vectors.gridMesh.nodeCount);
  assert.equal(bvh.triangleCount, vectors.gridMesh.triangleCount);
  for (const query of [vectors.gridBoxQuery, vectors.gridNearestCentroid]) {
    const { callbacks, done } = replay(fixScores(query.events));
    assert.equal(bvh.shapecast(callbacks), query.returned);
    done();
  }
  const box = vectors.gridBoxQuery;
  assert.equal(box.events.filter((e) => e[0] === 'bounds').length, box.boundsCalls);
  assert.deepEqual(
    box.events.filter((e) => e[0] === 'triangle' && !e[2]).map((e) => e[1]),
    box.otherTriangleFaces,
  );
  // Nearest centroid among the triangles the query reported (first principles, from the recorded corners).
  const p = vectors.gridNearestCentroid.point;
  let best = Infinity;
  for (const e of vectors.gridNearestCentroid.events.filter((e) => e[0] === 'triangle')) {
    const c = [0, 1, 2].map((k) => (e[4][k] + e[4][k + 3] + e[4][k + 6]) / 3);
    best = Math.min(best, Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]));
  }
  assert.ok(Math.abs(best - vectors.gridNearestCentroid.best) <= 1e-12, `${best}`);
});

test('a single-triangle BVH is one leaf at depth 0', () => {
  const bvh = MeshBVH.build({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
  const row = vectors['source: one triangle'];
  assert.equal(bvh.nodeCount, row.nodeCount);
  const { callbacks, done } = replay(row.events);
  assert.equal(bvh.shapecast(callbacks), row.returned);
  done();
});

test('callbacks may start nested queries without disturbing the outer one', () => {
  const bvh = fourLeafTree(),
    seen = [];
  bvh.shapecast({
    intersectsBounds: (box, isLeaf, score, depth, node) => {
      const before = [...box.min, ...box.max];
      bvh.shapecast({ intersectsBounds: () => CONTAINED, intersectsRange: () => false });
      assert.deepEqual([...box.min, ...box.max], before);
      seen.push(node);
      return INTERSECTED;
    },
  });
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6]);
});
