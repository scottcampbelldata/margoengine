import test from 'node:test';
import assert from 'node:assert/strict';
import { NavMesh } from '../dist/index.js';
import { NavMeshQuery } from '../dist/queries.js';
import { TiledNavMesh } from '../dist/tiles.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
test('seeded sampling is repeatable, area weighted across islands, and uniform within triangles', () => {
  const mesh = new NavMesh(
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
      [2, 0, 0],
      [5, 0, 0],
      [5, 0, 3],
      [2, 0, 3],
    ],
    [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
    ],
  );
  const a = new NavMeshQuery(mesh, { seed: 17 }),
    b = new NavMeshQuery(mesh, { seed: 17 });
  let large = 0;
  for (let i = 0; i < 10000; i++) {
    const sample = a.randomPoint();
    assert.deepEqual(sample, b.randomPoint());
    assert.equal(mesh.locate(sample.point), sample.polygon);
    if (sample.polygon === 1) large++;
  }
  assert.ok(Math.abs(large / 10000 - 0.9) < 0.015, String(large));
  assert.deepEqual(a.randomPoint({ seed: 99 }), a.randomPoint({ seed: 99 }));
  mesh.setPolygonArea(1, 1);
  for (let i = 0; i < 100; i++) assert.equal(a.randomPoint({ filter: [1, Infinity] }).polygon, 0);
  assert.equal(a.randomPoint({ filter: [Infinity, Infinity] }), null);
  const triangle = new NavMesh(
      [
        [0, 0, 0],
        [3, 0, 0],
        [0, 0, 3],
      ],
      [[0, 1, 2]],
    ),
    query = new NavMeshQuery(triangle, { seed: 42 });
  let x = 0,
    z = 0;
  for (let i = 0; i < 10000; i++) {
    const { point: p } = query.randomPoint();
    x += p[0];
    z += p[2];
  }
  assert.ok(Math.abs(x / 10000 - 1) < 0.02);
  assert.ok(Math.abs(z / 10000 - 1) < 0.02);
});
test('surface area, rather than XZ area or polygon count, weights sloped polygons', () => {
  const mesh = new NavMesh(
      [
        [0, 0, 0],
        [2, 0, 0],
        [2, 0, 2],
        [0, 0, 2],
        [3, 0, 0],
        [5, 2, 0],
        [5, 2, 2],
        [3, 0, 2],
      ],
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ],
    ),
    q = new NavMeshQuery(mesh, { seed: 8 });
  let slope = 0;
  for (let i = 0; i < 10000; i++) {
    const s = q.randomPoint();
    if (s.polygon === 1) {
      slope++;
      near(s.point[1], s.point[0] - 3);
    }
  }
  assert.ok(Math.abs(slope / 10000 - Math.SQRT2 / (1 + Math.SQRT2)) < 0.02);
});
test('radius samples stay strictly inside the disk, are uniform and exclude disconnected and forbidden ground', () => {
  const mesh = new NavMesh(
      [
        [0, 0, 0],
        [100, 0, 0],
        [100, 0, 100],
        [0, 0, 100],
        [40, 3, 40],
        [60, 3, 40],
        [60, 3, 60],
        [40, 3, 60],
      ],
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ],
    ),
    q = new NavMeshQuery(mesh, { seed: 3 });
  let radius2 = 0,
    x = 0,
    z = 0;
  for (let i = 0; i < 6000; i++) {
    const { point: p, polygon } = q.randomPointAroundCircle([50, 0, 50], 1);
    const d = (p[0] - 50) ** 2 + (p[2] - 50) ** 2;
    assert.ok(d <= 1);
    assert.equal(polygon, 0);
    radius2 += d;
    x += p[0] - 50;
    z += p[2] - 50;
  }
  assert.ok(Math.abs(radius2 / 6000 - 0.5) < 0.02);
  assert.ok(Math.abs(x / 6000) < 0.025);
  assert.ok(Math.abs(z / 6000) < 0.025);
  assert.deepEqual(q.randomPointAroundCircle([50, 0, 50], 0), { point: [50, 0, 50], polygon: 0 });
  assert.equal(q.randomPointAroundCircle([-1, 0, 0], 1), null);
  assert.equal(q.randomPointAroundCircle([50, 0, 50], 1, { filter: [Infinity] }), null);
  assert.throws(() => q.randomPointAroundCircle([50, 0, 50], -1), RangeError);
  assert.throws(() => q.randomPoint({ seed: NaN }), RangeError);
  assert.throws(() => q.randomPoint({ maxSamples: 0 }), RangeError);
});
test('wall queries return exact distances, inward normals, bounds, filters and no disconnected walls', () => {
  const mesh = new NavMesh(
      [
        [0, 0, 0],
        [2, 0, 0],
        [2, 0, 4],
        [0, 0, 4],
        [6, 0, 0],
        [6, 0, 4],
      ],
      [
        [0, 1, 2, 3],
        [1, 4, 5, 2],
      ],
    ),
    q = new NavMeshQuery(mesh);
  const wall = q.distanceToWall([1, 0, 2]);
  near(wall.distance, 1);
  assert.deepEqual(wall.position, [0, 0, 2]);
  near(wall.normal[0], 1);
  const limited = q.distanceToWall([1, 0, 2], 0.5);
  assert.equal(limited.distance, 0.5);
  assert.equal(limited.position, null);
  assert.equal(limited.edge, null);
  mesh.setPolygonArea(1, 1);
  const blocked = q.distanceToWall([1.5, 0, 2], 4, { filter: [1, Infinity] });
  near(blocked.distance, 0.5);
  assert.deepEqual(blocked.position, [2, 0, 2]);
  near(blocked.normal[0], -1);
  const touching = q.distanceToWall([0, 0, 2], 0);
  assert.equal(touching.distance, 0);
  near(touching.normal[0], 1);
  assert.equal(q.distanceToWall([-1, 0, 2]), null);
  assert.throws(() => q.distanceToWall([1, 0, 2], NaN), RangeError);
});
test('tile seams are portals only over their open intervals; sampling and walls follow rebuilds', () => {
  using mesh = new TiledNavMesh([0, 0, 0, 16, 0, 0, 16, 0, 16, 0, 0, 16], [0, 2, 1, 0, 3, 2], {
    cs: 0.5,
    ch: 0.1,
    tileSize: 8,
    walkableRadius: 0,
    minRegionArea: 0,
  });
  const q = new NavMeshQuery(mesh, { seed: 7 });
  const id = mesh.addObstacle({ min: [4, -1, 0], max: [6, 3, 2] });
  mesh.update();
  near(q.distanceToWall([3, 0, 1.5]).distance, 1);
  const diagonal = q.distanceToWall([3, 0, 3]);
  near(diagonal.distance, Math.SQRT2);
  for (let i = 0; i < 100; i++) {
    const s = q.randomPointAroundCircle([3, 0, 3], 3);
    assert.ok(mesh.locate(s.point) >= 0);
    assert.ok(Math.hypot(s.point[0] - 3, s.point[2] - 3) <= 3);
  }
  mesh.removeObstacle(id);
  mesh.update();
  near(q.distanceToWall([3, 0, 3]).distance, 2.5);
});
