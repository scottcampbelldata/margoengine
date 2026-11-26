import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed, bedVertexAreas, bedVolume } from '../../dist/earth.js';
import { SWIM_WAKE_FIELD, SwimSolver } from '../../dist/life.js';
import { GRANULAR_MPM_LAYOUT, GRANULAR_MPM_WORDS, GranularMpmSolver } from '../../dist/granular-mpm.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent } from './harness.js';

const rate = { num: 60, den: 1 };
const zero = [0, 0, 0];
const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} versus ${expected} ± ${tolerance}`);

function block(center, spacing, dimensions, material = 0) {
  const points = [];
  for (let z = 0; z < dimensions[2]; z++)
    for (let y = 0; y < dimensions[1]; y++)
      for (let x = 0; x < dimensions[0]; x++)
        points.push({
          position: [center[0] + x * spacing, center[1] + y * spacing, center[2] + z * spacing],
          volume: spacing ** 3,
          material,
        });
  return points;
}

async function attach(points, props = {}, gravity = zero, shared = false) {
  const solver = await GranularMpmSolver.load();
  const world = new PhysicsWorld({ rate, gravity, memory: worldMemory(shared) });
  world.add(solver, { points, ...props });
  return { solver, world };
}

test('isolated sparse material points follow the exact free-fall clock and conserve reference mass', async () => {
  const gravity = [0, -1.5, 0];
  const initial = [
    { position: [-300, 0.48, 171], volume: 0.00021, velocity: [0.6, 0.3, -0.2] },
    { position: [311, 0.8, -186], volume: 0.00015, velocity: [-0.2, 0.25, 0.33] },
  ];
  const { solver, world } = await attach(initial, { rate: 4 }, gravity);
  const tick = 25;
  world.advance(tick);
  const time = tick / 60;
  const dt = 1 / 960;
  assert.equal(solver.activeNodes, 54);
  for (const [index, point] of initial.entries()) {
    const value = solver.sample(index);
    for (let k = 0; k < 3; k++) {
      near(
        value.position[k],
        point.position[k] + point.velocity[k] * time + 0.5 * gravity[k] * time * (time + dt),
        1e-9,
      );
      near(value.velocity[k], point.velocity[k] + gravity[k] * time, 1e-9);
    }
    near(value.mass, 1600 * point.volume, 0);
    near(value.referenceVolume, point.volume, 0);
  }
  const [port] = solver.exportPorts(world.tick);
  assert.equal(port.region.layout, GRANULAR_MPM_LAYOUT);
  assert.equal(regionWords(world.memory, port.region).length, initial.length * GRANULAR_MPM_WORDS);
});

test('material points contact the live inclined terrain without losing mass and replay on both memories', async () => {
  const points = block([-0.1, 0.3, -0.08], 0.04, [6, 4, 5]);
  const ground = 0.09;
  const make = async (shared) => {
    const world = new PhysicsWorld({ rate, memory: worldMemory(shared) });
    const terrain = new TerrainBed();
    world.add(terrain, { rows: 2, columns: 2, width: 4, depth: 4, centre: [0, 0], elevations: (x) => ground + x / 8 });
    const solver = await GranularMpmSolver.load();
    world.add(solver, { points, bed: terrain.bed, spacing: 0.08, rate: 4, materials: [{ young: 25_000 }] });
    return { world, solver, terrain };
  };
  const plain = await make(false);
  const shared = await make(true);
  plain.world.advance(14);
  const snapshot = plain.world.takeSnapshot();
  plain.world.advance(55);
  shared.world.advance(55);
  const hash = plain.world.hash();
  assert.equal(shared.world.hash(), hash);
  plain.world.restoreSnapshot(snapshot.bytes);
  plain.world.advance(55);
  assert.equal(plain.world.hash(), hash);
  let count = 0;
  for (let i = 0; i < points.length; i++) {
    const point = plain.solver.sample(i);
    const [x, y, z] = point.position;
    const bed = plain.terrain.bed.sample(x, z);
    assert.ok(y >= bed.elevation - 0.08, JSON.stringify({ point, bed }));
    assert.ok(Math.hypot(...point.velocity) < 2);
    assert.equal(point.mass, points[i].volume * 1600);
    if (y < points[i].position[1]) count++;
  }
  assert.ok(count > points.length / 2);
});

test('material setup refuses unstable clock and out-of-range point indices with direct fixes', async () => {
  const point = { position: zero, volume: 0.001 };
  await assert.rejects(attach([point], { spacing: 0.01, rate: 0 }), /satisfy the elastic CFL bound/);
  await assert.rejects(attach([{ ...point, material: 1 }]), /Choose an existing material table index/);
  const { solver } = await attach([point]);
  assert.throws(() => solver.sample(1), /Choose an existing granular point index/);
});

test('Drucker–Prager removes conditioned shear while preserving compressed volume', async () => {
  const young = 1000;
  const density = 1600;
  const poisson = 0.2;
  const phi = Math.PI / 6;
  const shear = young / (2 * (1 + poisson));
  const lambda = (young * poisson) / ((1 + poisson) * (1 - 2 * poisson));
  const alpha = (Math.sqrt(2 / 3) * 2 * Math.sin(phi)) / (3 - Math.sin(phi));
  const strain = [-0.06, -0.01, 0.015];
  const initial = strain.map(Math.exp);
  const { world, solver } = await attach([{ position: zero, volume: 0.04 }], {
    spacing: 1,
    rate: 0,
    materials: [{ young, density, poisson, frictionAngle: phi }],
  });
  const [port] = solver.exportPorts(0);
  const data = regionWords(world.memory, port.region);
  // Manufactured one-point state. Each principal stretch lies at 15 + 4i.
  for (const [i, stretch] of initial.entries()) data[15 + 4 * i] = stretch;
  const trace = strain.reduce((sum, value) => sum + value, 0);
  // The quadratic spline reproduces the exact linear grid stress velocity of one point.
  const trial = initial.map(
    (stretch, i) => stretch * (1 - (4 * (2 * shear * strain[i] + lambda * trace)) / (density * 60 * 60)),
  );
  const logarithms = trial.map(Math.log);
  const mean = logarithms.reduce((sum, value) => sum + value, 0) / 3;
  const deviations = logarithms.map((value) => value - mean);
  const shearLimit = (-alpha * 3 * mean * (3 * lambda + 2 * shear)) / (2 * shear);
  const norm = Math.hypot(...deviations);
  assert.ok(norm > shearLimit);
  world.advance(1);
  const after = regionWords(world.memory, port.region);
  for (const [i, dev] of deviations.entries())
    near(after[15 + 4 * i], Math.exp(mean + (dev * shearLimit) / norm), 8e-12);
  near(solver.sample(0).logPlasticVolume, 0, 8e-12);
});

test('the snow material clamps elastic snow stretches and retains the rejected compaction', async () => {
  const young = 1000;
  const density = 400;
  const poisson = 0.2;
  const shear = young / (2 * (1 + poisson));
  const lambda = (young * poisson) / ((1 + poisson) * (1 - 2 * poisson));
  const initial = [0.9, 0.97, 1.03];
  const compression = 0.025;
  const extension = 0.0075;
  const { world, solver } = await attach([{ position: zero, volume: 0.04 }], {
    spacing: 1,
    rate: 0,
    materials: [{ kind: 'snow', young, density, poisson }],
  });
  const [port] = solver.exportPorts(0);
  const data = regionWords(world.memory, port.region);
  for (const [i, stretch] of initial.entries()) data[15 + 4 * i] = stretch;
  const j = initial.reduce((product, stretch) => product * stretch, 1);
  const trial = initial.map((stretch) => {
    const stress = 2 * shear * (stretch - 1) * stretch + lambda * (j - 1) * j;
    return stretch * (1 - (4 * stress) / (density * 60 * 60));
  });
  const elastic = trial.map((stretch) => Math.max(1 - compression, Math.min(1 + extension, stretch)));
  world.advance(1);
  const after = regionWords(world.memory, port.region);
  for (const [i, stretch] of elastic.entries()) near(after[15 + 4 * i], stretch, 8e-12);
  near(
    solver.sample(0).logPlasticVolume,
    trial.reduce((sum, value, i) => sum + Math.log(value / elastic[i]), 0),
    8e-12,
  );
  assert.ok(solver.sample(0).logPlasticVolume < 0);
});

test('the implicit inertial return satisfies the final shear law and conserves volume on both memories', async () => {
  const dt = 1 / 60;
  const young = 1000;
  const bulkDensity = 1600;
  const poisson = 0.2;
  const shear = young / (2 * (1 + poisson));
  const bulk = young / (3 * (1 - 2 * poisson));
  const grainDensity = 2500;
  const staticFriction = 0.38;
  const highRateFriction = 0.64;
  const referenceInertialNumber = 0.28;
  const original = [-0.07, -0.011, 0.026];
  const originalTrace = original.reduce((sum, value) => sum + value, 0);
  const priorPlastic = 0.004;
  const trial = original.map((strain) => {
    const stress = 2 * shear * (strain - originalTrace / 3) + bulk * originalTrace;
    const stretch = Math.exp(strain) * (1 - (4 * stress * dt * dt) / bulkDensity);
    return Math.log(stretch);
  });
  const trace = trial.reduce((sum, strain) => sum + strain, 0);
  const pressure = -bulk * trace;
  const actualPressure = pressure / Math.exp(trace + priorPlastic);
  const equivalentShear = (strains) => {
    const mean = strains.reduce((sum, value) => sum + value, 0) / 3;
    return Math.SQRT2 * shear * Math.hypot(...strains.map((strain) => strain - mean));
  };
  const trialShear = equivalentShear(trial);
  const strainTolerance = 4096 * Number.EPSILON;
  const run = async (grainDiameter, shared) => {
    const inertial = { grainDiameter, grainDensity, staticFriction, highRateFriction, referenceInertialNumber };
    const { world, solver } = await attach(
      [{ position: zero, volume: 0.04 }],
      { spacing: 1, rate: 0, materials: [{ young, density: bulkDensity, poisson, inertial }] },
      zero,
      shared,
    );
    const [port] = solver.exportPorts(0);
    const data = regionWords(world.memory, port.region);
    for (const [index, strain] of original.entries()) data[15 + 4 * index] = Math.exp(strain);
    data[26] = priorPlastic;
    const snapshot = world.takeSnapshot();
    world.advance(1);
    const after = regionWords(world.memory, port.region);
    const logStretch = [15, 19, 23].map((index) => Math.log(after[index]));
    const correctedShear = equivalentShear(logStretch);
    const plasticShearRate = (trialShear - correctedShear) / (shear * dt);
    const number = (plasticShearRate * grainDiameter) / Math.sqrt(actualPressure / grainDensity);
    const friction =
      staticFriction + ((highRateFriction - staticFriction) * number) / (referenceInertialNumber + number);
    assert.ok(plasticShearRate > 0);
    assert.ok(pressure * staticFriction < correctedShear && correctedShear < pressure * highRateFriction);
    near(correctedShear, pressure * friction, strainTolerance * 2 * shear);
    near(
      logStretch.reduce((sum, value) => sum + value, 0),
      trace,
      strainTolerance,
    );
    near(solver.sample(0).logPlasticVolume, priorPlastic, strainTolerance);
    assert.equal(solver.sample(0).mass, 64);
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(1);
    assert.equal(world.hash(), hash);
    return { correctedShear, hash };
  };
  const fine = await run(0.00035, false);
  const gravel = await run(0.042, false);
  assert.deepEqual(await run(0.00035, true), fine);
  assert.deepEqual(await run(0.042, true), gravel);
  assert.ok(gravel.correctedShear > fine.correctedShear);
});

test('the granular contact shot is independent of the presentation frame rate', async () => {
  const points = block([-0.08, 0.28, -0.04], 0.04, [3, 4, 2]);
  const solvers = await Promise.all([0, 1, 2].map(() => GranularMpmSolver.load()));
  frameRateIndependent((rate) => {
    const world = new PhysicsWorld({ rate, memory: worldMemory(false) });
    return world.add(solvers.pop(), { points, floor: 0, rate: 4, materials: [{ young: 25000 }] });
  });
});

test('the material layer produces an exact, conserved translation of persistent bed relief', async () => {
  const volume = 0.012;
  const velocity = 0.6;
  const surface = new TerrainBed();
  const solver = await GranularMpmSolver.load({ projectBed: true });
  const world = new PhysicsWorld({ rate, gravity: zero, memory: worldMemory(false) });
  world.add(surface, { columns: 2, rows: 2, width: 2, depth: 2, centre: [0, 0], elevations: () => 0.2 });
  world.add(solver, {
    points: [{ position: [-0.5, 0.35, 0.2], velocity: [velocity, 0, 0], volume }],
    bedSurface: surface.bed,
    rate: 0,
    spacing: 0.35,
    materials: [{ young: 1000 }],
  });
  world.couple([solver.id, surface.id], 'staggered');
  world.advance(4);
  const snapshot = world.takeSnapshot();
  const frame = 20;
  world.advance(frame);
  const areas = bedVertexAreas(surface.bed);
  const moved = (volume * velocity * frame) / 60;
  const top = surface.bed.elevations;
  near((top[1] - 0.2) * areas[1], -moved, 8e-9);
  near((top[4] - 0.2) * areas[4], moved, 8e-9);
  near(bedVolume(surface.bed, top, 0.2), 0, 8e-9);
  assert.ok(top[1] < 0.2 && top[4] > 0.2);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(frame);
  assert.equal(world.hash(), hash);
});

test('BB-7 the ray wake moves the granular layer and leaves a replayable bed imprint', async () => {
  const shape = { columns: 20, rows: 20, width: 0.8, depth: 0.8, centre: [0, 0] };
  const density = 1025;
  const pitch = 0.04;
  const points = block([-0.3, -0.53, -0.3], pitch, [16, 2, 16]);
  const surfaceY = -0.48;
  async function make(active, shared = false) {
    const world = new PhysicsWorld({ rate, memory: worldMemory(shared), gravity: [0, -9.80665, 0] });
    const terrain = new TerrainBed();
    const sand = await GranularMpmSolver.load({ projectBed: true, bedWakes: true });
    const swimmer = await SwimSolver.load();
    world.add(terrain, { ...shape, elevations: () => surfaceY });
    world.add(swimmer, {
      bodies: [
        {
          position: [0, -0.2, 0],
          mass: (density * Math.PI * 0.2 * 0.2) / 6,
          length: 1,
          width: 0.2,
          height: 0.2,
          wettedArea: 0,
          tail: { amplitude: 0, span: 0.16, wavelength: 0.85 },
          fins: { area: 0.05, strokeAmplitude: active ? 0.2 : 0, strokeFrequency: 1 },
          steering: [0, 1, 0],
        },
      ],
    });
    world.add(sand, {
      points,
      spacing: 0.08,
      rate: 4,
      floor: -0.56,
      bedSurface: terrain.bed,
      materials: [{ young: 25000 }],
    });
    world.couple([swimmer.id, sand.id, terrain.id], 'staggered');
    return { world, terrain, sand, swimmer };
  }

  const moving = await make(true);
  const still = await make(false);
  const shared = await make(true, true);
  moving.world.advance(1);
  const wakePort = moving.swimmer.exportPorts(moving.world.tick).find(({ field }) => field === SWIM_WAKE_FIELD.name);
  const liveWake = regionWords(moving.world.memory, wakePort.region);
  near(moving.sand.wakeImpulse[2], 0.05 * liveWake[13], 4e-14);
  assert.ok(liveWake[12] < 0);
  moving.world.advance(5);
  const snapshot = moving.world.takeSnapshot();
  moving.world.advance(45);
  still.world.advance(45);
  shared.world.advance(45);
  assert.ok(moving.sand.wakeImpulse[2] > 0);
  const a = moving.terrain.bed.elevations;
  const b = still.terrain.bed.elevations;
  const differences = Array.from(a, (value, index) => value - b[index]);
  // The real terrain port is f32. A material layer change must survive the
  // rounding of both ports; magnitude is checked by the conserved forcing
  // and analytical layer-transfer tests independently.
  const heightRounding = 2 ** -23 * Math.max(...Array.from(b, Math.abs));
  assert.ok(
    Math.min(...differences) < -heightRounding && Math.max(...differences) > heightRounding,
    JSON.stringify({
      cut: Math.min(...differences),
      deposit: Math.max(...differences),
      impulse: moving.sand.wakeImpulse,
    }),
  );
  for (let i = 0; i < points.length; i++) assert.equal(moving.sand.sample(i).mass, points[i].volume * 1600);
  const hash = moving.world.hash();
  assert.equal(shared.world.hash(), hash);
  moving.world.restoreSnapshot(snapshot.bytes);
  moving.world.advance(45);
  assert.equal(moving.world.hash(), hash);
});

test('a partly occupied jet footprint delivers its volume share once across a faster sand clock', async () => {
  const world = new PhysicsWorld({ rate, gravity: zero, memory: worldMemory(false) });
  const terrain = new TerrainBed();
  const sand = await GranularMpmSolver.load({ projectBed: true, bedWakes: true });
  const impulseX = 0.09;
  const down = 0.45;
  const height = 0.1;
  const radius = 0.12;
  const depth = 0.1;
  const volume = 0.00001;
  const reach = (height * impulseX) / down;
  const spread = radius + 0.1 * Math.hypot(height, reach);
  const jet = [-reach, height, 0, impulseX, -down, 0, radius, 1];
  let published;
  const driver = {
    id: 'held-jet',
    describe: () => ({
      id: 'held-jet',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: SWIM_WAKE_FIELD, access: 'write' }],
    }),
    init(host) {
      published = host.allocate('held-jet-row', 8 * 8, 'f64', 1);
      regionWords(host.memory, published).set(jet);
    },
    step() {},
    exportPorts(tick) {
      return [{ field: SWIM_WAKE_FIELD.name, region: published, tick, cell: zero }];
    },
    importPorts() {},
    stateRegions: () => [published],
    extraState: () => [],
  };
  world.add(driver, {});
  world.add(terrain, { columns: 2, rows: 2, width: 2, depth: 2, centre: [0, 0], elevations: () => 0 });
  world.add(sand, {
    points: [{ position: zero, volume }],
    bedSurface: terrain.bed,
    wakeDepth: depth,
    rate: 4,
    materials: [{ young: 1000 }],
  });
  world.couple([driver.id, sand.id, terrain.id], 'staggered');
  world.advance(1);
  const supportedVolume = (Math.PI * spread * spread * depth) / 6;
  const expected = (0.05 * impulseX * volume) / supportedVolume;
  near(sand.wakeImpulse[0], expected, 2e-15);
  near(sand.sample(0).mass * sand.sample(0).velocity[0], expected, 2e-15);
});
