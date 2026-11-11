import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNavMesh } from '../dist/build.js';
import { decodeNavMesh, decodeTiledNavMesh, encodeNavMesh, encodeTiledNavMesh } from '../dist/codec.js';
import { TiledNavMesh } from '../dist/tiles.js';

function box(positions, indices, [x0, x1, z0, z1, height = 3]) {
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
/** A generated stand-in level: a floor with a grid of pillars. */
function level(size = 40) {
  const positions = [0, 0, 0, size, 0, 0, size, 0, size, 0, 0, size],
    indices = [0, 2, 1, 0, 3, 2];
  for (let x = 4; x + 2 < size; x += 7)
    for (let z = 4; z + 2 < size; z += 7) box(positions, indices, [x, x + 2, z, z + 2]);
  return [positions, indices];
}
const options = { cs: 0.25, ch: 0.1, walkableRadius: 2, walkableHeight: 10, walkableClimb: 3 };
const queries = (size, n = 200) => {
  const out = [];
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < n; i++)
    out.push([
      [next() * size, 0, next() * size],
      [next() * size, 0, next() * size],
    ]);
  return out;
};

test('a loaded NavMesh gives the same routes, areas, costs and links', () => {
  const [positions, indices] = level(),
    mesh = buildNavMesh(positions, indices, { ...options, areas: [{ min: [0, -1, 0], max: [20, 1, 20], area: 3 }] });
  mesh.setAreaCost(5, 4);
  mesh.setAreaCost(9, Infinity);
  mesh.addOffMeshLink([1, 0, 1], [39, 0, 39], { cost: 2, bidirectional: false });
  mesh.addOffMeshLink([1, 0, 39], [39, 0, 1], { cost: 3 });
  const bytes = encodeNavMesh(mesh),
    copy = decodeNavMesh(bytes);
  assert.equal(copy.polygonCount, mesh.polygonCount);
  for (let p = 0; p < mesh.polygonCount; p++) {
    assert.equal(copy.polygonArea(p), mesh.polygonArea(p));
    assert.equal(copy.areaCost(p), mesh.areaCost(p));
  }
  let compared = 0;
  for (const [a, b] of queries(40)) {
    const one = mesh.route(a, b),
      two = copy.route(a, b);
    assert.deepEqual(two, one);
    if (one) compared++;
  }
  assert.ok(compared > 100);
  assert.deepEqual(encodeNavMesh(copy), bytes, 'bakes to the same bytes again');
});

test('a loaded tiled mesh gives the same routes; with its level it still rebuilds', () => {
  const [positions, indices] = level(),
    world = new TiledNavMesh(positions, indices, { ...options, tileSize: 32 }),
    obstacle = world.addObstacle({ min: [20, -1, 20], max: [23, 4, 23] }),
    wall = world.addGeometry([30, 0, 0, 30.5, 0, 0, 30.5, 3, 40], [0, 1, 2]);
  world.update();
  world.addOffMeshLink([1, 0, 1], [39, 0, 39], { cost: 2 });
  const copy = decodeTiledNavMesh(encodeTiledNavMesh(world, { geometry: true })),
    route = (surface, a, b) => surface.route(a, b)?.points.map((p) => p.map((v) => +v.toFixed(6)));
  assert.equal(copy.polygonCount, world.polygonCount);
  const length = (points) =>
    points?.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - points[i - 1][0], p[2] - points[i - 1][2]) : sum), 0);
  for (const [a, b] of queries(40)) {
    const one = route(world, a, b),
      two = route(copy, a, b);
    assert.equal(two === undefined, one === undefined);
    // Stitches and polygon numbers come in another order on load; the search breaks ties by position (KB2604b).
    if (one) assert.ok(Math.abs(length(one) - length(two)) < 1e-9);
  }
  // The ids a game kept work on the copy, and it answers a change the same way.
  for (const surface of [world, copy]) {
    assert.ok(surface.removeObstacle(obstacle));
    assert.ok(surface.removeGeometry(wall));
    assert.ok(surface.update() > 0);
  }
  assert.equal(copy.polygonCount, world.polygonCount);
  let compared = 0;
  for (const [a, b] of queries(40, 50)) {
    const one = route(world, a, b),
      two = route(copy, a, b);
    assert.equal(two === undefined, one === undefined);
    if (!one) continue;
    assert.ok(Math.abs(length(one) - length(two)) < 1e-9);
    compared++;
  }
  assert.ok(compared > 15);
});

test('a tiled mesh baked without its level is smaller, answers, and refuses to change', () => {
  const [positions, indices] = level(),
    world = new TiledNavMesh(positions, indices, { ...options, tileSize: 32 }),
    bare = encodeTiledNavMesh(world),
    full = encodeTiledNavMesh(world, { geometry: true }),
    copy = decodeTiledNavMesh(bare);
  assert.ok(bare.length < full.length);
  assert.ok(copy.path([1, 0, 1], [39, 0, 39]));
  assert.throws(
    () => copy.addObstacle({ min: [0, 0, 0], max: [1, 1, 1] }),
    (error) => error.code === 'state',
  );
  assert.throws(
    () => copy.removeGeometry(1),
    (error) => error.code === 'state',
  );
  assert.ok(copy.addOffMeshLink([1, 0, 1], [39, 0, 39]) > 0, 'links need no level');
});

test('a sleeping link and a waiting tile survive the file', () => {
  const positions = [0, 0, 0, 40, 0, 0, 40, 0, 40, 0, 0, 40],
    indices = [0, 2, 1, 0, 3, 2],
    world = new TiledNavMesh(positions, indices, { ...options, tileSize: 32 }),
    near = [30, 0, 30],
    id = world.addOffMeshLink([1, 0, 1], near, { cost: 1 }),
    door = world.addObstacle({ min: [28, -1, 28], max: [32, 3, 32] });
  world.update();
  assert.equal(world.locate(near), -1, 'the link sleeps under the box');
  world.addObstacle({ min: [5, -1, 5], max: [8, 3, 8] });
  const waiting = world.pendingTiles,
    copy = decodeTiledNavMesh(encodeTiledNavMesh(world, { geometry: true }));
  assert.ok(waiting > 0);
  assert.equal(copy.pendingTiles, waiting);
  assert.ok(copy.locate([6, 0, 6]) >= 0, 'still as it stood');
  copy.removeObstacle(door);
  copy.update();
  assert.equal(copy.locate([6, 0, 6]), -1);
  assert.equal(copy.route([1, 0, 1], near).offMesh.length, 1, 'the link woke with its ground');
  assert.ok(copy.removeOffMeshLink(id));
});

test('a mesh starts empty on a given origin and fills up', () => {
  const world = new TiledNavMesh([], [], { ...options, tileSize: 16, origin: [0, 0, 0], deferred: true });
  assert.equal(world.polygonCount, 0);
  world.addGeometry([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10], [0, 2, 1, 0, 3, 2]);
  world.update();
  assert.ok(world.polygonCount > 0);
  assert.throws(
    () => new TiledNavMesh([], [], { origin: [0, 0, 0] }),
    (error) => error.code === 'failed',
  );
  assert.throws(() => new TiledNavMesh([], [], { deferred: true }), RangeError);
  assert.throws(() => new TiledNavMesh([], [], { origin: [0, Number.NaN, 0], deferred: true }), RangeError);
});

test('damage is refused with a coded error', () => {
  const [positions, indices] = level(20),
    mesh = buildNavMesh(positions, indices, options),
    world = new TiledNavMesh(positions, indices, { ...options, tileSize: 32 }),
    bytes = encodeNavMesh(mesh),
    tiled = encodeTiledNavMesh(world),
    failed = (error) => error.code === 'failed';
  assert.throws(() => decodeNavMesh(bytes.subarray(0, bytes.length - 3)), failed);
  assert.throws(() => decodeNavMesh(new Uint8Array(4)), failed);
  assert.throws(() => decodeNavMesh(tiled), failed);
  assert.throws(() => decodeTiledNavMesh(bytes), failed);
  for (const at of [0, 4, 8, 12, 20, bytes.length >> 1, bytes.length - 1]) {
    const bad = bytes.slice();
    bad[at] ^= 0x41;
    assert.throws(() => decodeNavMesh(bad), failed, `byte ${at}`);
  }
  assert.throws(() => decodeNavMesh([1, 2, 3]), TypeError);
});

test('a file with a good checksum and bad numbers is refused, not walked on', () => {
  const positions = [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10],
    bytes = encodeNavMesh(buildNavMesh(positions, [0, 2, 1, 0, 3, 2], { cs: 0.5, ch: 0.1 })),
    bad = bytes.slice(),
    view = new DataView(bad.buffer);
  // Turn the first vertex to NaN, then seal the file again.
  view.setFloat64(17, Number.NaN, true);
  let crc = -1;
  for (let i = 16; i < bad.length; i++) {
    crc ^= bad[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  view.setUint32(12, (crc ^ -1) >>> 0, true);
  assert.throws(
    () => decodeNavMesh(bad),
    (error) => error.code === 'failed',
  );
});
