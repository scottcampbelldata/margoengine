import assert from 'node:assert/strict';
import test from 'node:test';
import { landslideImpulse, TsunamiSolver } from '../dist/tsunami.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };

async function make(options, gravity) {
  const tsunami = await TsunamiSolver.load();
  const world = new PhysicsWorld({ rate, gravity }).add(tsunami, options);
  return { world, tsunami };
}

function close(actual, expected, limit) {
  assert.ok(Math.abs(actual - expected) <= limit, `${actual} vs ${expected}, bound ${limit}`);
}

function balance(tsunami, steps) {
  const b = tsunami.budget;
  const expected = b.initialVolume + b.admittedSourceVolume - b.boundaryExportVolume;
  close(b.storedVolume, expected, 64 * steps * Number.EPSILON * Math.max(1, expected));
}

test('TsunamiSolver: lake at rest is well-balanced over rough terrain with wet and dry cells', async () => {
  const nx = 16;
  const nz = 5;
  const bed = Array.from({ length: nx * nz }, (_, i) => (i % nx) / 8 - 1 + (Math.floor(i / nx) % 2) / 16);
  const { world, tsunami } = await make({ cells: [nx, nz], spacing: 0.25, bathymetry: bed });
  world.advance(120);
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const b = bed[x + z * nx];
      const sample = tsunami.sample(x, z);
      close(sample.depth, Math.max(0, -b), 120 * 32 * Number.EPSILON);
      assert.ok(sample.depth >= 0);
      for (const discharge of sample.discharge) close(discharge, 0, 120 * 32 * Number.EPSILON);
      if (b >= 0) assert.equal(sample.firstWet, -1);
    }
  }
  balance(tsunami, 120);
});

test('TsunamiSolver refuses malformed or unrepresentable grids with coded corrections', async () => {
  const tsunami = await TsunamiSolver.load();
  const base = { cells: [4, 3], spacing: 0.25, bathymetry: -2 };
  const cases = [
    [{ cells: null }, /two positive whole cell counts/],
    [{ origin: { length: 2, 0: Infinity, 1: 0 } }, /two finite coordinates/],
    [{ origin: [2 ** 53, 0] }, /nearby origin cell/],
    [{ spacing: Number.MIN_VALUE }, /positive finite value/],
    [{ spacing: 1e200 }, /positive finite value/],
    [{ bathymetry: null }, /one value per cell/],
    [{ open: { length: 4 } }, /four booleans/],
    [{ bathymetry: -0.25, dischargeX: Number.MAX_VALUE }, /Reduce discharge or increase the wet depth/],
    [{ cells: [2, 1], spacing: 1e154, bathymetry: 0, surface: 1e-3 }, /initial wet land area/],
    [{ cells: [1, 1], spacing: 1, bathymetry: 1e308, seaLevel: -1e308, surface: 1e308 + 2e292 }, /initial run-up/],
  ];
  for (const [override, correction] of cases) {
    assert.throws(() => new PhysicsWorld({ rate }).add(tsunami, { ...base, ...override }), {
      name: 'MargoError',
      code: 'state',
      message: correction,
    });
  }
  const world = new PhysicsWorld({ rate }).add(tsunami, base, [400_000, 0, -700_000]);
  for (const out of [null, [], new Float64Array(2)]) {
    assert.throws(() => tsunami.travelTimes([0, 0], out), {
      code: 'state',
      message: /Float64Array with one value per cell/,
    });
  }
  world.shiftOrigin([400_000, 0, -700_000]);
  world.advance(120);
  assert.deepEqual(tsunami.exportPorts(120)[0].cell, [0, 0, 0]);
  assert.deepEqual(tsunami.sample(0, 0), {
    bed: -2,
    height: 0,
    depth: 2,
    discharge: [0, 0],
    peakDepth: 2,
    firstWet: 0,
  });
  balance(tsunami, 120);
});

test('landslideImpulse rejects a nonrepresentable derived impulse', () => {
  assert.throws(() => landslideImpulse({ depth: 1e-200, speed: 2, thickness: 1, width: 1, mass: 1, angle: 0 }), {
    code: 'state',
    message: /slide impulse product.*Use a finite value/,
  });
});

test('TsunamiSolver supplies live dry and inundated coastal cells and replays the same surface', async () => {
  const nx = 80;
  const spacing = 0.125;
  const bathymetry = Array.from({ length: nx }, (_, i) => Math.max(-1, ((i + 0.5) * spacing) / 3 - 2));
  const surface = bathymetry.map((_, i) => {
    const distance = ((i + 0.5) * spacing - 3) / 2;
    return 0.3 * Math.max(0, 1 - distance * distance) ** 2;
  });
  const { world, tsunami } = await make({
    cells: [nx, 1],
    spacing,
    origin: [-4, -2],
    bathymetry,
    surface,
    dischargeX: surface.map((height) => Math.sqrt(9.80665) * height),
  });
  const source = tsunami.surfaceSource();
  assert.deepEqual(source.shape, { columns: nx, rows: 1, width: 10, depth: spacing, centre: [1, -1.9375] });
  const row = { surface: 0, depth: 0, velocity: [0, 0] };
  const shore = 48;
  const x = -4 + (shore + 0.5) * spacing;
  const z = -2 + spacing / 2;
  assert.strictEqual(source.sample(x, z, row), row);
  assert.equal(row.surface, bathymetry[shore]);
  assert.deepEqual(row.velocity, [0, 0]);
  assert.equal(row.depth, 0);
  const start = world.takeSnapshot();
  world.advance(100);
  source.sample(x, z, row);
  const wet = tsunami.sample(shore, 0);
  assert.ok(wet.depth > 0);
  assert.deepEqual(row, {
    surface: wet.height,
    depth: wet.depth,
    velocity: [wet.discharge[0] / wet.depth, wet.discharge[1] / wet.depth],
  });
  const expected = structuredClone(row);
  const hash = world.hash();
  world.restoreSnapshot(start.bytes);
  assert.equal(source.sample(x, z, row).depth, 0);
  world.advance(100);
  assert.equal(world.hash(), hash);
  assert.deepEqual(source.sample(x, z, row), expected);
  balance(tsunami, 100);
});

test('TsunamiSolver: wetting fan tracks Ritter’s shallow-water benchmark within its cell-slope bound', async () => {
  const nx = 200;
  const dx = 0.025;
  const split = 2.5;
  const top = Array.from({ length: nx }, (_, i) => ((i + 0.5) * dx < split ? 1 : 0));
  const { world, tsunami } = await make({ cells: [nx, 1], spacing: dx, bathymetry: 0, surface: top });
  const frames = 12;
  const t = frames / rate.num;
  const g = -world.gravity[1];
  const c0 = Math.sqrt(g);
  world.advance(frames);
  const bound = 2 * dx * ((2 * c0) / (3 * g * t));
  for (let i = 0; i < nx; i++) {
    const xi = ((i + 0.5) * dx - split) / t;
    const expected = xi < -c0 ? 1 : xi > 2 * c0 ? 0 : ((2 * c0 - xi) / 3) ** 2 / g;
    const actual = tsunami.sample(i, 0);
    assert.ok(actual.depth >= 0);
    close(actual.depth, expected, bound);
  }
  assert.ok(tsunami.sample(125, 0).firstWet > 0);
  balance(tsunami, frames);
});

test('TsunamiSolver: small-amplitude travel follows sqrt(gh), with matching static eikonal travel', async () => {
  const nx = 180;
  const dx = 0.25;
  const depth = 4;
  const start = 10.125;
  const amplitude = 0.025;
  const t = 1;
  const g = 9.80665;
  const c = Math.sqrt(g * depth);
  const wave = Array.from({ length: nx }, (_, i) => amplitude * Math.exp(-((((i + 0.5) * dx - start) / 1.2) ** 2)));
  const { world, tsunami } = await make({
    cells: [nx, 1],
    spacing: dx,
    bathymetry: -depth,
    surface: wave,
    dischargeX: wave.map((a) => c * a),
  });
  const travel = tsunami.travelTimes([40, 0]);
  close(travel[100], ((100 - 40) * dx) / c, 100 * Number.EPSILON);
  world.advance(t * rate.num);
  let peak = 0;
  let at = 0;
  for (let i = 0; i < nx; i++) {
    const h = tsunami.sample(i, 0).height;
    if (h > peak) {
      peak = h;
      at = (i + 0.5) * dx;
    }
  }
  close(at, start + c * t, 2 * dx + (amplitude / depth) * c * t);
  assert.ok(peak > amplitude / 2);
  balance(tsunami, t * rate.num);
});

test('TsunamiSolver: a natural wave runs up a dry beach without changing the closed water volume', async () => {
  const nx = 160;
  const dx = 0.1;
  const bed = Array.from({ length: nx }, (_, i) => -1 + Math.max(0, (i + 0.5) * dx - 5) / 4);
  const surface = Array.from({ length: nx }, (_, i) => {
    const distance = ((i + 0.5) * dx - 3) / 2;
    return 0.18 * Math.max(0, 1 - distance * distance) ** 2;
  });
  const { world, tsunami } = await make({
    cells: [nx, 1],
    spacing: dx,
    bathymetry: bed,
    surface,
    manning: 0.012,
    dischargeX: surface.map((a) => Math.sqrt(9.80665) * a),
  });
  const travel = tsunami.travelTimes([30, 0]);
  assert.equal(travel[100], Infinity);
  assert.equal(tsunami.sample(91, 0).firstWet, -1);
  world.advance(250);
  assert.ok(tsunami.budget.runup > 0);
  const invaded = tsunami.sample(91, 0);
  assert.ok(invaded.peakDepth > 0);
  assert.ok(invaded.firstWet > 0 && invaded.firstWet < 250 / rate.num);
  balance(tsunami, 250);
});

test('TsunamiSolver: characteristic boundaries record the long-wave export', async () => {
  const nx = 64;
  const spacing = 0.25;
  const top = Array.from({ length: nx }, (_, i) => (i > 28 && i < 48 ? 0.003 : 0));
  const { world, tsunami } = await make({
    cells: [nx, 1],
    spacing,
    bathymetry: -1,
    surface: top,
    dischargeX: top.map((h) => Math.sqrt(9.80665) * h),
    open: [true, true, false, false],
  });
  world.advance(270);
  assert.ok(tsunami.budget.boundaryExportVolume > 0);
  balance(tsunami, 270);
});

test('landslideImpulse: Heller–Hager impulse product and crest height use the paper’s nondimensional groups', () => {
  const depth = 10;
  const g = 9.80665;
  const width = 5;
  const input = {
    depth,
    gravity: g,
    width,
    mass: 1000 * width * depth * depth,
    thickness: depth,
    speed: Math.sqrt(g * depth),
    angle: Math.PI / 4,
  };
  const impulse = landslideImpulse(input);
  const expected = Math.sqrt(Math.cos((6 * input.angle) / 7));
  close(impulse.impulseProduct, expected, 32 * Number.EPSILON);
  close(impulse.amplitude, ((4 * depth) / 9) * expected ** 0.8, depth * 32 * Number.EPSILON);
});
