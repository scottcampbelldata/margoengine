import test from 'node:test';
import assert from 'node:assert/strict';
import { NavMesh } from '../dist/index.js';
import { Navigation, buildNavMesh } from '../dist/build.js';

// A 9 x 9 grid of 2 x 2 floor tiles over -9..9; `hole` drops the centre 3 x 3 tiles, `corridorL` keeps only the
// x = -9..-7 column and the z = 7..9 row.
const present = (scene, i, j) =>
  scene === 'hole' ? !(i >= 3 && i <= 5 && j >= 3 && j <= 5) : scene === 'corridorL' ? i === 0 || j === 8 : true;
function tiles(scene) {
  const positions = [],
    indices = [];
  for (let i = 0; i < 9; i++)
    for (let j = 0; j < 9; j++) {
      if (!present(scene, i, j)) continue;
      const x = -9 + 2 * i,
        z = -9 + 2 * j,
        base = positions.length / 3;
      positions.push(x, 0, z, x + 2, 0, z, x + 2, 0, z + 2, x, 0, z + 2);
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  return [positions, indices];
}
/** Distance in XZ from (x, z) to the nearest point that is not floor. */
function clearance(scene, x, z) {
  let d = Math.min(x + 9, 9 - x, z + 9, 9 - z);
  for (let i = 0; i < 9; i++)
    for (let j = 0; j < 9; j++) {
      if (present(scene, i, j)) continue;
      const x0 = -9 + 2 * i,
        z0 = -9 + 2 * j,
        dx = Math.max(x0 - x, 0, x - x0 - 2),
        dz = Math.max(z0 - z, 0, z - z0 - 2);
      d = Math.min(d, Math.hypot(dx, dz));
    }
  return d;
}
const length = (path) =>
  path.reduce(
    (sum, p, i) => (i ? sum + Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y, p.z - path[i - 1].z) : sum),
    0,
  );

// Recorded from the previous solver (scene, radius vx, start, end, point count, length, first, last). Binding:
// null or not, first/last within one cell (and y within ch), length within 3%; corner choice is not binding.
const RECORDED = [
  ['plane', 0, [-5, 0, -5], [5, 0, 5], 2, 14.1421, [-5, 0, -5], [5, 0, 5]],
  ['plane', 0, [-8, 0, 0], [8, 0, 0], 2, 16, [-8, 0, 0], [8, 0, 0]],
  ['plane', 0, [-8, 0, -8], [8, 0, 8], 2, 22.6274, [-8, 0, -8], [8, 0, 8]],
  ['plane', 0, [-8.5, 0, -8.5], [-8.5, 0, -8.5], 1, 0, [-8.5, 0, -8.5], [-8.5, 0, -8.5]],
  ['plane', 0, [-8.5, 0.5, -8.5], [8.5, 0.5, 8.5], 2, 24.0416, [-8.5, 0.5, -8.5], [8.5, 0.5, 8.5]],
  ['plane', 0, [-20, 0, -20], [5, 0, 5], null, null, null, null],
  ['plane', 0, [0, 0, 0], [8.5, 0, 8.5], 2, 12.0208, [0, 0, 0], [8.5, 0, 8.5]],
  ['plane', 2, [-5, 0, -5], [5, 0, 5], 2, 14.1421, [-5, 0, -5], [5, 0, 5]],
  ['plane', 2, [-8, 0, 0], [8, 0, 0], 2, 16, [-8, 0, 0], [8, 0, 0]],
  ['plane', 2, [-8, 0, -8], [8, 0, 8], 2, 22.6274, [-8, 0, -8], [8, 0, 8]],
  ['plane', 2, [-8.5, 0, -8.5], [-8.5, 0, -8.5], 1, 0, [-8.25, 0.1, -8.25], [-8.25, 0.1, -8.25]],
  ['plane', 2, [-8.5, 0.5, -8.5], [8.5, 0.5, 8.5], 2, 23.3345, [-8.25, 0.1, -8.25], [8.25, 0.1, 8.25]],
  ['plane', 2, [-20, 0, -20], [5, 0, 5], null, null, null, null],
  ['plane', 2, [0, 0, 0], [8.5, 0, 8.5], 2, 11.6677, [0, 0, 0], [8.25, 0.1, 8.25]],
  ['hole', 0, [-5, 0, -5], [5, 0, 5], 3, 16.6793, [-5, 0, -5], [5, 0, 5]],
  ['hole', 0, [-8, 0, 0], [8, 0, 0], 5, 17.8471, [-8, 0, 0], [8, 0, 0]],
  ['hole', 0, [-8, 0, -8], [8, 0, 8], 3, 24.2937, [-8, 0, -8], [8, 0, 8]],
  ['hole', 0, [-8.5, 0, -8.5], [-8.5, 0, -8.5], 1, 0, [-8.5, 0, -8.5], [-8.5, 0, -8.5]],
  ['hole', 0, [-8.5, 0.5, -8.5], [8.5, 0.5, 8.5], 3, 25.6277, [-8.5, 0.5, -8.5], [8.5, 0.5, 8.5]],
  ['hole', 0, [-20, 0, -20], [5, 0, 5], null, null, null, null],
  ['hole', 0, [0, 0, 0], [8.5, 0, 8.5], null, null, null, null],
  ['hole', 2, [-5, 0, -5], [5, 0, 5], 4, 17.3966, [-5, 0, -5], [5, 0, 5]],
  ['hole', 2, [-8, 0, 0], [8, 0, 0], 4, 18.6054, [-8, 0, 0], [8, 0, 0]],
  ['hole', 2, [-8, 0, -8], [8, 0, 8], 4, 24.76, [-8, 0, -8], [8, 0, 8]],
  ['hole', 2, [-8.5, 0, -8.5], [-8.5, 0, -8.5], 1, 0, [-8.25, 0.1, -8.25], [-8.25, 0.1, -8.25]],
  ['hole', 2, [-8.5, 0.5, -8.5], [8.5, 0.5, 8.5], 4, 25.4053, [-8.25, 0.1, -8.25], [8.25, 0.1, 8.25]],
  ['hole', 2, [-20, 0, -20], [5, 0, 5], null, null, null, null],
  ['hole', 2, [0, 0, 0], [8.5, 0, 8.5], null, null, null, null],
  ['corridorL', 0, [-5, 0, -5], [5, 0, 5], null, null, null, null],
  ['corridorL', 0, [-8, 0, 0], [8, 0, 0], null, null, null, null],
  ['corridorL', 0, [-8, 0, -8], [8, 0, 8], 4, 30.308, [-8, 0, -8], [8, 0, 8]],
  ['corridorL', 0, [-8.5, 0, -8.5], [-8.5, 0, -8.5], 1, 0, [-8.5, 0, -8.5], [-8.5, 0, -8.5]],
  ['corridorL', 0, [-8.5, 0.5, -8.5], [8.5, 0.5, 8.5], 4, 31.3846, [-8.5, 0.5, -8.5], [8.5, 0.5, 8.5]],
  ['corridorL', 0, [-20, 0, -20], [5, 0, 5], null, null, null, null],
  ['corridorL', 0, [0, 0, 0], [8.5, 0, 8.5], null, null, null, null],
  ['corridorL', 2, [-5, 0, -5], [5, 0, 5], null, null, null, null],
  ['corridorL', 2, [-8, 0, 0], [8, 0, 0], null, null, null, null],
  ['corridorL', 2, [-8, 0, -8], [8, 0, 8], 4, 31.2119, [-8, 0, -8], [8, 0, 8]],
  ['corridorL', 2, [-8.5, 0, -8.5], [-8.5, 0, -8.5], 1, 0, [-8.25, 0.1, -8.25], [-8.25, 0.1, -8.25]],
  ['corridorL', 2, [-8.5, 0.5, -8.5], [8.5, 0.5, 8.5], 4, 31.7232, [-8.25, 0.1, -8.25], [8.25, 0.1, 8.25]],
  ['corridorL', 2, [-20, 0, -20], [5, 0, 5], null, null, null, null],
  ['corridorL', 2, [0, 0, 0], [8.5, 0, 8.5], null, null, null, null],
];
const OPTIONS = { cs: 0.25, ch: 0.1, minRegionArea: 0, mergeRegionArea: 0 };

test('generated meshes match the recorded path queries on plane, hole and L-corridor scenes', async () => {
  const built = new Map();
  for (const [scene, radius, s, e, count, recorded, first, last] of RECORDED) {
    const key = scene + radius;
    if (!built.has(key))
      built.set(key, await Navigation.create(...tiles(scene), { ...OPTIONS, walkableRadius: radius }));
    const label = `${scene} r${radius} ${s} -> ${e}`,
      path = built.get(key).path({ x: s[0], y: s[1], z: s[2] }, { x: e[0], y: e[1], z: e[2] });
    if (count === null) {
      assert.equal(path, null, label);
      continue;
    }
    assert.ok(path, label);
    if (count === 1) assert.equal(path.length, 1, label);
    if (scene === 'plane' && radius === 0 && count === 2)
      assert.equal(path.length, 2, `${label}: straight line of sight`);
    for (const [point, expected] of [
      [path[0], first],
      [path.at(-1), last],
    ]) {
      assert.ok(Math.hypot(point.x - expected[0], point.z - expected[2]) <= OPTIONS.cs, `${label}: end within a cell`);
      assert.ok(Math.abs(point.y - expected[1]) <= OPTIONS.ch + 1e-9, `${label}: end height within ch`);
    }
    const measured = length(path);
    assert.ok(Math.abs(measured - recorded) <= 0.03 * recorded + 1e-9, `${label}: length ${measured} vs ${recorded}`);
    // Every segment stays on the floor, eroded by the radius plus the dropped ledge cell, less one cell of
    // contour simplification slack.
    const margin = Math.max(0, (radius + 1) * OPTIONS.cs - OPTIONS.cs) - 1e-9;
    for (let i = 1; i < path.length; i++)
      for (let t = 0; t <= 1; t += 1 / 32) {
        const x = path[i - 1].x + t * (path[i].x - path[i - 1].x),
          z = path[i - 1].z + t * (path[i].z - path[i - 1].z);
        assert.ok(clearance(scene, x, z) >= margin, `${label}: (${x}, ${z}) leaves the walkable area`);
      }
  }
});

test('the generator returns an ordinary NavMesh of convex polygons', () => {
  const mesh = buildNavMesh(...tiles('hole'), OPTIONS);
  assert.ok(mesh instanceof NavMesh);
  assert.ok(mesh.locate([-5, 0, -5]) >= 0);
  assert.equal(mesh.locate([0, 0, 0]), -1);
  const path = mesh.path([-5, 0, -5], [5, 0, 5]);
  assert.ok(path.length >= 3);
});

test('ramps below the slope limit build and connect; steeper ramps fail with code failed', async () => {
  for (const degrees of [20, 45, 59, 61, 80]) {
    const rise = Math.tan((degrees * Math.PI) / 180),
      positions = [-5, 0, -5, 5, 10 * rise, -5, 5, 10 * rise, 5, -5, 0, 5],
      create = Navigation.create(positions, [0, 2, 1, 0, 3, 2], { ...OPTIONS, walkableRadius: 0 });
    if (degrees < 60) {
      const nav = await create,
        path = nav.path({ x: -4, y: rise, z: 0 }, { x: 4, y: 9 * rise, z: 0 });
      assert.ok(path, `${degrees} degrees`);
      // On a planar ramp the path is straight and keeps to the surface.
      assert.equal(path.length, 2);
      for (const p of path) assert.ok(Math.abs(p.y - (p.x + 5) * rise) <= 1e-4);
    } else await assert.rejects(create, (error) => error.name === 'MargoError' && error.code === 'failed');
  }
});

test('walls block, low steps are climbed, high box tops are separate', async () => {
  const positions = [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10],
    indices = [0, 2, 1, 0, 3, 2];
  const box = (x0, z0, x1, z1, height) => {
    const base = positions.length / 3,
      corners = [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z1],
      ];
    for (const [x, z] of corners) positions.push(x, 0, z);
    for (const [x, z] of corners) positions.push(x, height, z);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      indices.push(base + i, base + j, base + 4 + j, base + i, base + 4 + j, base + 4 + i);
    }
    indices.push(base + 4, base + 6, base + 5, base + 4, base + 7, base + 6);
  };
  box(-2, -2, 2, 2, 1); // 10 voxels high: a wall
  box(-8, 5, -6, 7, 0.1); // 1 voxel: a step
  const nav = await Navigation.create(positions, indices, { ...OPTIONS, walkableRadius: 1 });
  const around = nav.path({ x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 });
  assert.ok(around.length >= 3);
  for (let i = 1; i < around.length; i++)
    for (let t = 0; t <= 1; t += 1 / 32) {
      const x = around[i - 1].x + t * (around[i].x - around[i - 1].x),
        z = around[i - 1].z + t * (around[i].z - around[i - 1].z);
      assert.ok(Math.max(Math.abs(x), Math.abs(z)) >= 2, 'path crosses the box');
    }
  assert.ok(length(around) < 14, 'shortest way round, not a detour');
  assert.ok(nav.path({ x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 1 }), 'box top is walkable');
  assert.equal(nav.path({ x: 0, y: 1, z: 0 }, { x: 6, y: 0, z: 0 }), null, 'box top is not reachable from the floor');
  const step = nav.path({ x: -7, y: 0.1, z: 6 }, { x: -7, y: 0, z: -6 });
  assert.ok(step, 'the low step joins the floor');
});

test('dispose, Symbol.dispose and endpoint validation', async () => {
  const nav = await Navigation.create(...tiles('plane'), OPTIONS);
  assert.throws(() => nav.path({ x: Number.NaN, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }), RangeError);
  assert.ok(nav.path({ x: 1, y: 0, z: 1, extra: true }, { x: 2, y: 0, z: 2 }));
  const fresh = nav.path({ x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 2 });
  fresh[0].x = 99;
  assert.equal(nav.path({ x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 2 })[0].x, 1);
  const key = Symbol.dispose ?? Object.getOwnPropertySymbols(Navigation.prototype)[0];
  nav[key]();
  nav.dispose();
  assert.throws(
    () => nav.path({ x: Number.NaN, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }),
    (error) => error.name === 'MargoError' && error.code === 'disposed',
    'the disposed check comes before endpoint validation',
  );
});

test('argument errors reject the create promise, in the documented order', async () => {
  const [plane, quads] = tiles('plane'),
    floor = [-1, 0, -1, 1, 0, -1, 1, 0, 1],
    tri = [0, 2, 1];
  const cases = [
    ['tooFewPositions', [0, 0, 0], [0, 1, 2], {}, /Invalid navigation geometry/],
    ['positionsNotMultipleOf3', [...floor, 0], tri, {}, /Invalid navigation geometry/],
    ['emptyIndices', floor, [], {}, /Invalid navigation geometry/],
    ['nanPosition', [Number.NaN, ...floor.slice(1)], tri, {}, /Navigation positions must be finite/],
    ['hugeFloat', [1e39, ...floor.slice(1)], tri, {}, /Navigation positions must be finite/],
    ['indexOutOfRange', floor, [0, 1, 3], {}, /Invalid navigation indices/],
    ['fractionalIndex', floor, [0, 1, 1.5], {}, /Invalid navigation indices/],
    ['unknownOption', floor, tri, { size: 1 }, /Unsupported Recast config/],
    ['tileSize', floor, tri, { tileSize: 32 }, /Unsupported Recast config/],
    ['negativeOption', floor, tri, { walkableClimb: -1 }, /Invalid Recast config/],
    ['nanOption', floor, tri, { ch: Number.NaN }, /Invalid Recast config/],
    ['explicitUndefined', floor, tri, { cs: undefined }, /Invalid Recast config/],
    ['bvTreeNotBool', floor, tri, { buildBvTree: 1 }, /Invalid Recast config/],
    ['csZero', floor, tri, { cs: 0 }, /voxel budget or config exceeded/],
    ['slope90', floor, tri, { walkableSlopeAngle: 90 }, /voxel budget or config exceeded/],
    ['verts7', floor, tri, { maxVertsPerPoly: 7 }, /voxel budget or config exceeded/],
    ['verts2', floor, tri, { maxVertsPerPoly: 2 }, /voxel budget or config exceeded/],
    ['voxelBudget', plane, quads, { cs: 0.001 }, /voxel budget or config exceeded/],
    // First failure wins: bad geometry before bad options, bad positions before bad indices.
    ['orderGeometry', [0, 0, 0], [0, 1, 2], { tileSize: 1 }, /Invalid navigation geometry/],
    ['orderPositions', [Number.NaN, ...floor.slice(1)], [0, 1, 9], {}, /must be finite/],
    ['orderOptions', floor, tri, { tileSize: 1, cs: -1 }, /Unsupported/],
  ];
  for (const [name, positions, indices, options, message] of cases)
    await assert.rejects(
      Navigation.create(positions, indices, options),
      (error) => error instanceof RangeError && message.test(error.message),
      name,
    );
  // A zero extent passes the budget, then nothing is walkable.
  await assert.rejects(
    Navigation.create([0, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 2], {}),
    (error) => error.name === 'MargoError' && error.code === 'failed' && /cs, walkableSlopeAngle/.test(error.message),
  );
  assert.throws(() => buildNavMesh([0, 0, 0], [0, 1, 2]), RangeError);
});
