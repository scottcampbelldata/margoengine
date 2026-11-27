import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { FiniteQuayWake } from '../../dist/loads.js';
import { WAKE_SOURCE_LAYOUT } from '../../dist/sea.js';
import { bakeWakeWaterplane, HullSolver } from '../../dist/seakeeping.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

function prism(outline, bottom = -1, top = 1) {
  const n = outline.length;
  const vertices = [bottom, top].flatMap((y) => outline.flatMap(([x, z]) => [x, y, z]));
  const indices = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, i + n, j + n, i, j + n, j);
  }
  for (let i = 1; i < n - 1; i++) indices.push(0, i, i + 1, n, i + 1 + n, i + n);
  return { vertices, indices };
}

const box = prism([
  [-1.25, -1.5],
  [2.75, -1.5],
  [2.75, 0.5],
  [-1.25, 0.5],
]);
const norm = ([a, b]) => Math.hypot(a, b);
const product = ([a, b], [u, v]) => [a * u - b * v, a * v + b * u];

function moments({ nodes }) {
  const result = [0, 0, 0];
  for (let i = 0; i < nodes.length; i += 3) {
    const [x, z, area] = nodes.subarray(i, i + 3);
    assert.ok(area > 0);
    result[0] += area;
    result[1] += x * area;
    result[2] += z * area;
  }
  return result;
}

function modal({ nodes }, kx, kz, ux, uz) {
  const result = [0, 0];
  for (let i = 0; i < nodes.length; i += 3) {
    const [x, z, area] = nodes.subarray(i, i + 3);
    const phase = kx * x + kz * z;
    const weight = area * (1 + ux * x + uz * z);
    result[0] += weight * Math.cos(phase);
    result[1] += weight * Math.sin(phase);
  }
  return result;
}

function interval(k, centre, half) {
  const a = k * half;
  const phase = [Math.cos(k * centre), Math.sin(k * centre)];
  const area = (2 * Math.sin(a)) / k;
  return [product(phase, [area, 0]), product(phase, [centre * area, (2 * (Math.sin(a) - a * Math.cos(a))) / k ** 2])];
}

test('waterplane nodes preserve displaced volume and first moments and converge at a frozen oblique mode', () => {
  const k = (2 * Math.PI) / 0.95;
  const kx = k * Math.sqrt(2 / 3);
  const kz = -k / Math.sqrt(3);
  const ux = 0.31;
  const uz = -0.27;
  const [sx, mx] = interval(kx, 0.75, 2);
  const [sz, mz] = interval(kz, -0.5, 1);
  const natural = product(sx, sz);
  const pitch = product(mx, sz);
  const roll = product(sx, mz);
  const exact = natural.map((v, i) => v + ux * pitch[i] + uz * roll[i]);
  const errors = [];
  for (const [maxPanelSize, rows] of [
    [1, 128],
    [0.5, 512],
    [0.25, 2048],
  ]) {
    const bake = bakeWakeWaterplane(box, 0, { maxPanelSize, maxRows: rows });
    assert.equal(bake.waterline, 0);
    assert.equal(bake.nodes.length, 3 * rows);
    for (const [got, expected] of moments(bake).map((v, i) => [v, [8, 6, -4][i]]))
      assert.ok(Math.abs(got - expected) < 2e-13);
    errors.push(norm(modal(bake, kx, kz, ux, uz).map((v, i) => v - exact[i])));
  }
  assert.ok(errors[0] > 1e-5 && errors[1] < errors[0] / 80 && errors[2] < errors[1] / 80, errors.join(', '));
  assert.ok(errors[2] < 1e-8);
});

test('the trapezoidal waterplane integrates affine motion exactly and leaves a disconnected gap dry', () => {
  const wedge = prism([
    [0, -1],
    [2, -2],
    [2, 1.5],
    [0, 0.5],
  ]);
  const detached = prism([
    [0, 3],
    [2, 3],
    [2, 4],
    [0, 4],
  ]);
  const offset = wedge.vertices.length / 3;
  const mesh = {
    vertices: [...wedge.vertices, ...detached.vertices],
    indices: [...wedge.indices, ...detached.indices.map((i) => i + offset)],
  };
  const bake = bakeWakeWaterplane(mesh, 0, { maxPanelSize: 0.75 });
  for (let i = 1; i < bake.nodes.length; i += 3) assert.ok(bake.nodes[i] <= 1.5 || bake.nodes[i] >= 3);
  const expected = [7, 23 / 3, 23 / 4];
  for (const [got, want] of moments(bake).map((v, i) => [v, expected[i]])) assert.ok(Math.abs(got - want) < 2e-13);
  const reordered = { ...mesh, indices: [] };
  for (let i = mesh.indices.length - 3; i >= 0; i -= 3)
    reordered.indices.push(mesh.indices[i + 1], mesh.indices[i + 2], mesh.indices[i]);
  assert.deepEqual(bakeWakeWaterplane(reordered, 0, { maxPanelSize: 0.75 }), bake);
});

test('waterplane baking handles reference cuts on a flat cap and rejects invalid bounds before allocating', () => {
  assert.equal(bakeWakeWaterplane(box, -2, { maxPanelSize: 1 }).nodes.length, 0);
  assert.throws(() => bakeWakeWaterplane(undefined, 0, { maxPanelSize: 1 }), {
    code: 'state',
    message: /Pass vertex triples/,
  });
  const invalidIndex = Array.from(box.indices);
  invalidIndex[0] = box.vertices.length;
  assert.throws(() => bakeWakeWaterplane({ vertices: box.vertices, indices: invalidIndex }, 0, { maxPanelSize: 1 }), {
    code: 'state',
    message: /Use triangle indices/,
  });
  assert.deepEqual(moments(bakeWakeWaterplane(box, 1, { maxPanelSize: 1 })).map(Math.round), [8, 6, -4]);
  assert.throws(() => bakeWakeWaterplane(box, 0, { maxPanelSize: 0.5, maxRows: 511 }), {
    name: 'MargoError',
    code: 'state',
    message: /Increase.*row budget/,
  });
  for (const maxPanelSize of [0, -1, NaN, Infinity])
    assert.throws(() => bakeWakeWaterplane(box, 0, { maxPanelSize }), {
      name: 'MargoError',
      code: 'state',
      message: /positive panel spacing/,
    });
  const open = { ...box, indices: [0, 4, 5] };
  assert.throws(() => bakeWakeWaterplane(open, 0, { maxPanelSize: 1 }), {
    name: 'MargoError',
    code: 'state',
    message: /Close the hull waterplane/,
  });
});

test('a baked waterplane replaces only the posed surface-motion rows and keeps the wake ports replayable', async () => {
  await Physics.load();
  const density = 1024;
  const dt = 1 / 60;
  const frameRate = { num: 60, den: 1 };
  const mesh = prism([
    [-2, -1],
    [2, -1],
    [2, 1],
    [-2, 1],
  ]);
  const world = new PhysicsWorld({ rate: frameRate, memory: worldMemory(false) });
  using physics = new Physics(null, { arena: world.arena, fixedTimestep: dt, substeps: 1 });
  const colliders = { shape: 'box', halfExtents: [2, 1, 1], mass: 8 * density };
  const velocity = [1, -0.25, 0];
  const spin = [0.125, 0, 0.25];
  const a = physics.addBody(null, { linearVelocity: velocity, angularVelocity: spin, colliders });
  const b = physics.addBody(null, { position: [7, 0, 0], linearVelocity: [0, -0.125, 0], colliders });
  const baked = bakeWakeWaterplane(mesh, 0, { maxPanelSize: 0.5, maxRows: 512 });
  const rows = baked.nodes.length / 3;
  const radius = 0.125;
  const hull = new HullSolver('hull', { minimumRadius: 0.6, advance: true });
  const wake = new FiniteQuayWake('wake', { surface: hull.wakeSourceField });
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [
        { row: a.row, mesh, wakeWaterplane: { plane: baked, radius } },
        { row: b.row, mesh },
      ],
      stations: 4,
      sea: { density, elevation: () => 0 },
      addedMass: false,
      drag: false,
      diffraction: false,
      drift: false,
      radiation: false,
      rollDamping: false,
      greenWater: false,
      slamming: false,
    })
    .add(wake, { cells: [64, 32], cellSize: 0.5, origin: [-16, -8], depths: [0, 2, 4], density })
    .couple(['hull', 'wake', 'rigid'], 'staggered');
  const zero = world.takeSnapshot();
  baked.nodes.fill(Number.NaN);
  world.advance(1);

  const { region } = world.fields.port(hull.wakeSourceField.name);
  assert.equal(region.layout, WAKE_SOURCE_LAYOUT);
  const words = regionWords(world.memory, region);
  const records = Array.from({ length: words.length / 5 }, (_, i) => words.subarray(i * 5, i * 5 + 5));
  assert.equal(records.length, rows + 5 + 8 + 5);
  const [posed, advance, legacy, idle] = [
    records.slice(0, rows),
    records.slice(rows, rows + 5),
    records.slice(rows + 5, rows + 13),
    records.slice(rows + 13),
  ];
  const totals = (samples) =>
    samples.reduce(([Q, X, Z], [x, z, _r, _p, vol]) => [Q + vol, X + x * vol, Z + z * vol], [0, 0, 0]);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 4e-12, `${a} does not match ${b}`);
  for (const [_x, _z, r, p, v] of posed) assert.ok(r === radius && p === 0 && Number.isFinite(v));
  const exact = [8 * 0.25 * dt, -spin[2] * ((2 * 4 ** 3) / 12) * dt, spin[0] * ((4 * 2 ** 3) / 12) * dt];
  for (const [i, value] of totals(posed).entries()) close(value, exact[i]);
  const [advanceNet, advanceMoment] = totals(advance);
  close(advanceNet, 0);
  close(advanceMoment, 8 * dt);
  for (const [_x, _z, r, p] of legacy) assert.ok(r >= 0.6 && p === 0);
  close(totals(legacy)[0], 8 * 0.125 * dt);
  assert.ok(idle.every((row) => row.every((x) => x === 0)));
  close(
    wake.heights().reduce((sum, v) => sum + v * 0.25, 0),
    8 * (0.25 + 0.125) * dt,
  );
  const hash = world.hash();
  world.restoreSnapshot(zero.bytes);
  world.advance(1);
  assert.equal(world.hash(), hash);
});
