import test from 'node:test';
import assert from 'node:assert/strict';
import { NavMesh, Crowd } from '../dist/index.js';
import { NavMeshQuery } from '../dist/queries.js';
import { TiledNavMesh } from '../dist/tiles.js';

const islands = () =>
  new NavMesh(
    [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 4],
      [0, 0, 4],
      [6, 0, 0],
      [10, 0, 0],
      [10, 0, 4],
      [6, 0, 4],
    ],
    [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  );
test('partial path ends at the nearest reachable edge, full paths retain the goal and links', () => {
  const mesh = islands(),
    query = new NavMeshQuery(mesh);
  assert.equal(mesh.route([1, 0, 1], [9, 0, 3]), null);
  const partial = query.route([1, 0, 1], [9, 0, 3]);
  assert.equal(partial.partial, true);
  assert.equal(partial.polygon, 0);
  assert.deepEqual(partial.points, [
    [1, 0, 1],
    [4, 0, 3],
  ]);
  const link = mesh.addOffMeshLink([3, 0, 2], [7, 0, 2], { bidirectional: false });
  const full = query.route([1, 0, 1], [9, 0, 3]);
  assert.equal(full.partial, false);
  assert.deepEqual(full.points.at(-1), [9, 0, 3]);
  assert.equal(full.offMesh.length, 1);
  assert.equal(query.route([9, 0, 3], [1, 0, 1]).partial, true);
  mesh.removeOffMeshLink(link);
  assert.equal(query.route([1, 0, 1], [9, 0, 3]).partial, true);
  assert.equal(query.route([-1, 0, 1], [9, 0, 3]), null);
  assert.equal(query.route([1, 0, 1], [3, 0, 1]).partial, false);
});
test('nearest point is chosen from reachable polygon geometry, not its center or the nearest disconnected island', () => {
  const mesh = new NavMesh(
    [
      [0, 0, 0],
      [2, 0, 0],
      [2, 0, 2],
      [0, 0, 2],
      [10, 0, 0],
      [10, 0, 2],
      [10, 0, 4],
      [2, 0, 4],
    ],
    [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
      [2, 5, 6, 7],
    ],
  );
  const q = new NavMeshQuery(mesh),
    path = q.route([1, 0, 1], [9, 0, 5]);
  assert.equal(path.partial, true);
  assert.deepEqual(path.points.at(-1), [9, 0, 4]);
  mesh.setPolygonArea(1, 1);
  mesh.setPolygonArea(2, 1);
  assert.deepEqual(q.route([1, 0, 1], [9, 0, 5], [1, Infinity]).points.at(-1), [2, 0, 2]);
  assert.equal(q.route([9, 0, 1], [1, 0, 1], [1, Infinity]), null);
});
test('crowd follows partial paths, exposes the flag, preserves outside goals and replans after a link opens', () => {
  const mesh = islands(),
    surface = new NavMeshQuery(mesh);
  using crowd = new Crowd(surface);
  const agent = crowd.addAgent({ position: [1, 0, 2], radius: 0.1, maxSpeed: 2 });
  agent.setTarget([9, 0, 2]);
  for (let i = 0; i < 200; i++) crowd.update(0.05);
  assert.equal(agent.state, 'arrived');
  assert.equal(agent.partial, true);
  assert.ok(agent.position[0] > 3.8 && agent.position[0] <= 4);
  mesh.addOffMeshLink([4, 0, 2], [6, 0, 2]);
  for (let i = 0; i < 300; i++) crowd.update(0.05);
  assert.equal(agent.partial, false);
  assert.equal(agent.state, 'arrived');
  assert.ok(agent.position[0] > 8.8);
  agent.setTarget([12, 0, 2]);
  crowd.update(0.05);
  assert.equal(agent.partial, true);
  agent.stop();
  assert.equal(agent.partial, false);
});
test('tiled partial paths survive obstacle rebuilds and preserve filters', () => {
  using mesh = new TiledNavMesh([0, 0, 0, 16, 0, 0, 16, 0, 16, 0, 0, 16], [0, 2, 1, 0, 3, 2], {
    cs: 0.5,
    ch: 0.1,
    tileSize: 8,
    walkableRadius: 0,
    minRegionArea: 0,
  });
  const query = new NavMeshQuery(mesh),
    start = [2, 0, 2],
    end = [14, 0, 2];
  assert.equal(query.route(start, end).partial, false);
  const id = mesh.addObstacle({ min: [7, -1, 0], max: [9, 3, 16] });
  mesh.update();
  assert.equal(query.route(start, end).partial, true);
  assert.deepEqual(query.path(start, end).at(-1), [7, 0, 2]);
  mesh.removeObstacle(id);
  mesh.update();
  assert.equal(query.route(start, end).partial, false);
});
