import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SurfaceEnergySolver } from '@margoengine/weather/surface-energy';
import { DrainageFog } from '../../dist/drainage-fog.js';
import { TerrainBed } from '../../dist/earth.js';
import { isShared, PhysicsWorld, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const dt = 1 / rate.num;
const gravity = 9.81;
const air = 1.225;
const cp = 1005;
const latent = 2500000;

function build(solver, params, options = {}) {
  const world = new PhysicsWorld({ rate, gravity: [0, -gravity, 0], ...options });
  world.add(solver, {
    width: 1,
    depth: 1,
    spacing: [1, 1],
    drag: 0,
    entrainment: 0,
    emissivity: 0,
    settling: 0,
    ...params,
  });
  return world;
}

function near(actual, expected, bound = 256 * Number.EPSILON * Math.max(1, Math.abs(expected))) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} versus ${expected} ± ${bound}`);
}

function balancedWater({ water, entrainedWater, surfaceWater, exportedWater, deposited }) {
  return water + exportedWater + deposited - entrainedWater - surfaceWater;
}

test('radiative cooling condenses water with a conserved latent and sensible energy change', async () => {
  const fog = await DrainageFog.load();
  const temperature = 284.15,
    sky = 263.15,
    emissivity = 0.2;
  const world = build(fog, {
    emissivity,
    skyTemperature: sky,
    initialTemperature: temperature,
    initialHumidity: 1,
    secondsPerSecond: 60,
  });
  const initial = fog.read(0, 0);
  const startWater = fog.budget.water;
  world.advance(1);
  const cold = fog.read(0, 0);
  const flux = emissivity * 5.670374419e-8 * (sky ** 4 - initial.temperature ** 4);
  assert.ok(cold.temperature < temperature && cold.liquid > 0);
  near(cold.liquid + cold.vapour, initial.liquid + initial.vapour);
  near(
    cp * (cold.temperature - initial.temperature) + latent * (cold.vapour - initial.vapour),
    flux / (air * initial.depth),
    7e-11,
  );
  near(cold.extinction, (3 * air * cold.liquid) / (2 * 1000 * 8e-6));
  near(balancedWater(fog.budget), startWater);
});

test('sensible warming evaporates fog while preserving the total water inventory', async () => {
  const fog = await DrainageFog.load();
  const world = build(fog, { initialHumidity: 1, initialLiquid: 0.0001, heat: 2000, secondsPerSecond: 60 });
  const before = fog.read(0, 0),
    water = fog.budget.water;
  assert.ok(before.extinction > 0);
  world.advance(8);
  assert.ok(fog.read(0, 0).temperature > before.temperature);
  assert.equal(fog.read(0, 0).extinction, 0);
  near(fog.budget.water, water);
});

test('Stokes settling credits the ground with exactly the water lost by the fog', async () => {
  const fog = await DrainageFog.load();
  const radius = 15e-6;
  const world = build(fog, { initialHumidity: 1, initialLiquid: 0.0001, settling: 1, radius, secondsPerSecond: 60 });
  const start = fog.read(0, 0),
    water = fog.budget.water;
  const speed = (2 * 1000 * gravity * radius * radius) / (9 * 1.81e-5);
  const deposited = (air * start.depth * start.liquid * speed) / (start.depth + speed);
  world.advance(1);
  near(fog.budget.deposited, deposited);
  near(fog.read(0, 0).settling * dt, deposited);
  near(balancedWater(fog.budget), water);
});

test('real terrain steepness accelerates a dry cold layer down the resolved slope', async () => {
  const fog = await DrainageFog.load({ followTerrain: true });
  const world = new PhysicsWorld({ rate, gravity: [0, -gravity, 0] });
  const terrain = new TerrainBed();
  world.add(terrain, { columns: 3, rows: 1, width: 3, depth: 1, centre: [0, 0], elevations: (x) => -0.15 * x });
  world.add(fog, {
    width: 3,
    depth: 1,
    spacing: [1, 1],
    origin: [-1, 0],
    airTemperature: 285,
    initialTemperature: 280,
    airHumidity: 0,
    emissivity: 0,
    drag: 0,
    entrainment: 0,
  });
  world.advance(1);
  const left = fog.read(0, 0),
    mid = fog.read(1, 0),
    right = fog.read(2, 0);
  const slope = (left.ground - right.ground) * 0.5;
  assert.ok(mid.velocity[0] > 0);
  near(mid.velocity[0], ((dt * gravity * (285 - 280)) / 285) * slope);
  near(mid.velocity[1], 0);
  near(left.depth + mid.depth + right.depth, 12);
});

test('the wind carries condensate between adjacent columns while sealed boundaries conserve water', async () => {
  const fog = await DrainageFog.load();
  const temperatures = Array(8).fill(284.15);
  const world = build(fog, {
    width: 8,
    initialHumidity: 1,
    initialTemperature: temperatures,
    airTemperature: 280,
    initialLiquid: [0, 0, 0.001, 0, 0, 0, 0, 0],
    initialVelocity: [0.75, 0],
  });
  const origin = fog.read(2, 0),
    dry = fog.read(3, 0),
    start = fog.budget;
  assert.equal(dry.liquid, 0);
  world.advance(12);
  assert.ok(fog.read(3, 0).extinction > dry.extinction);
  assert.ok(fog.read(2, 0).liquid < origin.liquid);
  near(fog.budget.air, start.air);
  near(balancedWater(fog.budget), start.water);
  const optical = new Float32Array(fog.width * fog.depth * 4);
  fog.writeColumnData(optical);
  near(optical[4 * 3 + 2], Math.fround(fog.read(3, 0).extinction));
});

test('neutral entrainment imports the expected air and momentum, and an open side accounts for export', async () => {
  const flowing = await DrainageFog.load();
  const a = build(flowing, { entrainment: 0.05, windVelocity: [2, 0] });
  const start = flowing.budget;
  a.advance(1);
  const joined = 0.05 * 2 * dt;
  near(flowing.budget.entrainedAir, joined * air);
  near(flowing.read(0, 0).velocity[0], (joined * 2) / (4 + joined));
  near(flowing.budget.air - flowing.budget.entrainedAir, start.air);
  near(balancedWater(flowing.budget), start.water);
  const escaping = await DrainageFog.load();
  const b = build(escaping, { initialVelocity: [1, 0], open: { maxX: true } });
  const stored = escaping.budget;
  b.advance(1);
  near(escaping.budget.exportedAir, 4 * dt * air);
  near(escaping.read(0, 0).depth, 4 - 4 * dt);
  near(escaping.budget.air + escaping.budget.exportedAir, stored.air);
  near(balancedWater(escaping.budget), stored.water);
});

test('real surface-energy sensible heat and evaporation feed the fog registry', async () => {
  const energy = new SurfaceEnergySolver();
  const fog = await DrainageFog.load({
    heat: { field: energy.energyFluxField, stride: 5, word: 1 },
    moisture: { field: energy.waterFluxField, stride: 3 },
  });
  const world = build(fog, { airHumidity: 0.35 });
  world.add(energy, {
    shortwave: 700,
    initialTemperature: 300,
    airTemperature: 284.15,
    deepTemperature: 295,
    initialWater: 10,
    humidity: 0.35,
  });
  const initial = fog.read(0, 0),
    water = fog.budget.water;
  world.advance(60);
  assert.ok(fog.read(0, 0).temperature > initial.temperature);
  assert.ok(fog.budget.surfaceWater > 0);
  near(balancedWater(fog.budget), water);
});

test('world clock, seek and both native memory modes replay the same moist state', async () => {
  const a = await DrainageFog.load(),
    b = await DrainageFog.load();
  const create = (rate, memory, fog = a) =>
    build(
      fog,
      {
        width: 3,
        depth: 2,
        spacing: [4, 3],
        terrain: [4, 3, 2, 2, 1, 0],
        airTemperature: 285,
        initialTemperature: 283,
        initialHumidity: 1,
        emissivity: 0.2,
        initialLiquid: [0, 0.001, 0, 0, 0, 0],
        drag: 0.008,
        entrainment: 0.02,
        settling: 0.1,
        windVelocity: [0.45, -0.1],
        open: { maxX: true },
      },
      { rate, memory },
    );
  frameRateIndependent(create);
  seekEqualsContinuous(() => create({ num: 24, den: 1 }));
  const plain = worldMemory(false),
    shared = worldMemory(true);
  assert.equal(isShared(plain), false);
  assert.equal(isShared(shared), true);
  const first = create(rate, plain),
    second = create(rate, shared, b);
  first.advance(60);
  second.advance(60);
  assert.equal(first.hash(), second.hash());
});

test('both slot-free Wasm targets preserve every byte of an occupied world arena on load', async () => {
  for (const shared of [false, true]) {
    const memory = worldMemory(shared);
    const bytes = new Uint8Array(memory.buffer);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const expected = bytes.slice();
    const file = new URL(`../../dist/drainage-fog-kernel${shared ? '-shared' : ''}.wasm`, import.meta.url);
    const { instance } = await WebAssembly.instantiate(await readFile(file), { env: { memory } });
    assert.equal(instance.exports.__data_end.value, 0);
    assert.deepEqual(bytes, expected);
  }
});
