import assert from 'node:assert/strict';
import test from 'node:test';
import { BedCollider, TerrainBed, bedVertexAreas } from '../../dist/earth.js';
import { SURFACE_WATER_FIELD } from '../../dist/hydro.js';
import { LandscapeEvolution } from '../../dist/landscape.js';
import { loadKernel, Physics } from '../../dist/index.js';
import { SedimentTransport } from '../../dist/sediment.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const grid = { columns: 1, rows: 1, width: 1, depth: 1, centre: [0, 0] };
const rate = { num: 60, den: 1 };
const zeroProcesses = { erodibility: 0, rainfall: 0, hillslopeDiffusivity: 0, thermalDiffusivity: 0 };

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} versus ${expected} (tolerance ${tolerance})`);
}

function source(field, values, type = 'f64') {
  let region;
  return {
    describe: () => ({ id: field.name, rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] }),
    init(host) {
      region = host.allocate('data', values.length * (type === 'f32' ? 4 : 8), type, 1);
      regionWords(host.memory, region).set(values);
    },
    step() {},
    exportPorts: (tick) => [{ field: field.name, tick, cell: [0, 0, 0], region }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

function create(landscape, heights, settings = {}, options = {}) {
  const shape = options.grid ?? grid;
  const world = new PhysicsWorld({ rate: options.rate ?? rate, memory: options.memory });
  const terrain = new TerrainBed();
  world.add(terrain, { ...shape, elevations: heights, bedrock: options.bedrock });
  world.add(landscape, { grid: shape, ...zeroProcesses, ...settings });
  for (const solver of options.publishers ?? []) world.add(solver, {});
  return { world, terrain, landscape };
}

test('a divergent hillside routes runoff in three directions with exact catchment closure', async () => {
  const model = await LandscapeEvolution.load();
  const localRain = 6 / 1024;
  const { world } = create(model, [2, 1, 1, 0], { rainfall: [localRain, 0, 0, 0] });
  world.advance(1);
  const rain = localRain * bedVertexAreas(grid)[0];
  const diagonal = Math.sqrt(2) ** 1.1;
  near(model.read(0, 0).discharge, rain);
  near(model.read(0, 1).discharge, rain / (2 + diagonal));
  near(model.read(1, 0).discharge, rain / (2 + diagonal));
  near(model.read(1, 1).discharge, rain);
  assert.equal(model.budget.elapsed, 1 / 60);
});

test('cell rainfall remaps to the bed without changing its contributing water volume', async () => {
  const field = { name: 'rainRate', kind: 'uniformGrid', quantity: 'rain', unit: 'm/s', centring: 'cell' };
  const model = await LandscapeEvolution.load({ rainField: field });
  const shape = { ...grid, columns: 2, width: 2 };
  const { world } = create(model, [0, 0, 0, 0, 0, 0], {}, { grid: shape, publishers: [source(field, [0.2, 0.7])] });
  world.advance(1);
  const q = Array.from({ length: 3 }, (_, x) => model.read(x, 0).discharge + model.read(x, 1).discharge);
  near(q[0] + q[1] + q[2], 0.9);
  assert.ok(q[2] > q[0]);
});

const shear = { name: 'heldShear', kind: 'uniformGrid', quantity: 'pressure', unit: 'Pa', centring: 'cell' };
const outlets = { maxX: true, maxZ: true };

test('a watershed step agrees with the weighted backward-Euler incision solution', async () => {
  const model = await LandscapeEvolution.load({ shearField: shear });
  const k = 0.5;
  const { world, terrain } = create(
    model,
    [1, 0, 0, 0],
    { rainfall: 1e-3, erodibility: k, dischargeExponent: 0, outlets, alluvialDepth: 0 },
    { publishers: [source(shear, [10_000])] },
  );
  world.advance(1);
  const diagonal = 1 / Math.sqrt(2);
  const coefficient = (k * (2 + diagonal ** 2.1)) / (2 + diagonal ** 1.1);
  const exact = 1 / (1 + coefficient / 60);
  near(model.read(0, 0).incision, (1 - exact) * 60);
  const exported = model.budget.exported[0];
  world.advance(2); // TerrainBed consumes the previous tick's accumulated changes.
  near(terrain.elevations()[0], exact);
  near(terrain.volume() + exported, 1 / 6);
  assert.deepEqual(Array.from(terrain.elevations().subarray(1)), [0, 0, 0]);
});

test('Shields stress exports fine grains while coarser grains accumulate locally', async () => {
  const model = await LandscapeEvolution.load({ shearField: shear });
  const { world, terrain } = create(
    model,
    [1, 0, 0, 0],
    {
      rainfall: 1e-3,
      erodibility: 0.0001,
      dischargeExponent: 0,
      outlets,
      alluvialDepth: 0,
      grains: [
        { diameter: 0.0002, fraction: 1 },
        { diameter: 0.04, fraction: 1 },
      ],
    },
    { publishers: [source(shear, [5])] },
  );
  world.advance(1);
  const [fine, coarse] = model.budget.exported;
  assert.ok(fine > 0);
  assert.equal(coarse, 0);
  near(model.read(0, 0).alluvium[1], fine);
  world.advance(2);
  near(terrain.volume() + fine, 1 / 6);
});

test('an outlet deposits the fraction dictated by exponential sediment travel length', async () => {
  const setup = async (travelLength) =>
    create(
      await LandscapeEvolution.load({ shearField: shear }),
      [1, 0, 0, 0],
      {
        rainfall: 1e-3,
        erodibility: 0.1,
        dischargeExponent: 0,
        outlets,
        alluvialDepth: 0,
        grains: [{ diameter: 0.0002, fraction: 1, travelLength }],
      },
      { publishers: [source(shear, [1000])] },
    );
  const plain = await setup(0);
  const travelLength = 0.5;
  const filtered = await setup(travelLength);
  plain.world.advance(1);
  filtered.world.advance(1);
  const diagonal = Math.sqrt(2);
  const weight = 1 / diagonal ** 1.1;
  const meanDistance = (2 + weight * diagonal) / (2 + weight);
  const exported = filtered.landscape.budget.exported[0];
  near(exported / plain.landscape.budget.exported[0], Math.exp(-meanDistance / travelLength));
  filtered.world.advance(2);
  near(filtered.terrain.volume() + exported, 1 / 6);
});

test('conservative hillslope diffusion and thermal transfer have the exact isolated-face solutions', async () => {
  for (const [diffusivity, thermal, slope] of [
    [0.9, 0, 0],
    [0, 0.9, 0.75],
    [0, 0.9, 3],
  ]) {
    const model = await LandscapeEvolution.load();
    const height = [0, 2, 0, 0];
    const { world, terrain } = create(model, height, {
      hillslopeDiffusivity: diffusivity,
      thermalDiffusivity: thermal,
      talusSlope: slope,
      outlets: { minZ: true },
      secondsPerSecond: 60,
    });
    world.advance(2);
    const a = bedVertexAreas(grid);
    const start = height[1] - height[3];
    const threshold = Math.min(slope, start);
    const drop = threshold + (start - threshold) * Math.exp(-(diffusivity + thermal) * 0.5 * (1 / a[1] + 1 / a[3]));
    const elevations = terrain.elevations();
    near(elevations[1] - elevations[3], drop);
    near(terrain.volume(), a[1] * height[1]);
  }
});

test('root pressure protects the hillside and accumulated uplift reaches an existing rigid collider', async () => {
  await loadKernel();
  const roots = { ...shear, name: 'roots' };
  const model = await LandscapeEvolution.load({ shearField: shear, rootCohesionField: roots });
  const { world, terrain } = create(
    model,
    [1, 0, 0, 0],
    { rainfall: 0.001, uplift: 0.2, erodibility: 4, outlets },
    { publishers: [source(shear, [10]), source(roots, [12])] },
  );
  using physics = new Physics(null);
  const collider = new BedCollider(physics, terrain.bed);
  world.advance(60);
  assert.equal(model.read(0, 0).incision, 0);
  near(model.budget.uplift, 0.2 / 6);
  world.advance(61);
  near(terrain.elevations()[0], 1.2);
  assert.equal(collider.sync(terrain.bed), 1);
  near(collider.collider.heightfieldHeights()[0], Math.fround(1.2));
});

test('the HYDRO-03 shear port activates long-term mountain incision above the rock threshold', async () => {
  for (const velocity of [1, 3]) {
    const sediment = await SedimentTransport.load();
    const model = await LandscapeEvolution.load({ shearField: sediment.shearField });
    const { world, terrain } = create(model, [1, 0, 0, 0], {
      rainfall: 1e-3,
      erodibility: 1e-4,
      dischargeExponent: 0,
      bedrockThreshold: 20,
      outlets,
    });
    world.add(source(SURFACE_WATER_FIELD, [1, velocity, 0], 'f32'), {});
    world.add(sediment, { grid, mobileDepth: 0 });
    world.advance(4);
    const stress = 1000 * 9.80665 * 0.03 ** 2 * velocity ** 2;
    near(sediment.read(0, 0).shearStress, stress);
    if (stress > 20) {
      assert.ok(model.read(0, 0).incision > 0 && terrain.elevations()[0] < 1);
    } else {
      assert.equal(model.read(0, 0).incision, 0);
      assert.equal(terrain.elevations()[0], 1);
    }
  }
});

test('the transport floor protects bedrock without losing the material sent to the next vertex', async () => {
  const model = await LandscapeEvolution.load();
  const floor = [0, 1.9, 0, 0];
  const { world, terrain } = create(
    model,
    [0, 2, 0, 0],
    { hillslopeDiffusivity: 10, secondsPerSecond: 60, outlets: { minZ: true }, floor },
    { bedrock: floor },
  );
  world.advance(2);
  near(terrain.elevations()[1], 1.9);
  near(terrain.elevations()[3], 0.2);
  near(terrain.refusedVolume(), 0);
  near(terrain.volume(), 2 / 3);
  world.advance(60);
  near(model.budget.uplift, 0);
});

test('landscape, terrain budget and regional fields replay across frame rates and memory arrangements', async () => {
  const plain = await LandscapeEvolution.load();
  const shared = await LandscapeEvolution.load();
  const settings = {
    rainfall: 1e-4,
    uplift: [0, 0, 0.02, 0],
    erodibility: 0.01,
    hillslopeDiffusivity: 0.1,
    thermalDiffusivity: 0.1,
    secondsPerSecond: 60,
  };
  const make = (frameRate = rate, memory) => create(plain, [2, 1, 0.5, 0], settings, { rate: frameRate, memory }).world;
  frameRateIndependent(make);
  seekEqualsContinuous(() => make(), { at: 20, frames: 60 });
  const one = make(rate, worldMemory(false));
  const two = create(shared, [2, 1, 0.5, 0], settings, { memory: worldMemory(true) }).world;
  one.advance(60);
  two.advance(60);
  assert.equal(one.hash(), two.hash());
});

test('invalid terrain and sediment parameters name the input to repair', async () => {
  const model = await LandscapeEvolution.load();
  assert.throws(() => create(model, [0, 0, 0, 0], { grains: [] }), /class with a positive fraction/);
  assert.throws(() => create(model, [0, 0, 0, 0], { rainfall: [1, 2] }), /4 vertex values/);
  assert.throws(() => model.read(-1, 0), /add it to a PhysicsWorld/);
});
