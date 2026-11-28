import assert from 'node:assert/strict';
import test from 'node:test';
import { equilibriumMoisture, wetColor } from '../../../weather/dist/index.js';
import { SurfaceEnergySolver } from '../../../weather/dist/surface-energy.js';
import { CelestialSolver, INSOLATION_FIELD, insolationFromPort } from '../../dist/celestial.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const quiet = {
  humidity: 0,
  emissivity: 0,
  groundConductance: 0,
  initialWater: 0,
  airTemperature: 273.15,
  initialTemperature: 273.15,
};

function make(options = {}, setup = {}, fps = rate, memory) {
  const solver = new SurfaceEnergySolver(setup);
  const world = new PhysicsWorld({ rate: fps, memory });
  world.add(solver, options);
  return { world, solver };
}

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} against ${expected} ± ${tolerance}`);
}

test('the gridded surface samples precipitation in X-fast signed cells at the step end', () => {
  const calls = [];
  let bad = false;
  const field = {
    cell: [-2, 4, 0],
    sample(x, y, z, time) {
      calls.push([x, y, z, time]);
      return {
        rain: { rate: bad && x === -254 && z === -508 ? NaN : x === -254 && z === -510 && time > 0 ? 3600 : 0 },
        snow: { rate: 0 },
        graupel: { rate: 0 },
        hail: { rate: 0 },
      };
    },
  };
  const { world, solver } = make(
    {
      ...quiet,
      humidity: 1,
      grid: { columns: 2, rows: 2, spacing: [1, 2], origin: [1, 0, 2], cellSize: 256 },
    },
    { precipitation: { field } },
  );
  const cell = [-3, 5, -2];
  world.shiftOrigin([3, -5, 2]);
  world.advance(1);
  assert.deepEqual(calls, [
    [-255, 256, -510, 1 / 60],
    [-254, 256, -510, 1 / 60],
    [-255, 256, -508, 1 / 60],
    [-254, 256, -508, 1 / 60],
  ]);
  assert.deepEqual(solver.read(), solver.readPatch(0));
  assert.deepEqual(
    Array.from({ length: 4 }, (_, i) => solver.readPatch(i).water),
    [0, 1 / 60, 0, 0],
  );
  const wetness = world.fields.port(solver.wetnessField.name);
  assert.deepEqual(wetness.cell, cell);
  assert.deepEqual(Array.from(regionWords(world.memory, wetness.region)), [0, 1 / 900, 0, 0]);
  const accepted = world.takeSnapshot();
  bad = true;
  assert.throws(() => solver.step({ tick: 1, level: 0, cell, seed: 0, inputs: new Map() }, 1 / 60), {
    name: 'MargoError',
    code: 'state',
    message: /precipitation rain rate; pass a finite value/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
});

test('a late strided grid input leaves all patch budgets and registry bytes accepted on failure', () => {
  const irradiance = {
    name: 'surface-test-irradiance',
    kind: 'scalarSeries',
    quantity: 'shortwave',
    unit: 'W/m^2',
    centring: 'cell',
  };
  const { world, solver } = make(
    {
      ...quiet,
      heatCapacity: 60,
      grid: {
        columns: 3,
        rows: 1,
        spacing: [1, 1],
        patches: [{ albedo: 0.3 }, { albedo: 0.1 }, { emissivity: 1 }],
      },
    },
    { inputs: { shortwave: { field: irradiance, word: 1, patchStride: 2 } } },
  );
  let region;
  world.add(
    {
      describe: () => ({
        id: 'surface-test-input',
        rate: 0,
        stableRate: () => 0,
        fields: [{ field: irradiance, access: 'write' }],
      }),
      init(host) {
        region = host.allocate('shortwave', 6 * 8, 'f64', 1);
        regionWords(host.memory, region).set([0, 100, 0, 200, 0, 300]);
      },
      step() {},
      importPorts() {},
      exportPorts: (tick) => [{ field: irradiance.name, region, tick, cell: [0, 0, 0] }],
      stateRegions: () => [region],
      extraState: () => [],
    },
    {},
  );
  world.advance(2);
  assert.ok(solver.readPatch(1).temperature > solver.readPatch(0).temperature);
  const port = { field: irradiance.name, region, tick: 2, cell: [0, 0, 0] };
  const inputs = new Map([[irradiance.name, port]]);
  regionWords(world.memory, region)[5] = Number.MAX_VALUE;
  const accepted = world.takeSnapshot();
  assert.throws(() => solver.step({ tick: 2, level: 0, cell: port.cell, seed: 0, inputs }, 1 / 60), {
    name: 'MargoError',
    code: 'state',
    message: /floating-point range; reduce fluxes/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, accepted.bytes);
});

test('surface temperature approaches the backward-Euler solution of a linear heat budget', () => {
  const heatCapacity = 1800;
  const resistance = 100;
  const heatTransfer = ((101325 / (287.05 * quiet.airTemperature)) * 1005) / resistance;
  const groundConductance = 20;
  const deepTemperature = 295;
  const shortwave = 400;
  const albedo = 0.25;
  const { world, solver } = make({
    ...quiet,
    deepTemperature,
    shortwave,
    albedo,
    groundConductance,
    heatCapacity,
    aerodynamicResistance: resistance,
  });
  const k = heatTransfer + groundConductance;
  const equilibrium =
    ((1 - albedo) * shortwave + heatTransfer * quiet.airTemperature + groundConductance * deepTemperature) / k;
  const initial = solver.read().temperature;
  const frames = 600;
  world.advance(frames);
  const expected = equilibrium + (initial - equilibrium) * (1 + k / (heatCapacity * 60)) ** -frames;
  // Each rounded solve propagates as a contraction. Allow four floating-point roundoffs per step in the reference and solve.
  near(solver.read().temperature, expected, 4 * frames * Number.EPSILON * equilibrium);
  assert.equal(solver.read().evaporation, 0);
});

test('thermal emission and the latent, convective and ground terms close implicit storage', () => {
  const heatCapacity = 4000;
  const { world, solver } = make({
    shortwave: 725,
    longwave: 320,
    rain: 4e-5,
    heatCapacity,
    airTemperature: 290,
    initialTemperature: 298,
    humidity: 0.2,
  });
  let previous = solver.read();
  for (let frame = 1; frame <= 120; frame++) {
    world.advance(frame);
    const s = solver.read();
    assert.ok(s.evaporation > 0);
    near(s.latent, s.evaporation * 2.45e6, Number.EPSILON * s.latent);
    const storage = heatCapacity * 60 * (s.temperature - previous.temperature);
    const flux = s.netRadiation - s.sensible - s.latent - s.ground - s.meltHeat;
    near(storage, flux, 8 * Number.EPSILON * heatCapacity * 60 * s.temperature);
    const change = s.water + s.snow - previous.water - previous.snow;
    near(change, (0.04 - s.evaporation - s.runoff) / 60, 8 * Number.EPSILON * s.water);
    previous = s;
  }
});

test('available snow holds the surface at freezing and accounts for all melt enthalpy before warming', () => {
  const shortwave = 400;
  const heatCapacity = 1800;
  const initialSnow = (shortwave / (333700 * 60)) * 2.5;
  const { world, solver } = make({ ...quiet, albedo: 0, heatCapacity, initialSnow, shortwave });
  world.advance(1);
  const melting = solver.read();
  assert.equal(melting.temperature, 273.15);
  assert.equal(melting.meltHeat, shortwave);
  near(melting.water, shortwave / (333700 * 60), Number.EPSILON * initialSnow);
  near(melting.water + melting.snow, initialSnow, Number.EPSILON * initialSnow);
  world.advance(2);
  const second = solver.read();
  world.advance(3);
  const melted = solver.read();
  assert.equal(melted.snow, 0);
  assert.ok(melted.temperature > 273.15);
  near(melted.water + (second.evaporation + melted.evaporation) / 60, initialSnow, 4 * Number.EPSILON * initialSnow);
  const storage = heatCapacity * 60 * (melted.temperature - 273.15);
  near(
    storage,
    melted.netRadiation - melted.sensible - melted.latent - melted.ground - melted.meltHeat,
    4 * Number.EPSILON * 60 * heatCapacity * melted.temperature,
  );
});

test('the liquid limit bounds evaporation and saturated air deposits dew on a cold surface', () => {
  const initialWater = 1e-8;
  const dry = make({ ...quiet, initialWater });
  dry.world.advance(1);
  assert.equal(dry.solver.read().water, 0);
  near(dry.solver.read().evaporation, initialWater * 60, Number.EPSILON * initialWater * 60);
  const dew = make({ ...quiet, airTemperature: 295, humidity: 1, heatCapacity: 250000 });
  dew.world.advance(1);
  const sample = dew.solver.read();
  assert.ok(sample.evaporation < 0);
  assert.ok(sample.latent < 0);
  near(sample.water, -sample.evaporation / 60, Number.EPSILON * sample.water);
});

test('the fuel field follows the analytic Fosberg 1-hour and 10-hour response', () => {
  const { world, solver } = make({ ...quiet, rain: 0.001, waterCapacity: 60 });
  const initial = equilibriumMoisture(0, 0);
  const time = 12;
  world.advance(time * 60);
  const fuel = solver.read().fuelMoisture;
  for (let i = 0; i < 2; i++) {
    const tau = i === 0 ? 3600 : 36000;
    const expected = 0.35 + (initial - 0.35) * Math.exp(-time / tau);
    // The repeated affine update has unit Lipschitz constant at most. Accumulated roundoff is bounded by step count.
    near(fuel[i], expected, 6 * time * 60 * Number.EPSILON * 0.35);
  }
  assert.ok(fuel[0] > fuel[1] && fuel[1] > fuel[2]);
  const port = world.fields.port(solver.fuelMoistureField.name);
  assert.deepEqual(Array.from(regionWords(world.memory, port.region)), fuel);
});

const rainField = {
  name: 'basin-rain',
  kind: 'scalarSeries',
  quantity: 'precipitationRate',
  unit: 'm/s',
  centring: 'cell',
};

function storm(rates, fps = rate, memory) {
  const { world, solver } = make(
    { ...quiet, humidity: 1, waterCapacity: 1 },
    { inputs: { rain: { field: rainField, word: 1 } } },
    fps,
    memory,
  );
  let host;
  let region;
  const publisher = {
    describe: () => ({
      id: 'basin-atmosphere',
      fields: [{ field: rainField, access: 'write' }],
      rate: 0,
      stableRate: () => 0,
    }),
    init(h) {
      host = h;
      region = host.allocate('precipitation', 16, 'f64', 1);
      regionWords(host.memory, region)[1] = rates[0];
    },
    step(ctx) {
      regionWords(host.memory, region)[1] = rates[Math.min(ctx.tick, rates.length - 1)];
    },
    exportPorts: (tick) => [{ field: rainField.name, region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
  world.add(publisher);
  return { world, solver };
}

test('RITS-10: a storm wets previously dry ground, darkens its material, and yields runoff at saturation', () => {
  const rates = Array.from({ length: 121 }, (_, tick) => (tick < 60 ? 0 : 0.002));
  const { world, solver } = storm(rates);
  const soil = [0.35, 0.22, 0.13];
  world.advance(60);
  const dry = wetColor(soil, solver.read().wetness);
  assert.deepEqual(dry, soil);
  world.advance(75);
  const damp = solver.read();
  assert.ok(damp.wetness > 0 && damp.wetness < 1);
  const wet = wetColor(soil, damp.wetness);
  assert.ok(wet.every((channel, i) => channel < dry[i]));
  let runoff = 0;
  for (let frame = 76; frame <= 120; frame++) {
    world.advance(frame);
    runoff += solver.read().runoff / 60;
  }
  const saturated = solver.read();
  assert.equal(saturated.wetness, 1);
  // 60 ticks at 2 kg/m²/s deliver exactly 2 kg/m² over the wet second.
  near(saturated.water + runoff, 2, 8 * 60 * Number.EPSILON * 2);
  assert.ok(wetColor(soil, saturated.wetness)[0] < wet[0]);
});

test('the read port and patch replay exactly at alternate frame rates and after restore in either memory mode', () => {
  const rates = [0, 0.0004, 0.0001, 0.0003, 0.0005, 0.0001, 0];
  frameRateIndependent((fps) => storm(rates, fps).world);
  seekEqualsContinuous(() => storm(rates, { num: 24, den: 1 }).world);
  const plain = storm(rates, rate, worldMemory(false)).world;
  const shared = storm(rates, rate, worldMemory(true)).world;
  plain.advance(120);
  shared.advance(120);
  assert.equal(plain.hash(), shared.hash());
});

test('port projections can supply local insolation from a shared payload in the field registry', () => {
  const sun = {
    name: 'test-insolation',
    kind: 'scalarSeries',
    quantity: 'heatFlux',
    unit: 'W/m^2',
    centring: 'vertex',
  };
  const input = {
    field: sun,
    sample: (memory, port) => 500 * regionWords(memory, port.region)[1],
  };
  const { world, solver } = make({ ...quiet, albedo: 0.2 }, { inputs: { shortwave: input } });
  let region;
  world.add({
    describe: () => ({ id: 'sun-path', fields: [{ field: sun, access: 'write' }], rate: 0, stableRate: () => 0 }),
    init: (host) => {
      region = host.allocate('sun-path', 16, 'f64', 1);
      regionWords(host.memory, region).set([1, 0.5]);
    },
    step() {},
    exportPorts: (tick) => [{ field: sun.name, region, tick, cell: [0, 0, 0] }],
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  });
  world.advance(1);
  assert.equal(solver.read().netRadiation, 200);
});

test('invalid storage and conflicting units name valid options', () => {
  assert.throws(() => make({ waterCapacity: 1, initialWater: 2 }), /initialWater.*0 to 1/);
  assert.throws(() => make({ pressure: 0 }), /pressure.*positive/);
  assert.throws(() => new SurfaceEnergySolver({ inputs: { longwave: { field: rainField } } }), /longwave.*W\/m\^2/);
  assert.throws(() => new SurfaceEnergySolver().read(), /add the solver to a PhysicsWorld/);
});

test('SPACE-02 insolation warms the patch at the same coupling tick', () => {
  const site = { latitude: 0, longitude: 0 };
  const celestial = new CelestialSolver();
  const { world, solver } = make(
    { ...quiet, albedo: 0 },
    {
      inputs: {
        shortwave: {
          field: INSOLATION_FIELD,
          sample: (memory, port) => insolationFromPort(memory, port, site).horizontal,
        },
      },
    },
  );
  world.add(celestial, {});
  world.advance(1);
  const solarFlux = celestial.insolation(site).horizontal;
  assert.ok(solarFlux > 1200);
  assert.equal(solver.read().netRadiation, solarFlux);
  assert.ok(solver.read().temperature > quiet.initialTemperature);
});
