import test from 'node:test';
import assert from 'node:assert/strict';
import { ObstacleNavMesh } from '../dist/obstacles.js';
import { TiledNavMesh } from '../dist/tiles.js';
import { encodeNavMesh } from '../dist/codec.js';

const floor = [0, 0, 0, 32, 0, 0, 32, 0, 32, 0, 0, 32],
  indices = [0, 2, 1, 0, 3, 2],
  settings = { cs: 0.5, ch: 0.1, tileSize: 16, walkableRadius: 0, minRegionArea: 0 };
function brute(shape) {
  const boxes = [];
  for (let row = 0; row < 64; row++)
    for (let column = 0; column < 64; column++) {
      const x = (column + 0.5) * 0.5,
        z = (row + 0.5) * 0.5;
      let inside, y0, y1;
      if (shape.type === 'cylinder') {
        inside = (x - shape.position[0]) ** 2 + (z - shape.position[2]) ** 2 <= shape.radius ** 2;
        y0 = shape.position[1];
        y1 = y0 + shape.height;
      } else {
        const dx = x - shape.center[0],
          dz = z - shape.center[2],
          c = Math.cos(shape.yRadians ?? 0),
          s = Math.sin(shape.yRadians ?? 0);
        inside = Math.abs(c * dx - s * dz) <= shape.halfExtents[0] && Math.abs(s * dx + c * dz) <= shape.halfExtents[2];
        y0 = shape.center[1] - shape.halfExtents[1];
        y1 = shape.center[1] + shape.halfExtents[1];
      }
      if (inside) boxes.push({ min: [column * 0.5, y0, row * 0.5], max: [(column + 1) * 0.5, y1, (row + 1) * 0.5] });
    }
  return boxes;
}
function sameTiles(actual, shape) {
  using expected = new TiledNavMesh(floor, indices, { ...settings, obstacles: brute(shape) });
  for (const tile of expected.tileList()) {
    const got = actual.tile(tile.x, tile.z);
    assert.equal(Boolean(got?.mesh), Boolean(tile.mesh));
    if (tile.mesh) assert.deepEqual(encodeNavMesh(got.mesh), encodeNavMesh(tile.mesh), `tile ${tile.x},${tile.z}`);
  }
}

test('cylinders across tile lines match analytic cell-center masks and retain open AABB corners', () => {
  using mesh = new ObstacleNavMesh(floor, indices, settings);
  const far = mesh.tile(3, 3).mesh,
    shape = { type: 'cylinder', position: [8, 0, 8], radius: 3, height: 2 },
    id = mesh.addObstacle(shape);
  assert.ok(mesh.pendingTiles > 0);
  assert.ok(mesh.locate([8.25, 0, 8.25]) >= 0);
  mesh.update();
  sameTiles(mesh, shape);
  assert.equal(mesh.locate([8.25, 0, 8.25]), -1);
  assert.ok(mesh.locate([5.25, 0, 5.25]) >= 0);
  assert.equal(mesh.tile(3, 3).mesh, far);
  assert.equal(mesh.removeObstacle(id), true);
  mesh.update();
  assert.ok(mesh.locate([8.25, 0, 8.25]) >= 0);
  assert.equal(mesh.removeObstacle(id), false);
});

test('Y-rotated boxes use their exact rotated footprint and support move, remove and ordinary boxes', () => {
  using mesh = new ObstacleNavMesh(floor, indices, settings);
  const shape = { type: 'box', center: [16, 1, 16], halfExtents: [5, 1, 1], yRadians: Math.PI / 4 },
    id = mesh.addBoxObstacle(shape.center, shape.halfExtents, shape.yRadians);
  mesh.update();
  sameTiles(mesh, shape);
  assert.equal(mesh.locate([18.25, 0, 13.75]), -1);
  assert.ok(mesh.locate([19.25, 0, 19.25]) >= 0);
  const moved = { type: 'cylinder', position: [24, 0, 8], radius: 2, height: 3 };
  assert.equal(mesh.moveObstacle(id, moved), true);
  mesh.update();
  sameTiles(mesh, moved);
  assert.ok(mesh.locate([18.25, 0, 13.75]) >= 0);
  assert.equal(mesh.locate([24.25, 0, 8.25]), -1);
  const box = mesh.addObstacle({ min: [2, 0, 2], max: [4, 2, 4] });
  mesh.update();
  assert.ok(box >= 0);
  assert.equal(mesh.locate([3.25, 0, 3.25]), -1);
  assert.equal(mesh.moveObstacle(box, { type: 'box', center: [3, 1, 3], halfExtents: [1, 1, 1], yRadians: 0 }), true);
  mesh.update();
  assert.equal(mesh.locate([3.25, 0, 3.25]), -1);
  assert.equal(mesh.removeObstacle(box), true);
});

test('all headings match brute geometry; vertical spans do not carve an unrelated lower floor', () => {
  using mesh = new ObstacleNavMesh(floor, indices, settings);
  let id;
  for (const angle of [0, Math.PI / 2, -Math.PI / 2, Math.PI, 0.37, -2.1]) {
    const shape = { type: 'box', center: [15.25, 1, 15.25], halfExtents: [4.5, 1, 1.5], yRadians: angle };
    if (id === undefined) id = mesh.addObstacle(shape);
    else mesh.moveObstacle(id, shape);
    mesh.update();
    sameTiles(mesh, shape);
  }
  mesh.removeObstacle(id);
  mesh.addCylinderObstacle([8, 10, 8], 3, 2);
  mesh.update();
  assert.ok(mesh.locate([8.25, 0, 8.25]) >= 0);
});

test('invalid replacements are atomic, subcell empty shapes can move, and lifecycle checks remain intact', () => {
  const mesh = new ObstacleNavMesh(floor, indices, settings),
    id = mesh.addCylinderObstacle([8, 0, 8], 0.1, 2);
  assert.equal(mesh.pendingTiles, 0);
  mesh.moveObstacle(id, { type: 'cylinder', position: [8, 0, 8], radius: 2, height: 2 });
  mesh.update();
  assert.equal(mesh.locate([8.25, 0, 8.25]), -1);
  assert.throws(
    () => mesh.moveObstacle(id, { type: 'cylinder', position: [8, 0, 8], radius: -1, height: 2 }),
    RangeError,
  );
  assert.equal(mesh.pendingTiles, 0);
  assert.equal(mesh.locate([8.25, 0, 8.25]), -1);
  assert.throws(() => mesh.addBoxObstacle([8, 0, 8], [1, 1, 1], NaN), RangeError);
  assert.equal(mesh.moveObstacle(-1000, { type: 'cylinder', position: [8, 0, 8], radius: 1, height: 1 }), false);
  mesh.dispose();
  mesh.dispose();
  assert.throws(
    () => mesh.addCylinderObstacle([8, 0, 8], 1, 1),
    (e) => e.code === 'disposed',
  );
});
