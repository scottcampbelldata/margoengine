import assert from 'node:assert/strict';
import test from 'node:test';
import { PrecipitationField } from '@margoengine/weather/precipitation';
import { CloudSolver } from '../../dist/clouds.js';
import { TerrainBed } from '../../dist/earth.js';
import { ShallowWaterSolver, SURFACE_WATER_FIELD } from '../../dist/hydro.js';
import { RainfallRunoff } from '../../dist/runoff.js';
import { SYNOPTIC_LAYOUT, SYNOPTIC_WORDS, SynopticWeather } from '../../dist/synoptic.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const grid = [16, 8];
const spacing = 20_000;
const options = { spacing: [spacing, spacing], cells: grid, streamfunction: 0, beta: 0 };

const build = (solver, params = {}, playback = rate, shared = false) =>
  new PhysicsWorld({ rate: playback, memory: worldMemory(shared) }).add(solver, { ...options, ...params });

function near(actual, expected, bound) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} versus ${expected} ± ${bound}`);
}

function closes(solver) {
  const { initial, airborne, evaporation, precipitation, substeps } = solver.budget;
  const roundoff = (64 + 16 * substeps) * Number.EPSILON * Math.max(1, initial + evaporation);
  near(airborne + precipitation, initial + evaporation, roundoff);
}

test('SynopticWeather recovers the exact discrete balanced pressure mode at both fidelities', async () => {
  const kdx = (2 * Math.PI) / grid[0],
    f = 1e-4,
    amplitude = 500_000,
    rho = 1.225;
  for (const fidelity of ['high', 'fast']) {
    const synoptic = await SynopticWeather.load();
    const world = build(synoptic, {
      fidelity,
      coriolis: f,
      meanWind: [0, 0],
      streamfunction: (x) => amplitude * Math.cos((kdx * x) / spacing),
    });
    for (let i = 0; i < grid[0]; i++) {
      const row = synoptic.sample(i * spacing, 3 * spacing);
      const pressure = 101325 + rho * f * amplitude * Math.cos(i * kdx);
      near(row.pressure, pressure, 8 * Number.EPSILON * pressure);
      near(row.wind[0], 0, 1e-12);
      near(row.wind[1], (-amplitude * Math.sin(kdx * i) * Math.sin(kdx)) / spacing, 1e-11);
    }
    world.advance(60);
    const [port] = synoptic.exportPorts(60);
    assert.equal(port.region.layout, SYNOPTIC_LAYOUT);
    assert.equal(regionWords(world.memory, port.region).length, grid[0] * grid[1] * SYNOPTIC_WORDS);
    near(synoptic.sample(0, 0).pressure, 101325 + rho * f * amplitude, 1e-9);
  }
});

test('a barotropic Rossby mode travels with the discrete Crank–Nicolson phase', async () => {
  const synoptic = await SynopticWeather.load();
  const duration = 4000,
    beta = 1.6e-11,
    kdx = (2 * Math.PI) / grid[0],
    amplitude = 3000,
    f = 1e-4;
  const world = build(synoptic, {
    fidelity: 'fast',
    beta,
    coriolis: f,
    meanWind: [0, 0],
    timeScale: duration * 60,
    streamfunction: (x) => amplitude * Math.cos((kdx * x) / spacing),
  });
  world.advance(1);
  assert.equal(synoptic.budget.substeps, 1);
  const eigenvalue = (-4 * Math.sin(kdx / 2) ** 2) / (spacing * spacing);
  const omega = (beta * Math.sin(kdx)) / (spacing * eigenvalue);
  const theta = 2 * Math.atan((omega * duration) / 2);
  for (let i = 0; i < grid[0]; i++) {
    const pressure = 101325 + 1.225 * f * amplitude * Math.cos(kdx * i - theta);
    near(synoptic.sample(i * spacing, 0).pressure, pressure, 8 * Number.EPSILON * pressure);
  }
});

test('the curved-flow pressure solves the exact local solid-rotation balance from calm to high winds', async () => {
  const f = 1e-4;
  for (const omega of [1e-6, 5e-5, 2e-4]) {
    const synoptic = await SynopticWeather.load();
    const x = 7 * spacing,
      z = 3 * spacing;
    build(synoptic, {
      coriolis: f,
      meanWind: [0, 0],
      streamfunction: (px, pz) => 0.5 * omega * ((px - x) ** 2 + (pz - z) ** 2),
    });
    const p = (dx, dz) => synoptic.sample(x + dx * spacing, z + dz * spacing).pressure;
    const p0 = p(0, 0);
    const laplace = (p(1, 0) + p(-1, 0) + p(0, 1) + p(0, -1) - 4 * p0) / (spacing * spacing);
    // The periodic pressure removes its mean RHS. The discrete integral of det(∇u) and vorticity is zero.
    near(laplace, 2 * 1.225 * omega * (f + omega), (256 * Number.EPSILON * p0) / (spacing * spacing));
  }
});

test('RITS-6 and WIND-1: the same map frame holds a low while cloud turns counterclockwise and drives a real cloud box', async () => {
  const weather = await SynopticWeather.load();
  const n = 16,
    x0 = 8 * spacing,
    z0 = 8 * spacing,
    sigma = 60_000;
  const xCloud = x0 + 2 * spacing,
    duration = 3000;
  const world = build(weather, {
    cells: [n, n],
    meanWind: [0, 0],
    timeScale: 60 * duration,
    streamfunction: (x, z) => -2.5e6 * Math.exp(-((x - x0) ** 2 + (z - z0) ** 2) / (2 * sigma * sigma)),
    cloud: (x, z) => (x === xCloud && z === z0 ? 16 : 0),
    cloudTime: 10_000,
    falloutTime: 10_000,
  });
  const convection = new CloudSolver();
  world.add(convection, {
    cells: [4, 4, 4],
    cellSize: 8000,
    centre: [xCloud, z0],
    wind: weather.wind,
    surfaceHeat: 0,
    surfaceLatent: 0,
    interval: 1 / 60,
  });
  const cloudCentre = () => {
    let weightedNorth = 0,
      cloud = 0;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const c = weather.sample(i * spacing, j * spacing).cloud;
        cloud += c;
        weightedNorth += c * j * spacing;
      }
    return weightedNorth / cloud;
  };
  assert.equal(cloudCentre(), z0);
  assert.ok(weather.sample(xCloud, z0).wind[1] > 0);
  world.advance(1);
  assert.ok(weather.sample(x0, z0).pressure < weather.sample(x0 + 4 * spacing, z0).pressure);
  assert.ok(cloudCentre() > z0 + spacing / 2);
  assert.ok(convection.sample(xCloud, 1000, z0).velocity[2] > 0);
  closes(weather);
});

test('RITS-7 and WIND-2: the elevated vapour band travels with the flow and the high tier retains its core', async () => {
  const duration = 10_000;
  const measures = [];
  for (const fidelity of ['high', 'fast']) {
    const synoptic = await SynopticWeather.load();
    const world = build(synoptic, {
      meanWind: [10, 0],
      timeScale: duration * 60,
      fidelity,
      vapour: (x, z) => (x >= spacing && x <= 3 * spacing && z <= 2 * spacing ? 30 : 1),
      temperature: (x) => (x <= 3 * spacing ? 293.15 : 273.15),
    });
    world.advance(1);
    const core = synoptic.sample(7 * spacing, spacing),
      origin = synoptic.sample(2 * spacing, spacing);
    assert.ok(core.vapour > origin.vapour);
    near(core.ivt[0], 10 * core.vapour, 8 * Number.EPSILON * core.ivt[0]);
    assert.equal(core.ivt[1], 0);
    assert.ok(core.seaTemperature > synoptic.sample(11 * spacing, spacing).seaTemperature);
    measures.push(core.vapour);
    closes(synoptic);
  }
  assert.ok(measures[0] > measures[1]);
});

test('the native cloud and falling-water cascade matches the exact equal and unequal time solutions', async () => {
  const duration = 120,
    cloud = 4,
    initialFalling = 0.5,
    tc = 200;
  for (const tf of [200, 300]) {
    const synoptic = await SynopticWeather.load();
    const world = build(synoptic, {
      meanWind: [0, 0],
      vapour: 0,
      cloud,
      hydrometeors: initialFalling,
      cloudTime: tc,
      falloutTime: tf,
      timeScale: 60 * duration,
    });
    world.advance(1);
    const sample = synoptic.sample(0, 0);
    const qc = cloud * Math.exp(-duration / tc);
    const fall = Math.exp(-duration / tf);
    const qs = initialFalling * fall + (tf === tc ? (qc * duration) / tc : ((fall * cloud - qc) / (tc / tf - 1)) * -1);
    near(sample.cloud, qc, 32 * Number.EPSILON * cloud);
    near(sample.hydrometeors, qs, 32 * Number.EPSILON * cloud);
    near(duration * sample.precipitation, cloud + initialFalling - qc - qs, 32 * Number.EPSILON * cloud);
    closes(synoptic);
  }
});

test('Smith–Barstad Eq. 19: the irrotational terrain-wave limit attenuates lifting by 1/(1 + |k|Hw)', async () => {
  const [nx, nz] = grid,
    wind = 16,
    amplitude = 400,
    scale = 2500;
  const k = (2 * Math.PI) / (nx * spacing);
  for (const fidelity of ['high', 'fast']) {
    const solver = await SynopticWeather.load();
    const terrain = new TerrainBed();
    const world = new PhysicsWorld({ rate });
    world.add(terrain, {
      columns: nx,
      rows: 1,
      width: nx * spacing,
      depth: nz * spacing,
      centre: [(nx * spacing) / 2, (nz * spacing) / 2],
      elevations: Array.from({ length: nx + 1 }, (_, i) => amplitude * Math.cos(k * i * spacing)).flatMap((h) => [
        h,
        h,
      ]),
    });
    world.add(solver, {
      ...options,
      fidelity,
      meanWind: [wind, 0],
      bed: terrain.bed,
      coriolis: 0,
      moistStability: 0,
      moistDepth: scale,
    });
    const highAmplitude = (wind * amplitude * k) / (1 + k * scale);
    const fastAmplitude = (wind * amplitude * Math.sin(k * spacing)) / spacing;
    // Terrain stores vertices in f32. Parseval bounds the pointwise error by √nx times input rounding
    // times the largest derivative gain, Uπ/dx. The terrain-wave filter only decreases that gain.
    const precision = (Math.sqrt(nx) * amplitude * 2 ** -24 * wind * Math.PI) / spacing;
    for (let x = 0; x < nx; x++) {
      const expected = -(fidelity === 'high' ? highAmplitude : fastAmplitude) * Math.sin(k * x * spacing);
      near(solver.sample(x * spacing, 0).lift, expected, precision + 64 * Number.EPSILON * wind * amplitude * k);
    }
  }
});

test('a normally stratified moist wave has the Smith–Barstad phase lead and attenuation', async () => {
  const [nx, nz] = grid;
  const wind = 16;
  const amplitude = 400;
  const scale = 2500;
  const coriolis = 1e-4;
  const stability = 0.0104;
  const k = (2 * Math.PI) / (nx * spacing);
  const omega = wind * k;
  assert.ok(coriolis < omega && omega < stability);
  const terrain = new TerrainBed();
  const solver = await SynopticWeather.load();
  const world = new PhysicsWorld({ rate });
  world.add(terrain, {
    columns: nx,
    rows: 1,
    width: nx * spacing,
    depth: nz * spacing,
    centre: [(nx * spacing) / 2, (nz * spacing) / 2],
    elevations: Array.from({ length: nx + 1 }, (_, i) => amplitude * Math.cos(k * i * spacing)).flatMap((h) => [h, h]),
  });
  world.add(solver, {
    ...options,
    meanWind: [wind, 0],
    bed: terrain.bed,
    coriolis,
    moistStability: stability,
    moistDepth: scale,
  });
  // Equation 12 supplies the upward-propagating wavenumber. Equation 16 is
  // the slope wave with amplitude 1/|1−imH| and phase lead arg(1/(1−imH)).
  const m = k * Math.sqrt((stability * stability - omega * omega) / (omega * omega - coriolis * coriolis));
  const liftAmplitude = (amplitude * omega) / Math.hypot(1, m * scale);
  const phaseLead = Math.atan(m * scale);
  const encodingError = (Math.sqrt(nx) * amplitude * 2 ** -24 * wind * Math.PI) / spacing;
  const transformError = 64 * Number.EPSILON * amplitude * omega;
  for (let i = 0; i < nx; i++) {
    const x = i * spacing;
    near(solver.sample(x, 0).lift, -liftAmplitude * Math.sin(k * x + phaseLead), encodingError + transformError);
  }
});

test('RITS-8 and RITS-9: real terrain produces delayed upslope precipitation, snow and liquid runoff', async () => {
  const synoptic = await SynopticWeather.load();
  const world = new PhysicsWorld({ rate });
  const terrain = new TerrainBed();
  const width = grid[0] * spacing,
    depth = grid[1] * spacing;
  const hills = [0, 0, 0, 0, 1500, 3000, 3000, 1500, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  world.add(terrain, {
    columns: 16,
    rows: 1,
    width,
    depth,
    centre: [width / 2, depth / 2],
    elevations: hills.flatMap((height) => [height, height]),
  });
  world.add(synoptic, {
    ...options,
    bed: terrain.bed,
    timeScale: 7200,
    meanWind: [20, 0],
    temperature: 289,
    vapour: 30,
    cloudTime: 60,
    falloutTime: 90,
  });
  const weather = new PrecipitationField({ base: 1, source: synoptic.rainSource(), wind: synoptic.wind });
  const runoff = await RainfallRunoff.load();
  world.add(runoff, {
    nx: 1,
    nz: 1,
    dx: spacing,
    origin: [4 * spacing, 0],
    elevation: [0],
    downstream: [-1],
    drainage: 0,
    precipitation: weather,
    conductivity: 0,
  });
  world.advance(10);
  // Compare the two flanks at the same altitude. The valley beyond the lee may see wave recovery.
  const windward = synoptic.sample(4 * spacing, 0),
    leeward = synoptic.sample(7 * spacing, 0);
  assert.ok(windward.lift > 0 && leeward.lift < 0);
  assert.ok(windward.cloud > leeward.cloud && windward.precipitation > 0);
  const fallLow = weather.sample(4 * spacing, 2, 0, 0),
    fallHigh = weather.sample(4 * spacing, 3000, 0, 0);
  assert.ok(fallLow.rain.rate > fallLow.snow.rate && fallHigh.snow.rate > fallHigh.rain.rate);
  assert.ok(runoff.budget.rain > 0);
  closes(synoptic);
});

test('orographic ascent condenses only the saturated fraction and uses the transported air temperature', async () => {
  const [nx, nz] = grid;
  const elevations = [0, 0, 0, 0, 800, 1600, 1600, 800, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const duration = 25;
  const east = 20;
  const lapse = 0.0065;
  const index = 4;
  const displacement = (east * duration * (elevations[index + 1] - elevations[index - 1])) / (2 * spacing);
  const saturation = (seaTemperature) => {
    const local = seaTemperature - lapse * elevations[index];
    const vapourGas = 461.5;
    const airGas = 287.05;
    const latentHeat = 2.5e6;
    const vapourPressure = 611.2 * Math.exp((latentHeat / vapourGas) * (1 / 273.15 - 1 / local));
    const moistureHeight = (vapourGas * local * local) / (latentHeat * lapse);
    const vapourDensity = vapourPressure / (vapourGas * local);
    const epsilon = airGas / vapourGas;
    const mixingRatio = (epsilon * vapourPressure) / (101325 - vapourPressure);
    const moistLapse =
      (9.80665 * (1 + (latentHeat * mixingRatio) / (airGas * local))) /
      (1004 + (latentHeat * latentHeat * mixingRatio * epsilon) / (airGas * local * local));
    return { capacity: vapourDensity * moistureHeight, formed: (vapourDensity * moistLapse * displacement) / lapse };
  };
  const warm = saturation(296);
  const cool = saturation(280);
  assert.ok(warm.formed > cool.formed);
  const cases = [
    { temperature: 296, vapour: warm.capacity - 2 * warm.formed, expected: 0 },
    { temperature: 296, vapour: warm.capacity - warm.formed / 2, expected: warm.formed / 2 },
    { temperature: 296, vapour: warm.capacity, expected: warm.formed },
    { temperature: 280, vapour: cool.capacity, expected: cool.formed },
  ];
  for (const { temperature, vapour, expected } of cases) {
    const terrain = new TerrainBed();
    const synoptic = await SynopticWeather.load();
    const world = new PhysicsWorld({ rate });
    world.add(terrain, {
      columns: nx,
      rows: 1,
      width: nx * spacing,
      depth: nz * spacing,
      centre: [(nx * spacing) / 2, (nz * spacing) / 2],
      elevations: elevations.flatMap((height) => [height, height]),
    });
    world.add(synoptic, {
      ...options,
      bed: terrain.bed,
      fidelity: 'fast',
      coriolis: 0,
      meanWind: [east, 0],
      timeScale: 60 * duration,
      temperature,
      vapour,
      lapseRate: lapse,
    });
    world.advance(1);
    assert.equal(synoptic.budget.substeps, 1);
    const result = synoptic.sample(index * spacing, 0);
    const arithmeticError = 256 * Number.EPSILON * vapour;
    near(vapour - result.vapour, expected, arithmeticError);
    near(result.cloud + result.hydrometeors + result.precipitation * duration, expected, arithmeticError);
    closes(synoptic);
  }
});

test('atmospheric fallout reaches the runoff ledger as the same liquid volume on the same clock', async () => {
  const [nx, nz] = grid;
  const weather = await SynopticWeather.load();
  const runoff = await RainfallRunoff.load();
  const world = new PhysicsWorld({ rate });
  const initial = 1.25;
  const falloutTime = 90;
  world.add(weather, { ...options, meanWind: [0, 0], temperature: 296, hydrometeors: initial, falloutTime });
  const rain = new PrecipitationField({ base: 1, source: weather.rainSource(), wind: weather.wind });
  const count = nx * nz;
  world.add(runoff, {
    nx,
    nz,
    dx: spacing,
    origin: [-spacing / 2, -spacing / 2],
    elevation: Array(count).fill(0),
    downstream: Array(count).fill(-1),
    drainage: 0,
    conductivity: 0,
    precipitation: rain,
  });
  world.couple([weather.id, runoff.describe().id], 'staggered');
  const frames = 30;
  world.advance(frames);
  const area = count * spacing * spacing;
  const expectedVolume = (-initial * Math.expm1(-frames / (rate.num * falloutTime)) * area) / 1000;
  const roundoff = (256 * frames * Number.EPSILON * area * initial) / 1000;
  near(weather.budget.precipitation / 1000, expectedVolume, roundoff);
  near(runoff.budget.rain, expectedVolume, roundoff);
  closes(weather);
});

test('WIND-2: the live synoptic pressure gradient accelerates real shallow water', async () => {
  const synoptic = await SynopticWeather.load({ water: true });
  const world = new PhysicsWorld({ rate });
  const terrain = new TerrainBed();
  world.add(terrain, {
    columns: 2,
    rows: 1,
    width: 2 * spacing,
    depth: spacing,
    centre: [3 * spacing, 0],
    elevations: [-2, -2, -2, -2, -2, -2],
  });
  const water = new ShallowWaterSolver();
  world.add(water, { bed: terrain.bed, level: 0, roughness: 0 });
  world.add(synoptic, {
    ...options,
    coriolis: 1e-4,
    meanWind: [0, 0],
    streamfunction: (x) => 400_000 * Math.cos((2 * Math.PI * x) / (spacing * grid[0])),
    water: { columns: 2, rows: 1, spacing: [spacing, spacing], origin: [2.5 * spacing, 0], windStress: false },
  });
  world.couple([water.describe().id, synoptic.id], 'staggered');
  world.advance(8);
  const force = regionWords(world.memory, synoptic.exportPorts(8)[1].region);
  const gradient = (synoptic.sample(3 * spacing, 0).pressure - synoptic.sample(2 * spacing, 0).pressure) / spacing;
  assert.ok(gradient < 0 && force[0] > 0);
  near(force[0], (-2 * gradient) / 1000, 128 * Number.EPSILON * Math.abs(force[0]));
  assert.ok(water.sample(0, 0).velocity[0] > 0);
});

test('the configured neutral drag curve publishes signed relative wind stress to the water grid', async () => {
  for (const [wind, current, coefficient] of [
    [12, 2, 0.00142],
    [42, 2, 0.0025],
    [82, 2, 0.0025],
    [0, 10, 0.00142],
  ]) {
    const atmosphere = await SynopticWeather.load({ water: true });
    const world = new PhysicsWorld({ rate });
    const terrain = new TerrainBed();
    world.add(terrain, {
      columns: 2,
      rows: 2,
      width: 2 * spacing,
      depth: 2 * spacing,
      centre: [spacing, spacing],
      elevations: Array(9).fill(-2),
    });
    const water = new ShallowWaterSolver();
    world.add(water, {
      bed: terrain.bed,
      level: 0,
      velocity: () => [current, 0],
      roughness: 0,
      sides: { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' },
    });
    world.add(atmosphere, {
      ...options,
      meanWind: [wind, 0],
      water: { columns: 2, rows: 2, spacing: [spacing, spacing], origin: [spacing / 2, spacing / 2] },
    });
    world.couple([water.describe().id, atmosphere.id], 'staggered');
    world.advance(1);
    const air = atmosphere.wind.sample(spacing / 2, 10, spacing / 2, 0),
      relative = wind - current;
    const expected = (air.density * coefficient * Math.abs(relative) * relative) / 1000;
    const forcing = regionWords(world.memory, atmosphere.exportPorts(1)[1].region);
    near(forcing[0], expected, 32 * Number.EPSILON * Math.abs(expected));
    world.advance(2);
    assert.ok(Math.sign(water.sample(0, 0).velocity[0] - current) === Math.sign(relative));
  }
});

test('SynopticWeather has identical playback, partial snapshot and shared-memory replay', async () => {
  const solvers = await Promise.all(Array.from({ length: 7 }, () => SynopticWeather.load()));
  const params = {
    timeScale: 10000,
    vapour: (x) => (x < 2 * spacing ? 24 : 3),
    streamfunction: (x, z) => 200_000 * Math.sin(x / 80_000) * Math.cos(z / 60_000),
  };
  frameRateIndependent((playback) => build(solvers.pop(), params, playback));
  seekEqualsContinuous(() => build(solvers.pop(), params, { num: 24, den: 1 }));
  const plain = build(solvers.pop(), params);
  const shared = build(solvers.pop(), params, rate, true);
  plain.advance(30);
  shared.advance(30);
  assert.equal(plain.hash(), shared.hash());
});

test('a shifted regional wind cell restores with the snapshot and preserves all local samples', async () => {
  const weather = await SynopticWeather.load();
  const cell = [1200, 0, -1250];
  const world = new PhysicsWorld({ rate }).add(weather, { ...options, cell, meanWind: [8, -4] }, cell);
  world.advance(1);
  const wind = weather.wind.sample(0, 10, 0, 0);
  const snapshot = world.takeSnapshot();
  world.shiftOrigin([1000, 0, -1000]);
  world.advance(2);
  assert.deepEqual(weather.wind.cell, [200, 0, -250]);
  assert.deepEqual(weather.wind.sample(0, 10, 0, 0), wind);
  world.restoreSnapshot(snapshot.bytes);
  assert.equal(world.hash(), snapshot.hash);
  assert.deepEqual(weather.wind.cell, cell);
});

test('late invalid water forcing preserves the accepted atmosphere, coupled fields and native work', async () => {
  const cell = [-8, 2, 5];
  const world = new PhysicsWorld({ rate });
  const terrain = new TerrainBed();
  world.add(
    terrain,
    {
      columns: 2,
      rows: 2,
      width: 2 * spacing,
      depth: 2 * spacing,
      centre: [spacing, spacing],
      elevations: new Float64Array(9).fill(-2),
    },
    cell,
  );
  const water = new ShallowWaterSolver();
  world.add(water, { bed: terrain.bed, level: 0 }, cell);
  using atmosphere = await SynopticWeather.load({ water: true });
  world.add(
    atmosphere,
    {
      ...options,
      meanWind: [16, 5],
      hydrometeors: 0.1,
      layers: { altitudes: [1500, 5000] },
      water: { columns: 2, rows: 2, spacing: [spacing, spacing], origin: [spacing / 2, spacing / 2] },
    },
    cell,
  );
  world.couple([water.describe().id, atmosphere.id], 'staggered');
  world.advance(3);
  const first = world.takeSnapshot().bytes.slice();
  const work = atmosphere.readNativeWork();
  const before = atmosphere.budget;
  const layers = atmosphere.layerSubsteps;
  const owned = world.fields.port(SURFACE_WATER_FIELD.name);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const borrowed = { ...owned, region: { ...owned.region, memory, byteOffset: 32 } };
  const state = new Float32Array(memory.buffer, 32, 12);
  state.set(regionWords(world.memory, owned.region));
  const context = { tick: 3, level: 0, seed: 0, cell, inputs: new Map([[owned.field, borrowed]]) };
  state[11] = NaN;
  assert.throws(() => atmosphere.step(context, 1 / 60), {
    code: 'state',
    message: /finite north water momentum.*#synoptic/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, first);
  assert.deepEqual(atmosphere.budget, before);
  assert.deepEqual(atmosphere.readNativeWork(), work);
  assert.equal(atmosphere.layerSubsteps, layers);
  borrowed.region.byteOffset = 33;
  assert.throws(() => atmosphere.step(context, 1 / 60), {
    code: 'state',
    message: /aligned shallow-water rows.*#synoptic/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, first);
  borrowed.region.byteOffset = 32;
  state.set(regionWords(world.memory, owned.region));
  atmosphere.step(context, 1 / 60);
  const advanced = world.takeSnapshot().bytes.slice();
  world.restoreSnapshot(first);
  atmosphere.step(context, 1 / 60);
  assert.deepEqual(world.takeSnapshot().bytes, advanced);
  world.shiftOrigin([2, -4, 6]);
  assert.deepEqual(atmosphere.wind.cell, [-10, 6, -1]);
  for (const port of atmosphere.exportPorts(3)) assert.deepEqual(port.cell, atmosphere.wind.cell);
});

test('Phillips shear mode grows at the exact discrete two-layer rate, including thickness and altitude wind', async () => {
  const upper = -15,
    lower = 15,
    radius = 30_000,
    f = 1e-4,
    dt = 60,
    frames = 80;
  const angle = (2 * Math.PI) / grid[0],
    k = Math.sin(angle) / spacing;
  const laplace = (-4 * Math.sin(angle / 2) ** 2) / (spacing * spacing);
  const stretching = 0.5 / (radius * radius),
    factor = laplace * (laplace - 2 * stretching);
  const same = (laplace - stretching) / factor,
    off = -stretching / factor;
  const a = k * lower + k * stretching * (lower - upper) * same;
  const b = k * stretching * (lower - upper) * off;
  const growthRate = k * lower * Math.sqrt(-(laplace + 2 * stretching) / (laplace - 2 * stretching));
  const q1 = 1000 * laplace;
  const q2Re = (-a * q1) / b,
    q2Im = (growthRate * q1) / b;
  const lowerRe = same * q1 + off * q2Re,
    lowerIm = off * q2Im;
  const upperRe = off * q1 + same * q2Re,
    upperIm = same * q2Im;
  const wave = (re, im) => (x) => re * Math.cos((angle * x) / spacing) - im * Math.sin((angle * x) / spacing);
  const params = {
    coriolis: f,
    timeScale: 60 * dt,
    meanWind: [lower, 0],
    temperature: 288.15,
    streamfunction: wave(lowerRe, lowerIm),
    layers: {
      deformationRadius: radius,
      upperMeanWind: [upper, 0],
      upperStreamfunction: wave(upperRe, upperIm),
      altitudes: [1000, 5000],
      pressureLevels: [85_000, 50_000],
    },
  };
  const options = await Promise.all([SynopticWeather.load(), SynopticWeather.load()]);
  const worlds = options.map((weather, i) => build(weather, params, rate, Boolean(i)));
  const factorPerStep = (1 + (growthRate * dt) / 2) / (1 - (growthRate * dt) / 2);
  const gain = factorPerStep ** frames;
  const savedAt = 39;
  for (let i = 0; i < worlds.length; i++) {
    const world = worlds[i],
      weather = options[i];
    world.advance(savedAt);
    const saved = world.takeSnapshot();
    world.advance(frames);
    const final = world.hash();
    world.restoreSnapshot(saved.bytes);
    assert.equal(world.hash(), saved.hash);
    world.advance(frames);
    assert.equal(world.hash(), final);
    assert.equal(weather.layerSubsteps, frames);
    for (let j = 0; j < grid[0]; j++) {
      const x = j * spacing,
        row = weather.sampleLayers(x, 0);
      assert.ok(row);
      const wantLower = wave(lowerRe, lowerIm)(x) * gain,
        wantUpper = wave(upperRe, upperIm)(x) * gain;
      // Each time step runs four small 2D FFTs and a 2x2 solve. Bound roundoff by the accumulated operations
      // times the peak streamfunction and the predicted amplification.
      const bound =
        1024 * frames * Number.EPSILON * gain * Math.max(Math.abs(lowerRe), Math.abs(upperRe), Math.abs(upperIm));
      near(row.lowerStreamfunction, wantLower, bound);
      near(row.upperStreamfunction, wantUpper, bound);
      const thickness = f / (287.05 * Math.log(85_000 / 50_000));
      near(row.temperatureAnomaly, (wantUpper - wantLower) * thickness, 2 * thickness * bound);
      near(weather.sample(x, 0).seaTemperature, 288.15 + row.temperatureAnomaly, 32 * Number.EPSILON * 288.15);
      const middle = weather.wind.sample(x, 3000, 0, 0).velocity;
      near(middle[0], 0.5 * (row.lowerWind[0] + row.upperWind[0]), 64 * Number.EPSILON * Math.abs(upper));
      near(middle[2], 0.5 * (row.lowerWind[1] + row.upperWind[1]), 64 * Number.EPSILON * Math.abs(upper));
    }
    closes(weather);
  }
  assert.ok(gain > 2);
  assert.equal(worlds[0].hash(), worlds[1].hash());
});
