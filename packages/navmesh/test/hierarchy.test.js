import test from 'node:test';
import assert from 'node:assert/strict';
import { NavHierarchy } from '../dist/hierarchy.js';
import { TiledNavMesh } from '../dist/tiles.js';

function box(positions, indices, [x0, x1, z0, z1]) {
  const base = positions.length / 3;
  for (const y of [0, 3]) positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
  for (const [a, b, c, d] of [
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ])
    indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
}
/** A generated stand-in: a floor cut into rooms by walls, each wall with doors placed by the seed. */
function rooms(size = 128, room = 32, seed = 5) {
  const positions = [0, 0, 0, size, 0, 0, size, 0, size, 0, 0, size],
    indices = [0, 2, 1, 0, 3, 2],
    next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let line = room; line < size; line += room)
    for (let start = 0; start < size; start += room) {
      const door = start + 4 + next() * (room - 12);
      box(positions, indices, [line, line + 0.5, start, door]);
      box(positions, indices, [line, line + 0.5, door + 3, start + room]);
      const other = start + 4 + next() * (room - 12);
      box(positions, indices, [start, other, line, line + 0.5]);
      box(positions, indices, [other + 3, start + room, line, line + 0.5]);
    }
  return [positions, indices];
}
const options = { cs: 0.5, ch: 0.1, walkableRadius: 1, walkableHeight: 10, walkableClimb: 3, tileSize: 16 };
const world = (...level) => new TiledNavMesh(...(level.length ? level : rooms()), options);
const length = (points) =>
  points.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - points[i - 1][0], p[2] - points[i - 1][2]) : sum), 0);
function queries(mesh, count, size = 128) {
  const out = [];
  let seed = 99;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  while (out.length < count) {
    const a = [next() * size, 0, next() * size],
      b = [next() * size, 0, next() * size];
    if (mesh.locate(a) >= 0 && mesh.locate(b) >= 0) out.push([a, b]);
  }
  return out;
}

test('routes reach wherever the exact search does, near its length', () => {
  const mesh = world(),
    hierarchy = new NavHierarchy(mesh, { clusterTiles: 2 });
  assert.equal(hierarchy.clusterCount, 64);
  assert.ok(hierarchy.nodeCount > 0 && hierarchy.nodeCount < mesh.polygonCount);
  let exact = 0,
    coarse = 0,
    worst = 1,
    compared = 0;
  for (const [a, b] of queries(mesh, 200)) {
    const one = mesh.route(a, b),
      two = hierarchy.route(a, b);
    assert.equal(two === null, one === null);
    if (!one) continue;
    compared++;
    assert.deepEqual(two.points[0], a);
    assert.deepEqual(two.points.at(-1), b);
    const l1 = length(one.points),
      l2 = length(two.points);
    exact += l1;
    coarse += l2;
    worst = Math.max(worst, l2 / l1);
    // Every leg stays on the mesh: its middle has ground under it.
    for (let i = 1; i < two.points.length; i++) {
      const p = two.points[i - 1],
        q = two.points[i],
        m = [(p[0] + q[0]) / 2, 0, (p[2] + q[2]) / 2];
      assert.ok(mesh.locate(m) >= 0, `${m}`);
    }
  }
  assert.equal(compared, 200, 'every room joins up, through doors on tile lines too');
  assert.ok(coarse / exact < 1.02, `mean ${coarse / exact}`);
  assert.ok(worst < 1.2, `worst ${worst}`);
});

test('two ends in one cluster, and in one polygon', () => {
  const positions = [0, 0, 0, 64, 0, 0, 64, 0, 64, 0, 0, 64],
    indices = [0, 2, 1, 0, 3, 2],
    mesh = world(positions, indices),
    hierarchy = new NavHierarchy(mesh, { clusterTiles: 2 });
  assert.deepEqual(hierarchy.path([3, 0, 3], [3.1, 0, 3.1]), [
    [3, 0, 3],
    [3.1, 0, 3.1],
  ]);
  assert.equal(hierarchy.path([3, 0, 3], [12, 0, 12]).length, 2);
  assert.equal(hierarchy.path([3, 0, 3], [60, 0, 60]).length, 2, 'open ground stays a straight line');
  assert.equal(hierarchy.path([-5, 0, 3], [60, 0, 60]), null);
  assert.throws(() => hierarchy.path([0, 0], [1, 0, 1]), RangeError);
});

test('a change works out only the clusters it touches', () => {
  const mesh = world(),
    hierarchy = new NavHierarchy(mesh, { clusterTiles: 2 }),
    wall = mesh.addObstacle({ min: [2, -1, 2], max: [6, 4, 6] });
  mesh.update();
  const count = hierarchy.update();
  assert.ok(count > 0 && count <= 3, `${count} of 64`);
  assert.equal(hierarchy.update(), 0);
  assert.equal(hierarchy.route([4, 0, 4], [100, 0, 100]), null, 'the box stands on the start');
  mesh.removeObstacle(wall);
  mesh.update();
  for (const [a, b] of queries(mesh, 40)) assert.equal(hierarchy.route(a, b) === null, mesh.route(a, b) === null);
});

test('shutting every door of a room shuts it, and opening one finds it', () => {
  const positions = [0, 0, 0, 64, 0, 0, 64, 0, 64, 0, 0, 64],
    indices = [0, 2, 1, 0, 3, 2],
    mesh = world(positions, indices),
    hierarchy = new NavHierarchy(mesh, { clusterTiles: 2 }),
    wall = mesh.addObstacle({ min: [30, -1, -1], max: [34, 4, 65] });
  mesh.update();
  assert.equal(hierarchy.route([5, 0, 5], [60, 0, 60]), null);
  mesh.moveObstacle(wall, { min: [30, -1, -1], max: [34, 4, 40] });
  mesh.update();
  const route = hierarchy.route([5, 0, 5], [60, 0, 5]);
  assert.ok(route);
  assert.ok(
    route.points.some((p) => p[2] > 39),
    'goes round the end',
  );
});

test('off-mesh links are used, across clusters and after they are added', () => {
  const positions = [0, 0, 0, 20, 0, 0, 20, 0, 64, 0, 0, 64, 44, 0, 0, 64, 0, 0, 64, 0, 64, 44, 0, 64],
    indices = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6],
    mesh = world(positions, indices),
    hierarchy = new NavHierarchy(mesh, { clusterTiles: 2 }),
    a = [10, 0, 30],
    b = [54, 0, 30];
  assert.equal(hierarchy.route(a, b), null);
  const link = mesh.addOffMeshLink([18, 0, 30], [46, 0, 30], { cost: 30, bidirectional: false }),
    route = hierarchy.route(a, b);
  assert.equal(route.offMesh.length, 1);
  assert.equal(hierarchy.route(b, a), null, 'one way');
  assert.ok(mesh.removeOffMeshLink(link));
  assert.equal(hierarchy.route(a, b), null);
});

test('a filter keeps a hierarchy off ground, as it does the exact search', () => {
  const [positions, indices] = rooms(64, 32),
    mesh = new TiledNavMesh(positions, indices, {
      ...options,
      areas: [{ min: [0, -1, 20], max: [64, 1, 26], area: 2 }],
    }),
    filter = [1, 1, Infinity],
    hierarchy = new NavHierarchy(mesh, { clusterTiles: 2, filter }),
    plain = new NavHierarchy(mesh, { clusterTiles: 2 });
  assert.equal(hierarchy.route([5, 0, 5], [5, 0, 30]), mesh.route([5, 0, 5], [5, 0, 30], filter));
  assert.ok(plain.route([5, 0, 5], [5, 0, 30]));
});

test('options are checked', () => {
  const mesh = world();
  assert.throws(() => new NavHierarchy(mesh, { clusterTiles: 0 }), RangeError);
  assert.throws(() => new NavHierarchy(mesh, { clusterTiles: 1.5 }), RangeError);
  assert.throws(() => new NavHierarchy(mesh, { spacing: 0 }), RangeError);
});
