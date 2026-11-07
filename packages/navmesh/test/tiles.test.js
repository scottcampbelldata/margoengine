import test from 'node:test';
import assert from 'node:assert/strict';
import { Crowd } from '../dist/index.js';
import { buildNavMesh } from '../dist/build.js';
import { TiledNavMesh } from '../dist/tiles.js';

/** A floor from (0, 0) to (size, size) with solid boxes standing on it. */
function level(size, boxes = []) {
  const positions = [0, 0, 0, size, 0, 0, size, 0, size, 0, 0, size],
    indices = [0, 2, 1, 0, 3, 2];
  for (const box of boxes) addBox(positions, indices, box);
  return [positions, indices];
}
function addBox(positions, indices, [x0, x1, z0, z1, height = 3]) {
  const base = positions.length / 3;
  for (const y of [0, height]) positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
  for (const [a, b, c, d] of [
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ])
    indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
}
/** Blocks on a regular street grid. */
const city = (size, pitch, width) => {
  const boxes = [];
  for (let x = pitch / 2; x + width < size; x += pitch)
    for (let z = pitch / 2; z + width < size; z += pitch) boxes.push([x, x + width, z, z + width]);
  return boxes;
};
const settings = { cs: 0.25, ch: 0.1, walkableRadius: 2, walkableHeight: 10, walkableClimb: 3 };
const random = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32);
const length = (path) =>
  path.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - path[i - 1][0], p[2] - path[i - 1][2]) : sum), 0);
/** Every tile's polygons, as text, to compare two meshes exactly. */
const fingerprint = (world) =>
  [...world.tileList()]
    .filter((tile) => tile.mesh)
    .map((tile) => {
      const polygons = [];
      for (let p = 0; p < tile.mesh.polygonCount; p++)
        polygons.push(
          tile.mesh
            .polygonVertices(p)
            .map((v) => tile.mesh.vertices[v].join(','))
            .join(' '),
        );
      return `${tile.x},${tile.z}: ${polygons.join(' | ')}`;
    })
    .sort()
    .join('\n');

test('a tiled level walks the same cells as one mesh of the same level', () => {
  // With no simplification both trace the cells exactly, so any difference is a tile's edge changing the result.
  const [positions, indices] = level(40, city(40, 8, 3)),
    exact = { ...settings, maxSimplificationError: 0 },
    whole = buildNavMesh(positions, indices, exact),
    tiled = new TiledNavMesh(positions, indices, { ...exact, tileSize: 16 }),
    next = random(7);
  assert.ok([...tiled.tileList()].length >= 100);
  let differ = 0;
  for (let i = 0; i < 4000; i++) {
    const at = [next() * 40, 0, next() * 40];
    if (whole.locate(at) >= 0 !== tiled.locate(at) >= 0) differ++;
  }
  assert.equal(differ, 0);
});

test('paths cross tile lines, stay on the walkable area and are as short as on one mesh', () => {
  const [positions, indices] = level(40, city(40, 8, 3)),
    whole = buildNavMesh(positions, indices, settings),
    tiled = new TiledNavMesh(positions, indices, { ...settings, tileSize: 16 }),
    next = random(11);
  let checked = 0;
  for (let i = 0; i < 200; i++) {
    const a = [next() * 40, 0, next() * 40],
      b = [next() * 40, 0, next() * 40];
    if (whole.locate(a) < 0 || whole.locate(b) < 0 || tiled.locate(a) < 0 || tiled.locate(b) < 0) continue;
    const one = whole.path(a, b),
      many = tiled.path(a, b);
    // Rooftops are walkable islands too.
    assert.equal(!one, !many, 'both find a route or neither');
    if (!one) continue;
    assert.ok(length(many) <= length(one) * 1.08 + 0.5, `${length(many)} against ${length(one)}`);
    for (let s = 1; s < many.length; s++)
      for (let t = 0.05; t < 1; t += 0.1) {
        const x = many[s - 1][0] + (many[s][0] - many[s - 1][0]) * t,
          z = many[s - 1][2] + (many[s][2] - many[s - 1][2]) * t;
        assert.ok(tiled.locate([x, 0, z]) >= 0, `(${x}, ${z}) is off the mesh`);
      }
    checked++;
  }
  assert.ok(checked > 80, `${checked} pairs`);
});

test('a world past the 4,096 polygon limit of one mesh builds and routes as tiles', () => {
  const [positions, indices] = level(160, city(160, 4, 1.5)),
    options = { cs: 0.25, ch: 0.1, walkableRadius: 1, walkableHeight: 10, walkableClimb: 3 };
  assert.throws(() => buildNavMesh(positions, indices, options), /4096/);
  const world = new TiledNavMesh(positions, indices, options);
  assert.ok(world.polygonCount > 4096, `${world.polygonCount} polygons`);
  const path = world.path([1, 0, 1], [157, 0, 157]);
  assert.ok(path && length(path) >= Math.hypot(156, 156) - 1e-6 && length(path) < 156 * 2);
});

test('an obstacle rebuilds only the tiles it reaches, and the others stay the same objects', () => {
  const [positions, indices] = level(64),
    world = new TiledNavMesh(positions, indices, { ...settings, tileSize: 32 }),
    before = new Map([...world.tileList()].map((tile) => [`${tile.x},${tile.z}`, tile.mesh]));
  assert.equal([...before.values()].filter(Boolean).length, 64);
  world.addObstacle({ min: [28, 0, 28], max: [29, 3, 29] });
  assert.equal(world.pendingTiles, 1);
  assert.equal(world.update(), 1);
  let changed = 0;
  for (const tile of world.tileList()) if (before.get(`${tile.x},${tile.z}`) !== tile.mesh) changed++;
  assert.equal(changed, 1);
  assert.equal(world.locate([28.5, 0, 28.5]), -1);
});

test('after any run of changes the tiles equal a fresh build of the final level', () => {
  const [positions, indices] = level(32, city(32, 8, 3)),
    options = { ...settings, tileSize: 16 },
    world = new TiledNavMesh(positions, indices, options),
    gate = world.addObstacle({ min: [5, 0, 14], max: [7, 3, 18] }),
    gone = world.addObstacle({ min: [20, 0, 2], max: [22, 3, 3] }),
    wall = [[], []];
  addBox(wall[0], wall[1], [14, 15, 0, 9]);
  assert.ok(world.addGeometry(wall[0], wall[1]) > 0);
  world.update();
  world.moveObstacle(gate, { min: [10, 0, 22], max: [13, 3, 23] });
  world.removeObstacle(gone);
  const shed = [[], []];
  addBox(shed[0], shed[1], [24, 27, 24, 27]);
  const temporary = world.addGeometry(shed[0], shed[1]);
  world.update();
  world.removeGeometry(temporary);
  world.update();
  const final = level(32, [...city(32, 8, 3), [14, 15, 0, 9]]),
    fresh = new TiledNavMesh(final[0], final[1], { ...options, obstacles: [{ min: [10, 0, 22], max: [13, 3, 23] }] });
  assert.equal(fingerprint(world), fingerprint(fresh));
});

test('a closed door cuts the route, an open one restores it', () => {
  // Two rooms joined by one door in a wall along z = 12.
  const [positions, indices] = level(24, [
      [0, 10, 11.5, 12.5],
      [13, 24, 11.5, 12.5],
    ]),
    world = new TiledNavMesh(positions, indices, { ...settings, tileSize: 16 }),
    from = [2, 0, 2],
    to = [2, 0, 22];
  assert.ok(world.path(from, to));
  const door = world.addObstacle({ min: [10, 0, 11.5], max: [13, 3, 12.5] });
  assert.ok(world.path(from, to), 'the old polygons serve until update');
  world.update();
  assert.equal(world.path(from, to), null);
  world.removeObstacle(door);
  world.update();
  assert.ok(world.path(from, to));
});

test('a built wall joins the level and leaves it', () => {
  const [positions, indices] = level(24),
    world = new TiledNavMesh(positions, indices, { ...settings, tileSize: 16 }),
    wall = [[], []];
  addBox(wall[0], wall[1], [0, 24, 11.5, 12.5]);
  const id = world.addGeometry(wall[0], wall[1]);
  world.update();
  assert.equal(world.path([2, 0, 2], [2, 0, 22]), null);
  assert.equal(world.removeGeometry(id), true);
  assert.equal(world.removeGeometry(id), false);
  world.update();
  assert.ok(world.path([2, 0, 2], [2, 0, 22]));
});

test('a mesh added below or beyond the level builds new tiles', () => {
  const [positions, indices] = level(16),
    world = new TiledNavMesh(positions, indices, { ...settings, tileSize: 32 }),
    tiles = [...world.tileList()].length,
    annex = [
      [16, -1, 0, 40, -1, 0, 40, -1, 16, 16, -1, 16],
      [0, 2, 1, 0, 3, 2],
    ];
  world.addGeometry(annex[0], annex[1]);
  world.update();
  assert.ok([...world.tileList()].length > tiles);
  assert.ok(world.locate([30, -1, 8]) >= 0);
});

test('update spreads a big change over frames', () => {
  const [positions, indices] = level(32),
    world = new TiledNavMesh(positions, indices, { ...settings, tileSize: 16, deferred: true });
  assert.equal(world.polygonCount, 0);
  const total = world.pendingTiles;
  assert.ok(total >= 64);
  assert.equal(world.update(3), 3);
  assert.equal(world.pendingTiles, total - 3);
  assert.equal(world.update(0), 0);
  world.update();
  assert.equal(world.pendingTiles, 0);
  assert.ok(world.path([1, 0, 1], [31, 0, 31]));
});

test('off-mesh links survive the rebuild of the tiles under them and sleep while covered', () => {
  const positions = [0, 0, 0, 12, 0, 0, 12, 0, 12, 0, 0, 12, 14, 0, 0, 26, 0, 0, 26, 0, 12, 14, 0, 12],
    indices = [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6],
    world = new TiledNavMesh(positions, indices, { ...settings, tileSize: 32 }),
    from = [2, 0, 6],
    to = [24, 0, 6];
  assert.equal(world.path(from, to), null);
  const id = world.addOffMeshLink([11, 0, 6], [15, 0, 6]);
  assert.deepEqual(world.route(from, to).offMesh, [1]);
  const box = world.addObstacle({ min: [10, 0, 5], max: [12, 3, 7] });
  world.update();
  assert.equal(world.path(from, to), null);
  world.removeObstacle(box);
  world.update();
  assert.deepEqual(world.route(from, to).offMesh, [1]);
  assert.equal(world.removeOffMeshLink(id), true);
  assert.equal(world.path(from, to), null);
});

test('a crowd walks across tiles, replans when a door shuts, and leaves a wall built on it', () => {
  const [positions, indices] = level(24, [
      [0, 10, 11.5, 12.5],
      [13, 24, 11.5, 12.5],
    ]),
    world = new TiledNavMesh(positions, indices, { ...settings, tileSize: 16 }),
    crowd = new Crowd(world),
    walker = crowd.addAgent({ position: [2, 0, 2], radius: 0.3 }),
    bystander = crowd.addAgent({ position: [20, 0, 2], radius: 0.3 });
  walker.setTarget([2, 0, 22]);
  for (let i = 0; i < 40; i++) crowd.update(0.05);
  assert.equal(walker.state, 'moving');
  world.addObstacle({ min: [10, 0, 11.5], max: [13, 3, 12.5] });
  world.addObstacle({ min: [19, 0, 1], max: [21, 3, 3] });
  world.update();
  crowd.update(0.05);
  assert.equal(walker.state, 'unreachable');
  assert.ok(world.locate(bystander.position) >= 0, 'moved off the new obstacle');
  assert.ok(Math.hypot(bystander.position[0] - 20, bystander.position[2] - 2) > 1);
  for (let i = 0; i < 40; i++) crowd.update(0.05);
});

test('queries and changes check what they are given', () => {
  const [positions, indices] = level(16),
    world = new TiledNavMesh(positions, indices, { ...settings, tileSize: 16 });
  for (const tileSize of [7, 1025, 16.5])
    assert.throws(() => new TiledNavMesh(positions, indices, { tileSize }), RangeError);
  assert.throws(() => new TiledNavMesh(positions, indices, { nonsense: 1 }), RangeError);
  assert.throws(() => world.addObstacle({ min: [1, 0, 1], max: [0, 0, 0] }), RangeError);
  assert.throws(() => world.locate([Number.NaN, 0, 0]), RangeError);
  assert.throws(() => world.heightAt(1e6, 0, 0), RangeError);
  assert.throws(() => world.addOffMeshLink([1, 0, 1], [90, 0, 90]), RangeError);
  assert.equal(world.moveObstacle(77, { min: [0, 0, 0], max: [1, 1, 1] }), false);
  assert.equal(world.removeObstacle(77), false);
  assert.equal(world.path([1, 0, 1], [90, 0, 90]), null);
  assert.throws(() => new TiledNavMesh([0, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 2], settings), /failed/i);
  world.dispose();
  world.dispose();
  assert.throws(() => world.update(), /disposed/);
});

test('a door in a wall on a tile line joins the tiles either side', () => {
  // The wall starts on the line x = 32, so the door's cells reach that line in a notch one cell deep, less than the
  // simplification tolerance. Regression: the notch was simplified away and the two tiles never met.
  const [positions, indices] = level(64, [
      [32, 32.5, 0, 20],
      [32, 32.5, 23, 64],
    ]),
    world = new TiledNavMesh(positions, indices, {
      cs: 0.5,
      ch: 0.1,
      walkableRadius: 1,
      walkableHeight: 10,
      tileSize: 16,
    });
  assert.ok(world.route([5, 0, 21], [50, 0, 21]));
  assert.ok(world.route([50, 0, 5], [5, 0, 50]));
});
