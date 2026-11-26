import assert from 'node:assert/strict';
import test from 'node:test';
import { disturbance } from '../../../biomes/dist/disturbance.js';
import { riverSources } from '../../../biomes/dist/rivers.js';
import { SurfaceEnergySolver } from '../../../weather/dist/surface-energy.js';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { RainfallRunoff } from '../../dist/runoff.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const base = { nx: 1, nz: 1, dx: 1, downstream: [-1], drainage: 0 };
const surface = { nx: 3, nz: 2, dx: 3, downstream: [1, 4, 5, 4, 5, -1] };

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} against ${expected} ± ${tolerance}`);
}

async function single(params, setup, memory) {
  const runoff = await RainfallRunoff.load(setup);
  const world = new PhysicsWorld({ rate, memory }).add(runoff, { ...base, ...params });
  return { runoff, world };
}

test('Green-Ampt follows the two-stage integrated ponding solution without losing rain', async () => {
  const conductivity = 0.002;
  const suction = 0.05;
  const rainRate = 0.02;
  const { world, runoff } = await single({
    rainRate,
    conductivity,
    suctionHead: suction,
    wettingDeficit: 1,
    slope: 0,
  });
  world.advance(12);
  near(runoff.read(0, 0).soilWater, 0.2 * rainRate, 16 * Number.EPSILON);
  assert.equal(runoff.read(0, 0).depth, 0);
  world.advance(60);
  const r = runoff.read(0, 0);
  const pondedAt = (conductivity * suction) / (rainRate - conductivity);
  const pondedTime = pondedAt / rainRate;
  const integrated = r.soilWater - pondedAt - suction * Math.log((r.soilWater + suction) / (pondedAt + suction));
  const bound = 60 * 20 * Number.EPSILON * Math.max(suction, rainRate);
  near(integrated, conductivity * (1 - pondedTime), bound);
  near(r.depth + r.soilWater, rainRate, bound);
});

test('a kinematic reach at Manning normal depth passes exactly its steady inflow', async () => {
  const h = 0.1;
  const width = 1.7;
  const roughness = 0.045;
  const slope = 0.025;
  const area = 4;
  const q = (width * Math.sqrt(slope) * h ** (5 / 3)) / roughness;
  const { world, runoff } = await single({
    dx: 2,
    initialDepth: h,
    conductivity: 0,
    slope,
    width,
    roughness,
    rainRate: q / area,
  });
  world.advance(60);
  const r = runoff.read(0, 0);
  near(r.depth, h, 60 * 16 * Number.EPSILON * h);
  near(r.outflow, q, 60 * 16 * Number.EPSILON * q);
  near(runoff.budget.outflow, runoff.budget.rain, 60 * 16 * Number.EPSILON * q);
});

test('TOPMODEL saturates the high-index contributing area before the drier slope', async () => {
  const { world, runoff } = await single({
    nx: 2,
    downstream: [-1, -1],
    soilCapacity: 0.1,
    wetnessIndex: [-2, 5],
    topographicScale: 0.08,
    conductivity: 0.001,
    rainRate: 1e-4,
    slope: 0,
  });
  world.advance(60);
  assert.equal(runoff.read(1, 0).soilWater, 0);
  assert.equal(runoff.read(0, 0).depth, 0);
  near(runoff.read(0, 0).soilWater, 1e-4, 60 * 3 * Number.EPSILON * 1e-4);
  near(runoff.read(1, 0).depth, 1e-4, 60 * 3 * Number.EPSILON * 1e-4);
});

const rainField = {
  name: 'upwindRain',
  kind: 'uniformGrid',
  quantity: 'precipitationRate',
  unit: 'm/s',
  centring: 'cell',
};

function publisher() {
  let host;
  let region;
  return {
    describe: () => ({ id: 'storm', fields: [{ field: rainField, access: 'write' }], rate: 0, stableRate: () => 0 }),
    init(h) {
      host = h;
      region = host.allocate('rain', 6 * 8, 'f64', 1);
    },
    step({ tick }) {
      const rain = regionWords(host.memory, region);
      rain.fill(tick >= 30 && tick < 180 ? 0.003 : 0, 0, 3);
      rain.fill(tick >= 30 && tick < 180 ? 0.001 : 0, 3);
    },
    importPorts() {},
    exportPorts: (tick) => [{ field: rainField.name, region, tick, cell: [0, 0, 0] }],
    extraState: () => [],
    stateRegions: () => [region],
  };
}

function smallBed() {
  const elevations = new Float64Array(4 * 3);
  return bedSurface({ columns: 3, rows: 2, width: 6, depth: 4, centre: [3, 2] }, elevations);
}

async function stormFactory(worldCount = 1) {
  // The coupling harness builds worlds synchronously; the compiled asset itself is independent of world state.
  const available = await Promise.all(
    Array.from({ length: worldCount }, () => RainfallRunoff.load({ rain: { field: rainField } })),
  );
  return (fps = rate, memory) => {
    const runoff = available.shift();
    assert.ok(runoff);
    const flood = new ShallowWaterSolver('flood', {
      field: runoff.outletField,
      outlets: [{ sourceCell: 5, position: [1, 1] }],
    });
    const world = new PhysicsWorld({ rate: fps, memory })
      .add(flood, { bed: smallBed() })
      .add(runoff, { ...surface, conductivity: 0, width: 4, slope: 0.1 })
      .add(publisher(), {});
    return { world, runoff, flood };
  };
}

test('RITS-9, RITS-10 and CF-2: a windward rain pulse raises real river discharge and spreads on a dry flood floor', async () => {
  const make = await stormFactory();
  const { world, runoff, flood } = make();
  const lines = [Int32Array.of(7500, 4500, 4500, 4500)];
  const sources = () =>
    riverSources(
      lines,
      (x) => x,
      (x, z) => runoff.dischargeAt(x, z),
      1.5,
    );
  world.advance(30);
  assert.equal(runoff.read(2, 1).outflow, 0);
  assert.equal(sources()[0].discharge, 0);
  assert.equal(flood.volume(), 0);
  world.advance(360);
  const budget = runoff.budget;
  assert.ok(budget.outflow > 0);
  assert.equal(sources()[0].discharge, runoff.read(2, 1).outflow);
  assert.ok(sources()[0].discharge > 0);
  assert.ok(flood.sample(1, 1).depth > 0);
  assert.ok(flood.sample(3, 1).depth > 1e-6, 'the flood reaches a cell other than its inlet');
  assert.ok(Math.abs(flood.sample(3, 1).velocity[0]) > 0);
  const bound = 360 * 32 * Number.EPSILON * budget.rain;
  near(flood.budget.inflow, budget.outflow, bound);
  near(flood.volume(), budget.outflow, bound);
  let stored = 0;
  for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) stored += runoff.read(i, j).depth * 9;
  near(stored + budget.outflow + budget.recharge, budget.rain, bound);
  const result = disturbance({ nx: 3, nz: 2, step: 2000, height: new Int32Array(6) }, undefined, {
    fire: false,
    flood: {
      returnPeriods: [2],
      water: { origin: [1, 1], sample: (_period, x, z) => flood.sample(x, z) },
    },
  });
  assert.equal(result.flood[0], 2);
  assert.equal(result.flood[1], 2, 'the historical classification reads the resolved flood depth');
});

test('real ATMO-09 melt becomes runoff at the same coupling tick', async () => {
  const ground = new SurfaceEnergySolver();
  const { world, runoff } = await single({ slope: 0, conductivity: 0 }, { surfaceEnergy: ground.waterFluxField });
  world.add(ground, {
    initialSnow: 1,
    initialWater: 0,
    initialTemperature: 273.15,
    airTemperature: 273.15,
    humidity: 1,
    emissivity: 0,
    groundConductance: 0,
    albedo: 0,
    shortwave: 333.7,
  });
  world.advance(60);
  assert.equal(ground.read().temperature, 273.15);
  near(runoff.budget.melt, 1e-6, 60 * 8 * Number.EPSILON * 1e-6);
  near(runoff.read(0, 0).depth, runoff.budget.melt, 60 * 8 * Number.EPSILON * 1e-6);
});

test('groundwater recharge, liquid and evaporative loss balance through a dry interval', async () => {
  const { world, runoff } = await single({
    soilCapacity: 0.12,
    initialSaturation: 0.5,
    drainage: 0.3,
    conductivity: 0,
    slope: 0,
  });
  world.advance(60);
  const initial = 0.06;
  const remaining = initial * Math.exp(-0.3);
  near(runoff.read(0, 0).soilWater, remaining, 60 * 8 * Number.EPSILON * initial);
  near(runoff.budget.recharge + runoff.read(0, 0).soilWater, initial, 60 * 8 * Number.EPSILON * initial);
  near(runoff.read(0, 0).recharge, remaining * Math.expm1(0.3 / 60) * 60, 60 * 8 * Number.EPSILON * initial);
});

test('registry coupling and the watershed hash survive frame rate, snapshots and memory mode', async () => {
  const make = await stormFactory(7);
  frameRateIndependent((fps) => make(fps).world);
  seekEqualsContinuous(() => make({ num: 24, den: 1 }).world);
  const plain = make(rate, worldMemory(false)).world;
  const shared = make(rate, worldMemory(true)).world;
  plain.advance(240);
  shared.advance(240);
  assert.equal(plain.hash(), shared.hash());
});

test('cyclic drainage and invalid grid values identify the offending option', async () => {
  await assert.rejects(() => single({ nx: 2, downstream: [1, 0] }), /acyclic drainage graph/);
  await assert.rejects(() => single({ dx: 0 }), /dx.*positive/);
  await assert.rejects(() => single({ initialSaturation: 1.1 }), /initialSaturation.*\[0, 1\]/);
});
