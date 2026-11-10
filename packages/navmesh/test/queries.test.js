import test from 'node:test';
import assert from 'node:assert/strict';
import { NavMesh } from '../dist/index.js';
import { NavMeshQuery } from '../dist/queries.js';
import { TiledNavMesh } from '../dist/tiles.js';

function rooms(reverse = false) {
  const polygons = [
    [0, 1, 2, 3],
    [1, 4, 5, 2],
    [2, 5, 6, 7],
  ];
  return new NavMesh(
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 2],
      [0, 0, 2],
      [4, 0, 0],
      [4, 0, 2],
      [4, 0, 4],
      [2, 0, 4],
    ],
    reverse ? polygons.map((p) => p.toReversed()) : polygons,
  );
}
const near = (actual, expected) =>
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-7, `${actual} != ${expected}`));

test('surface ray crosses portals, reports the exact wall fraction, edge and outward normal for either winding', () => {
  for (const reverse of [false, true]) {
    const query = new NavMeshQuery(rooms(reverse));
    const clear = query.raycast([1, 0, 1], [3, 900, 1]);
    assert.equal(clear.hit, false);
    assert.equal(clear.t, 1);
    assert.deepEqual(clear.visited, [0, 1]);
    assert.deepEqual(clear.position, [3, 0, 1]);
    const hit = query.raycast([1, 0, 1], [5, 0, 1]);
    assert.equal(hit.hit, true);
    assert.equal(hit.t, 0.75);
    assert.deepEqual(hit.position, [4, 0, 1]);
    near(hit.normal, [1, 0, 0]);
    assert.ok(hit.edge.every((p) => p[0] === 4));
    assert.deepEqual(query.raycast([1, 0, 1], [1, 0, 1]).position, [1, 0, 1]);
    assert.equal(query.raycast([-1, 0, 1], [1, 0, 1]), null);
    assert.equal(query.raycast([0, 0, 1], [-1, 0, 1]).t, 0);
  }
});

test('vertex ties walk through zero-length polygon intervals; walls and filters never become jumps', () => {
  const mesh = rooms(),
    query = new NavMeshQuery(mesh);
  assert.equal(query.raycast([1, 0, 1], [3, 0, 3]).hit, false);
  mesh.setPolygonArea(1, 1);
  const hit = query.raycast([1, 0, 1], [3, 0, 1], { filter: [1, Infinity] });
  assert.equal(hit.t, 0.5);
  near(hit.normal, [1, 0, 0]);
  mesh.setAreaCost(1, Infinity);
  assert.equal(query.raycast([1, 0, 1], [3, 0, 1]).t, 0.5);
  assert.equal(query.moveAlongSurface([1, 0, 1], [3, 0, 1]).position[0], 2);
  assert.throws(() => query.raycast([1, 0, 1], [3, 0, 1], { filter: [0] }), RangeError);
  assert.throws(() => query.raycast([1, 0, 1], [3, 0, 1], { startPolygon: 2 }), RangeError);
  assert.throws(() => query.moveAlongSurface([1, 0, 1], [NaN, 0, 1]), RangeError);
  const islands = new NavMesh(
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 2],
      [0, 0, 2],
      [3, 0, 0],
      [5, 0, 0],
      [5, 0, 2],
      [3, 0, 2],
    ],
    [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  );
  islands.addOffMeshLink([1, 0, 1], [4, 0, 1]);
  const q = new NavMeshQuery(islands);
  assert.equal(q.raycast([1, 0, 1], [4, 0, 1]).position[0], 2);
  assert.equal(q.moveAlongSurface([1, 0, 1], [4, 0, 1]).position[0], 2);
});

test('move along surface slides and returns a connected local corridor without crossing a gap', () => {
  const mesh = rooms(),
    query = new NavMeshQuery(mesh);
  const moved = query.moveAlongSurface([1, 0, 1], [5, 0, 3]);
  assert.deepEqual(moved.position, [4, 0, 3]);
  assert.deepEqual(moved.visited, [0, 1, 2]);
  const corner = query.moveAlongSurface([1, 0, 1], [1, 0, 3]);
  assert.deepEqual(corner.position, [1, 0, 2]);
  const ramp = new NavMesh(
    [
      [0, 0, 0],
      [4, 2, 0],
      [4, 2, 4],
      [0, 0, 4],
    ],
    [[0, 1, 2, 3]],
  );
  near(new NavMeshQuery(ramp).moveAlongSurface([1, 0.5, 1], [3, 99, 1]).position, [3, 1.5, 1]);
});

test('tiled query crosses partial portals and reads rebuilt polygons live', () => {
  using mesh = new TiledNavMesh([0, 0, 0, 16, 0, 0, 16, 0, 16, 0, 0, 16], [0, 2, 1, 0, 3, 2], {
    cs: 0.5,
    ch: 0.1,
    tileSize: 8,
    walkableRadius: 0,
    minRegionArea: 0,
  });
  const query = new NavMeshQuery(mesh);
  assert.equal(query.raycast([2, 0, 2], [14, 0, 2]).hit, false);
  near(query.moveAlongSurface([2, 0, 2], [14, 0, 2]).position, [14, 0, 2]);
  const obstacle = mesh.addObstacle({ min: [7, -1, 0], max: [9, 3, 16] });
  mesh.update();
  assert.equal(query.raycast([2, 0, 2], [14, 0, 2]).hit, true);
  near(query.moveAlongSurface([2, 0, 2], [14, 0, 2]).position, [7, 0, 2]);
  mesh.removeObstacle(obstacle);
  mesh.update();
  assert.equal(query.raycast([2, 0, 2], [14, 0, 2]).hit, false);
});
