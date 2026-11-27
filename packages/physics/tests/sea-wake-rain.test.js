import assert from 'node:assert/strict';
import test from 'node:test';
import { PrecipitationField } from '@margoengine/weather/precipitation';
import { wakeRainEquivalentDrop, wakeRainSource, wakeRainSources, WakeSolver } from '../dist/sea.js';
import { PhysicsWorld } from '../dist/world.js';

const dt = 1 / 60;
const dx = 0.003;
const cells = [96, 96];
const origin = cells.map((n) => -(n * dx) / 2);
const grid = { cells, cellSize: dx, origin };
const density = 1000;
const surfaceTension = 0.073;
const gravity = 9.81;

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} versus ${expected}, tolerance ${tolerance}`);
}

test('rain preserves deposited volume and integrates the downward impulse over actual grid cells', () => {
  const drops = [
    { x: 0.0013, z: 0.0028, diameter: 0.001, fallSpeed: 4.1 },
    { x: 0.0015, z: -0.0015, diameter: 0.008, fallSpeed: 6.3, density: 998 },
  ];
  for (const drop of drops) {
    const source = wakeRainSource(drop, grid, dt);
    const volume = (4 * Math.PI * (drop.diameter / 2) ** 3) / 3;
    const momentum = volume * (drop.density ?? density) * drop.fallSpeed;
    near(source.volume, volume, 8 * Number.EPSILON * volume);
    assert.ok(source.pressure > 0);
    let totalForce = 0;
    for (let j = 0; j < cells[1]; j++) {
      for (let i = 0; i < cells[0]; i++) {
        const r = Math.hypot(origin[0] + (i + 0.5) * dx - drop.x, origin[1] + (j + 0.5) * dx - drop.z);
        if (r < source.radius)
          totalForce += source.pressure * (0.5 + 0.5 * Math.cos((Math.PI * r) / source.radius)) * dx * dx;
      }
    }
    near(totalForce * dt, momentum, 24 * Number.EPSILON * momentum);
  }
  const gentle = wakeRainSource({ ...drops[0], fallSpeed: 0 }, grid, dt);
  assert.ok(gentle.volume > 0);
  assert.equal(gentle.pressure, 0);
  assert.throws(() => wakeRainSource({ ...drops[0], fallSpeed: -3 }, grid, dt), { code: 'state' });
  assert.throws(() => wakeRainSource({ ...drops[0], x: origin[0] }, grid, dt), { code: 'state' });
  assert.throws(() => wakeRainSource(drops[0], { ...grid, cells: null }, dt), { code: 'state' });
});

test('supplied contacts use the precipitation measurement at their own time and translated coordinates', () => {
  const wet = { rate: 4, impactRate: 700, energyFlux: 0.02 };
  const dry = { rate: 0, impactRate: 0, energyFlux: 0 };
  const drop = wakeRainEquivalentDrop(0, 0, wet);
  const volume = (Math.PI * drop.diameter ** 3) / 6;
  near(volume * wet.impactRate, wet.rate / 3_600_000, 1e-20);
  near((density * volume * drop.fallSpeed ** 2 * wet.impactRate) / 2, wet.energyFlux, 1e-15);
  assert.equal(wakeRainEquivalentDrop(0, 0, dry), undefined);
  assert.throws(() => wakeRainEquivalentDrop(0, 0, { ...wet, impactRate: 0 }), { code: 'state' });

  const sampled = [];
  const precipitation = {
    cell: [2, -1, 4],
    sample(x, y, z, t) {
      sampled.push([x, y, z, t]);
      return { rain: t < dt ? wet : dry };
    },
  };
  const first = { x: 0.007, y: 0.001, z: -0.005, time: 0.001 };
  const second = { ...first, time: dt };
  const callback = wakeRainSources({
    precipitation,
    impacts: [first, second],
    grid,
    dt,
    cell: [3, -3, 1],
    metresPerCell: 32,
  });
  assert.deepEqual(callback(1.5 * dt), []);
  const accepted = callback(0.5 * dt);
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0], wakeRainSource({ ...drop, x: first.x, z: first.z }, grid, dt));
  assert.deepEqual(callback(0.5 * dt), accepted);
  assert.deepEqual(sampled, [
    [first.x + 32, first.y - 64, first.z - 96, dt],
    [first.x + 32, first.y - 64, first.z - 96, first.time],
    [first.x + 32, first.y - 64, first.z - 96, first.time],
  ]);
});

// Independent periodic Green function for a cell-centred deposit and a single rectangular pressure pulse.
// H'' + omega² H = -k P / rho, with the drop's initial elevation volume / dx² at the origin cell.
function radialReference(row, tick, radiusCells) {
  let sum = 0;
  const [nx, nz] = cells;
  for (let j = 0; j < nz; j++) {
    const kz = (2 * Math.PI * (j <= nz / 2 ? j : j - nz)) / (nz * dx);
    for (let i = 0; i < nx; i++) {
      const kx = (2 * Math.PI * (i <= nx / 2 ? i : i - nx)) / (nx * dx);
      const k = Math.hypot(kx, kz);
      const restoring = gravity + (surfaceTension * k * k) / density;
      const omega = Math.sqrt(restoring * k);
      const a = Math.cos(omega * tick * dt);
      const b = Math.cos(omega * (tick - 1) * dt);
      const elevation = (row.volume / (dx * dx)) * a - (row.pressure / (density * restoring)) * (b - a);
      sum += elevation * Math.cos(kx * radiusCells * dx);
    }
  }
  return sum / (nx * nz);
}

test('an ATMO-04 rain contact sends a capillary ring through the live wake and replays exactly', (t) => {
  const centre = [48, 48];
  const x = origin[0] + (centre[0] + 0.5) * dx;
  const z = origin[1] + (centre[1] + 0.5) * dx;
  const precipitation = new PrecipitationField({ rate: 10, base: 1 });
  const sources = wakeRainSources({
    precipitation,
    impacts: [{ time: 0.005, x, y: 0, z }],
    grid,
    dt,
  });
  const [row] = sources(dt / 2);
  assert.deepEqual(sources(1.5 * dt), []);
  assert.equal(row.radius, dx);
  const wake = new WakeSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -gravity, 0] }).add(wake, {
    cells,
    cellSize: dx,
    sponge: 0,
    density,
    surfaceTension,
    sources,
  });
  const start = world.takeSnapshot();
  world.advance(1);
  assert.ok(wake.sample(x, z).height < 0, 'downward momentum depresses the surface even as rain adds water');
  const radii = [];
  for (const tick of [2, 6]) {
    world.advance(tick);
    const heights = wake.heights();
    near(heights.reduce((sum, height) => sum + height, 0) * dx * dx, row.volume, 5e-21);
    const line = Array.from({ length: 17 }, (_, i) => heights[centre[0] + i + cells[0] * centre[1]]);
    const peak = line.indexOf(Math.max(...line));
    const expected = line.map((_, i) => radialReference(row, tick, i));
    assert.equal(peak, expected.indexOf(Math.max(...expected)));
    assert.ok(peak > 0 && peak + 1 < line.length && line[peak] > line[peak - 1] && line[peak] > line[peak + 1]);
    for (const [i, height] of line.entries()) {
      near(height, expected[i], 2e-16);
      near(heights[centre[0] + cells[0] * (centre[1] - i)], height, 2e-16);
    }
    radii.push(peak * dx);
  }
  assert.ok(radii[1] - radii[0] > 4 * dx);
  const accepted = world.takeSnapshot().bytes;
  world.restoreSnapshot(start.bytes);
  world.advance(6);
  assert.deepEqual(world.takeSnapshot().bytes, accepted);
  t.diagnostic(JSON.stringify({ radii, volume: row.volume, pressure: row.pressure }));
});
