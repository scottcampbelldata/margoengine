import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SurfaceEnergySolver } from '@margoengine/weather/surface-energy';
import { TerrainBed } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { RainfallRunoff } from '../../dist/runoff.js';
import { Snowpack } from '../../dist/snowpack.js';
import { isShared, PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const dt = 1 / rate.num;
const freeze = 273.15;
const specificHeat = 2100;
const fusion = 333700;
const gravity = 9.81;

function near(value, expected, maxError = 256 * Number.EPSILON * Math.max(1, Math.abs(expected))) {
  assert.ok(Math.abs(value - expected) <= maxError, `${value} versus ${expected} ± ${maxError}`);
}

function worldWith(options = {}) {
  return new PhysicsWorld({ rate, gravity: [0, -gravity, 0], ...options });
}

function add(world, pack, params = {}) {
  world.add(pack, { width: 1, depth: 1, ...params });
  return pack;
}

test('snowfall stores the exact mass and compacts under its own weight', async () => {
  const world = worldWith();
  const pack = add(world, await Snowpack.load(), { snowfall: 3, freshDensity: 100, airTemperature: freeze });
  assert.equal(pack.read(0, 0).mass, 0);
  world.advance(1);
  const mass = 3 * dt;
  const viscosity = 0.007 * 100 ** 4.75;
  const settled = mass / 100 / (1 + (dt * 0.5 * mass * gravity) / viscosity);
  near(pack.read(0, 0).mass, mass);
  near(pack.read(0, 0).depth, settled);
  near(pack.read(0, 0).temperature, freeze);
  assert.equal(pack.read(0, 0).runoff, 0);
});

test('surface energy warms cold snow and only its remaining heat produces melt', async () => {
  const mass = 100;
  const coldEnergy = 5 * mass * specificHeat;
  for (const melted of [0, 10, 100]) {
    const world = worldWith();
    const pack = add(world, await Snowpack.load(), {
      layers: [{ mass, density: 250, temperature: freeze - 5, viscosity: Number.MAX_VALUE }],
      topHeat: (coldEnergy + melted * fusion) / dt,
      retention: 0,
    });
    world.advance(1);
    const snow = pack.read(0, 0);
    near(snow.mass, mass - melted);
    near(snow.runoff * dt * 1000, melted);
    near(snow.runoffHeat * dt, melted * fusion);
    near(snow.depth, (mass - melted) / 250);
    near(snow.unusedHeat, 0);
  }
});

test('wet-layer retention precedes runoff and rain refreezes with its released latent heat', async () => {
  const retainedWorld = worldWith();
  const retained = add(retainedWorld, await Snowpack.load(), {
    layers: [{ mass: 100, density: 250, temperature: freeze, liquidFraction: 0.1, viscosity: Number.MAX_VALUE }],
  });
  const pores = 90 / 250 - 90 / 917;
  near(retained.read(0, 0).liquid, 10);
  retainedWorld.advance(1);
  near(retained.read(0, 0).liquid, Math.min(10, 1000 * 0.07 * pores));
  const frozenWorld = worldWith();
  const frozen = add(frozenWorld, await Snowpack.load(), {
    layers: [{ mass: 30, temperature: freeze - 10, viscosity: Number.MAX_VALUE }],
    rain: 1 / dt,
    airTemperature: freeze,
    retention: 0,
  });
  frozenWorld.advance(1);
  near(frozen.read(0, 0).mass, 31);
  near(frozen.read(0, 0).temperature, freeze + (fusion - 30 * specificHeat * 10) / (31 * specificHeat));
  assert.equal(frozen.read(0, 0).runoff, 0);
});

test('implicit conduction agrees with the exact two-layer update and conserves enthalpy', async () => {
  const world = worldWith();
  const mass = 25,
    density = 250,
    c = mass * specificHeat;
  const pack = add(world, await Snowpack.load(), {
    layers: [-10, -2].map((celsius) => ({ mass, density, temperature: freeze + celsius, viscosity: Number.MAX_VALUE })),
  });
  world.advance(1);
  const [, top] = pack.layer(0, 0, 1),
    [, bottom] = pack.layer(0, 0, 2);
  const conductivity = 0.138 - 1.01 * 0.25 + 3.233 * 0.25 * 0.25;
  const coupling = (dt * conductivity) / (mass / density);
  near((bottom - top) / c, 8 / (1 + (2 * coupling) / c));
  near(top + bottom, -12 * c);
});

test('slab instability changes with measured interface strength, ground slope and root support', async () => {
  const world = worldWith();
  const ground = new TerrainBed();
  const roots = {
    name: 'forest:root-cohesion',
    quantity: 'shearStress',
    unit: 'Pa',
    kind: 'uniformGrid',
    centring: 'cell',
  };
  let support;
  world.add(
    {
      describe: () => ({
        id: 'root-support',
        rate: 0,
        stableRate: () => 0,
        fields: [{ field: roots, access: 'write' }],
      }),
      init(host) {
        support = host.allocate('cohesion', 6 * Float64Array.BYTES_PER_ELEMENT, 'f64', 1);
        regionWords(host.memory, support).set([0, 0, 0, 500, 500, 500]);
      },
      step() {},
      importPorts() {},
      exportPorts: (tick) => [{ field: roots.name, region: support, tick, cell: [0, 0, 0] }],
      stateRegions: () => [support],
      extraState: () => [],
    },
    {},
  );
  world.add(ground, { columns: 3, rows: 2, width: 3, depth: 2, centre: [0, 0], elevations: (x) => -x });
  const pack = add(world, await Snowpack.load({ followTerrain: true, inputs: { support: { field: roots } } }), {
    width: 3,
    depth: 2,
    origin: [-1, -0.5],
    layers: [{ mass: 100, density: 300, cohesion: 10 }],
  });
  world.advance(1);
  near(pack.read(1, 0).stability, 0.3 + 10 / (0.5 * 100 * gravity));
  assert.ok(pack.read(1, 0).stability < 1);
  assert.ok(pack.read(1, 1).stability > 1);
  near(pack.read(1, 0).slabMass, 100);
  assert.equal(pack.slide().slabMass[1], 100);
  assert.equal(pack.fieldData()[0], 1);
});

test('downslope drift feeds a lee cornice and both recipient columns account for every grain', async () => {
  const world = worldWith();
  const u = 0.3,
    threshold = 0.2;
  const pack = add(world, await Snowpack.load(), {
    width: 2,
    ground: [2, 0],
    frictionVelocity: [u, 0],
    corniceEfficiency: 0.1,
    corniceThickness: 0.1,
    corniceDensity: 300,
    layers: [{ mass: [10, 0], temperature: freeze }],
  });
  world.advance(1);
  const moved = (dt * 0.68 * 1.225 * threshold * (u * u - threshold * threshold)) / (gravity * u);
  const root = pack.read(0, 0),
    lee = pack.read(1, 0);
  near(root.corniceMass, 0.1 * moved);
  near(root.cornice[0], root.corniceMass / (300 * 0.1));
  near(lee.mass, 0.9 * moved);
  near(root.mass + lee.mass, 10);
  assert.equal(lee.corniceMass, 0);
});

test('a moderate wind builds the cornice, then stronger wind strips the overhang without losing mass', async () => {
  const world = worldWith();
  const wind = {
    cell: [0, 0, 0],
    sample(_x, _y, _z, time, out) {
      const friction = time < dt ? 0.3 : 0.6;
      out.velocity = [(friction * Math.log(10 / 0.0001)) / 0.4, 0, 0];
      out.density = 1.225;
      return out;
    },
  };
  const pack = add(world, await Snowpack.load(), {
    width: 2,
    ground: [2, 0],
    wind,
    layers: [{ mass: [10, 0], temperature: freeze }],
  });
  world.advance(1);
  assert.ok(pack.read(0, 0).corniceMass > 0);
  world.advance(2);
  assert.equal(pack.read(0, 0).corniceMass, 0);
  near(pack.read(0, 0).mass + pack.read(1, 0).mass, 10);
});

test('real ATMO-09 heat melts the pack and real HYDRO-01 shallow water receives its discharge', async () => {
  const world = worldWith();
  const energy = new SurfaceEnergySolver();
  const pack = await Snowpack.load({
    inputs: { topHeat: { field: energy.energyFluxField, stride: 5, weights: [1, -1, -1] } },
  });
  const terrain = new TerrainBed();
  world.add(terrain, { columns: 1, rows: 1, width: 1, depth: 1, centre: [0, 0], elevations: [0, 0, 0, 0] });
  world.add(energy, {
    shortwave: 700,
    longwave: 315,
    initialTemperature: freeze,
    airTemperature: freeze,
    initialWater: 0,
  });
  add(world, pack, { layers: [{ mass: 10, temperature: freeze }], retention: 0 });
  const water = new ShallowWaterSolver('melt-pond', {
    field: pack.dischargeField,
    outlets: [{ sourceCell: 0, position: [0, 0] }],
  });
  world.add(water, { bed: terrain.bed });
  world.advance(120);
  const dropped = 10 - pack.read(0, 0).mass;
  assert.ok(dropped > 0);
  near(water.volume(), dropped / 1000);
  near(water.budget.inflow, dropped / 1000);
});

test('real HYDRO-02 reads the liquid-equivalent melt rate over the same catchment', async () => {
  const world = worldWith();
  const pack = add(world, await Snowpack.load(), { rain: 0.002, retention: 0 });
  const hills = await RainfallRunoff.load({ rain: { field: pack.runoffField } });
  world.add(hills, { nx: 1, nz: 1, dx: 1, downstream: [-1], conductivity: 0, drainage: 0, slope: 0 });
  world.advance(60);
  near(hills.budget.rain, 0.002 / 1000);
});

test('wind drift, refreezing and ground runoff replay on the world clock and both memory modes', async () => {
  const a = await Snowpack.load(),
    b = await Snowpack.load();
  const make = (rate, memory, pack = a) => {
    const world = worldWith({ rate, memory });
    add(world, pack, {
      width: 3,
      depth: 2,
      ground: [3, 2, 0, 3, 2, 0],
      snowfall: 0.01,
      rain: 0.002,
      topHeat: 182,
      layers: [
        { mass: 100, temperature: freeze - 3 },
        { mass: 180, density: 350 },
      ],
      frictionVelocity: [0.51, 0.08],
    });
    return world;
  };
  frameRateIndependent(make);
  seekEqualsContinuous(() => make({ num: 24, den: 1 }));
  const plain = worldMemory(false),
    shared = worldMemory(true);
  assert.equal(isShared(plain), false);
  assert.equal(isShared(shared), true);
  const first = make(rate, plain),
    second = make(rate, shared, b);
  first.advance(60);
  second.advance(60);
  assert.equal(first.hash(), second.hash());
});

test('both slot-free binary variants leave every byte of populated world memory intact on load', async () => {
  for (const shared of [false, true]) {
    const memory = worldMemory(shared);
    const bytes = new Uint8Array(memory.buffer);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const expected = bytes.slice();
    const file = new URL(`../../dist/snowpack-kernel${shared ? '-shared' : ''}.wasm`, import.meta.url);
    const { instance } = await WebAssembly.instantiate(await readFile(file), { env: { memory } });
    assert.equal(instance.exports.__data_end.value, 0);
    assert.deepEqual(bytes, expected);
  }
});

test('foreign snowpack heat, memory growth and a late native overflow preserve accepted outputs', async () => {
  const memory = worldMemory(false);
  const world = worldWith({ memory });
  const bank = new WebAssembly.Memory({ initial: 1 });
  const heat = {
    name: 'probe:heat',
    kind: 'uniformGrid',
    quantity: 'energyFlux',
    unit: 'W/m^2',
    centring: 'cell',
  };
  const region = {
    name: 'foreign heat',
    type: 'f64',
    layout: 1,
    byteOffset: 192,
    byteLength: 16,
    memory: bank,
  };
  const watts = new Float64Array(bank.buffer, region.byteOffset, 2);
  watts.set([500, 100]);
  let grow = true;
  const wind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample(_x, _y, _z, _time, out) {
      if (grow) {
        grow = false;
        memory.grow(1);
      }
      out.velocity[0] = 0;
      out.velocity[2] = 0;
      out.density = 1.225;
      return out;
    },
  };
  const pack = add(world, await Snowpack.load({ inputs: { topHeat: { field: heat } } }), {
    width: 2,
    depth: 1,
    wind,
    secondsPerSecond: 6000,
    layers: [{ mass: 10, density: 250, temperature: freeze - 5 }],
  });
  const port = { field: heat.name, region, tick: 0, cell: [0, 0, 0] };
  const context = { tick: 0, level: 0, cell: [0, 0, 0], seed: 2, inputs: new Map([[heat.name, port]]) };
  pack.step(context, dt);
  assert.equal(grow, false);
  assert.ok(pack.read(0, 0).temperature > pack.read(1, 0).temperature);
  const accepted = world.takeSnapshot();
  const acceptedCover = pack.fieldData();
  const version = pack.version;
  watts[1] = Number.MAX_VALUE;
  assert.throws(
    () => pack.step({ ...context, tick: 1 }, dt),
    (error) => error.name === 'MargoError' && error.code === 'failed' && /Reduce.*errors#snowpack/.test(error.message),
  );
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
  assert.deepEqual(pack.fieldData(), acceptedCover);
  assert.equal(pack.version, version);
  watts[1] = 100;
  pack.step({ ...context, tick: 1 }, dt);
  const corrected = world.takeSnapshot().bytes;
  assert.notDeepEqual(corrected, accepted.bytes);
  world.restoreSnapshot(accepted.bytes);
  pack.step({ ...context, tick: 1 }, dt);
  assert.deepEqual(world.takeSnapshot().bytes, corrected);
});

test('snowpack publications retain the correct signed host cell through a shift and restore', async () => {
  const world = worldWith();
  const pack = add(world, await Snowpack.load(), { layers: [{ mass: 1 }] });
  world.setCell('snowpack', [-2, 1, 3]);
  world.advance(1);
  const accepted = world.takeSnapshot();
  const cover = pack.fieldData();
  assert.deepEqual(
    pack.exportPorts(1).map(({ cell }) => cell),
    Array(4).fill([-2, 1, 3]),
  );
  world.shiftOrigin([5, 2, -3]);
  assert.deepEqual(
    pack.exportPorts(1).map(({ cell }) => cell),
    Array(4).fill([-7, -1, 6]),
  );
  assert.deepEqual(pack.fieldData(), cover);
  world.restoreSnapshot(accepted.bytes);
  assert.deepEqual(
    pack.exportPorts(1).map(({ cell }) => cell),
    Array(4).fill([-2, 1, 3]),
  );
  assert.deepEqual(pack.fieldData(), cover);
});
