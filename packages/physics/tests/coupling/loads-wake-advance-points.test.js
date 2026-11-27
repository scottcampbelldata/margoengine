import assert from 'node:assert/strict';
import test from 'node:test';
import { boxGeometry } from '@margoengine/geometry';
import { Physics } from '../../dist/index.js';
import { finiteQuayPointSource, FiniteQuayWake } from '../../dist/loads.js';
import { bakeWakeAdvancePoints, bakeWakeWaterplane, HullSolver } from '../../dist/seakeeping.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';

const shape = boxGeometry(4, 2, 2);
const mesh = { vertices: shape.positions, indices: shape.indices };
const close = (got, expected, tolerance = 2e-12) =>
  assert.ok(Math.abs(got - expected) < tolerance, `${got} differs from ${expected}`);
const depth = 9.7;
function eachPoint({ nodes }, fn) {
  for (let i = 0; i < nodes.length; i += 4) fn(nodes[i], nodes[i + 1], nodes[i + 2], nodes[i + 3]);
}

test('outward faces in the same bin retain separate signs, depths and three first moments', () => {
  const shifted = { ...mesh, vertices: Float64Array.from(mesh.vertices, (v, i) => (i % 3 === 0 ? v + 10 : v)) };
  const geometry = bakeWakeAdvancePoints(shifted, 0, { depths: [0, 1], panelSizes: [20], maxRows: 4 });
  assert.equal(geometry.nodes.length / 4, 4);
  const signs = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  eachPoint(geometry, (x, z, d, area) => {
    const sum = signs[Number(area > 0)];
    sum[0] += area;
    sum[1] += x * area;
    sum[2] += z * area;
    sum[3] += d * area;
  });
  for (const [i, group] of signs.entries()) {
    const expected = i === 0 ? [-2, -16, 0, -1] : [2, 24, 0, 1];
    group.forEach((v, j) => close(v, expected[j]));
  }
});

test('point-depth geometry integrates the closed-box oblique depth mode as the panels refine', () => {
  const k = (2 * Math.PI) / 0.95;
  const kx = k * Math.sqrt(2 / 3),
    kz = k / Math.sqrt(3);
  const exact =
    (2 * Math.sin(2 * kx) * ((2 * Math.sin(kz)) / kz) * (Math.sinh(k * depth) - Math.sinh(k * (depth - 1)))) /
    (k * Math.cosh(k * depth));
  const errors = [];
  const counts = [];
  for (const width of [0.5, 0.25, 0.125, 0.0625]) {
    const intervals = 1 / width;
    const geometry = bakeWakeAdvancePoints(mesh, 0, {
      depths: Array.from({ length: intervals + 1 }, (_, i) => i * width),
      panelSizes: new Array(intervals).fill(width),
    });
    const mode = [0, 0];
    let sum = 0,
      mx = 0;
    eachPoint(geometry, (x, z, d, area) => {
      const transfer = Math.cosh(k * (depth - d)) / Math.cosh(k * depth);
      mode[0] += area * transfer * Math.cos(kx * x + kz * z);
      mode[1] += area * transfer * Math.sin(kx * x + kz * z);
      sum += area;
      mx += area * x;
    });
    close(sum, 0);
    close(mx, 8);
    counts.push(geometry.nodes.length / 4);
    errors.push(Math.hypot(mode[0], mode[1] - exact));
  }
  assert.deepEqual(counts, [16, 64, 256, 1024]);
  for (let i = 1; i < errors.length; i++) assert.ok(errors[i] < 0.32 * errors[i - 1], JSON.stringify(errors));
  assert.ok(errors.at(-1) / Math.abs(exact) < 0.01, JSON.stringify(errors));
});

test('point bake and publisher reject out-of-draft, budget and duplicate advancing settings', () => {
  assert.throws(() => bakeWakeAdvancePoints(mesh, 0, { depths: [0, 0.5], panelSizes: [1] }), /deeper edge/);
  assert.throws(() => bakeWakeAdvancePoints(mesh, 0, { depths: [0, 1], panelSizes: [0] }), /positive panel size/);
  assert.throws(() => bakeWakeAdvancePoints(mesh, 0, { depths: [0, 1], panelSizes: [0.25], maxRows: 1 }), /row budget/);
  const pointAdvance = finiteQuayPointSource('testPoints');
  assert.throws(() => new HullSolver('hull', { pointAdvance, advance: true }), /one advancing wake mode/);
  assert.throws(() => new HullSolver('hull', { pointAdvance, submergedAdvance: [0, 1] }), /one advancing wake mode/);
  assert.throws(
    () => new HullSolver('hull', { pointAdvance: { ...pointAdvance, quantity: 'seaSource' } }),
    /finiteQuayPointSource/,
  );
});

test('a live hull publishes phased advancing and heaving sources separately and replays finite volume and work', async () => {
  await Physics.load();
  const density = 1024;
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  using physics = new Physics(null, { arena: world.arena, fixedTimestep: 1 / 60, substeps: 1 });
  const colliders = { shape: 'box', halfExtents: [2, 1, 1], mass: 8 * density };
  const body = physics.addBody(null, { linearVelocity: [1, -0.25, 0], colliders });
  const idle = physics.addBody(null, { position: [7, 0, 0], colliders });
  const geometry = bakeWakeAdvancePoints(mesh, 0, { depths: [0, 0.25, 0.5, 1], panelSizes: [0.5, 0.5, 1] });
  const plane = bakeWakeWaterplane(mesh, 0, { maxPanelSize: 0.5 });
  const points = finiteQuayPointSource('hullPoints');
  const hull = new HullSolver('hull', { pointAdvance: points, minimumRadius: 0.5 });
  const wake = new FiniteQuayWake('wake', { surface: hull.wakeSourceField, points });
  const count = geometry.nodes.length / 4;
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [
        {
          row: body.row,
          mesh,
          wakeWaterplane: { plane, radius: 0.125 },
          wakeAdvancePoints: { geometry, radius: 0.125 },
        },
        { row: idle.row, mesh },
      ],
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
    .add(wake, { cells: [64, 32], cellSize: 0.5, origin: [-16, -8], depths: [0, 0.25, 0.5, 0.75, 1, 2, 4], density })
    .couple(['hull', 'wake', 'rigid'], 'staggered');
  const initial = world.takeSnapshot();
  geometry.nodes.fill(Number.NaN);
  world.advance(1);
  const port = world.fields.port(points.name);
  assert.equal(port.region.layout, 1);
  const rows = regionWords(world.memory, port.region);
  assert.equal(rows.length, 5 * count);
  const first = [0, 0, 0, 0];
  for (let i = 0; i < rows.length; i += 5) {
    const [x, z, r, d, volume] = rows.subarray(i, i + 5);
    assert.ok(r === 0.125 && d > 0 && d < 1 && volume !== 0);
    first[0] += volume;
    first[1] += x * volume;
    first[2] += z * volume;
    first[3] += d * volume;
  }
  first.forEach((v, i) => close(v, [0, 8 / 60, 0, 0][i]));
  close(
    wake.heights().reduce((sum, v) => sum + v * 0.25, 0),
    (8 * 0.25) / 60,
  );
  close(wake.energy(), wake.work().joules, 1e-9);
  assert.ok(wake.heights().some((v) => v < 0));
  const hash = world.hash();
  world.restoreSnapshot(initial.bytes);
  world.advance(1);
  assert.equal(world.hash(), hash);
});
