// The tracers' coupling checks (SEA-15): `TracerSolver` held to the harness, the same plume at 24, 30 and 60 frames a second
// and a seek equal to a continuous run, with a breach leaking ore and a slick drifting in a current.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { Physics } from '../../dist/index.js';
import { SpectralSea, WakeSolver } from '../../dist/sea.js';
import { KVLCC2_L7, ShipSolver } from '../../dist/ship.js';
import { TracerSolver } from '../../dist/tracers.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const water = {
  medium: 'water',
  cell: [0, 0, 0],
  sample(_x, y, _z, t, out = { velocity: [0, 0, 0], density: 1025, temperature: 285 }) {
    out.velocity[0] = 0.3 + 0.1 * Math.sin(t);
    out.velocity[1] = 0;
    out.velocity[2] = 0.05 * y;
    return out;
  },
};

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate }).add(new TracerSolver(), {
    water,
    capacity: 2000,
    sources: [
      { material: 'ironOre', position: (t) => [2 * t, -4, 0], rate: 30 },
      { material: 'oil', position: [0, 0, 3], rate: 20, stop: 0.5 },
    ],
  });

test('TracerSolver: the same plume at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('TracerSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

test('SEA-15 a finite waxy film thins to the Bingham yield level and conserves its oil', () => {
  const tracer = new TracerSolver();
  const volume = 0.004;
  const density = 894;
  const waterDensity = 1025;
  const viscosity = 1e-6;
  const yieldStress = 0.36;
  const mass = volume * density;
  const material = { density, floats: true, colour: [0.05, 0.03, 0.01] };
  const world = new PhysicsWorld({ rate: { num: 20, den: 1 } }).add(tracer, {
    waterDensity,
    viscosity,
    horizontalDiffusivity: 0,
    oilSpills: [{ mass, material, position: [0, 0], spreadingCoefficient: 0, yieldStress, parcels: 256 }],
  });
  assert.equal(tracer.oilFilm(0), undefined);
  const reducedGravity = 9.80665 * ((waterDensity - density) / waterDensity);
  const terminalThickness = (2 * Math.sqrt(3) * yieldStress) / (density * reducedGravity);
  const terminalRadius = Math.sqrt((3 * volume) / (2 * Math.PI * terminalThickness));
  // Independently integrate the differential equation for R⁴, with two different RK4 refinements.
  const dragScale = 1.45 ** 4 * ((reducedGravity * volume ** 2) / Math.sqrt(viscosity)) ** (2 / 3);
  const derivative = (areaSquared) =>
    dragScale * Math.max(0, 1 - Math.sqrt(areaSquared) / terminalRadius ** 2) ** (2 / 3);
  function reference(duration, count) {
    const dt = duration / count;
    let state = 0;
    for (let i = 0; i < count; i++) {
      const a = derivative(state);
      const b = derivative(state + (dt * a) / 2);
      const c = derivative(state + (dt * b) / 2);
      const d = derivative(state + dt * c);
      state += (dt * (a + 2 * b + 2 * c + d)) / 6;
    }
    return state ** 0.25;
  }
  world.advance(400);
  const fine = reference(20, 8192);
  const coarse = reference(20, 4096);
  const film = tracer.oilFilm(0);
  assert.ok(
    Math.abs(film.radius - fine) <= Math.abs(coarse - fine),
    `${film.radius} vs RK4 ${fine} (${coarse} coarse)`,
  );
  assert.ok(film.centreThickness > terminalThickness);
  assert.ok(Math.max(...film.centre.map(Math.abs)) < 1e-15);
  assert.ok(Math.abs(film.meanThickness * Math.PI * film.radius ** 2 - volume) <= 8 * Number.EPSILON * volume);
  const moment = [...tracer.particlesOf()].reduce((sum, { position, mass }) => {
    return sum + mass * (position[0] ** 2 + position[2] ** 2);
  }, 0);
  // The analytic radial moment is 2R²/5. Midpoint quantiles on a monotone function bound error by one stratum.
  assert.ok(Math.abs(moment / (mass * film.radius ** 2) - 0.4) <= 1 / 128);
  const snapshot = world.takeSnapshot();
  world.advance(1800);
  assert.ok(Math.abs(tracer.oilFilm(0).radius - terminalRadius) < 8 * Number.EPSILON * terminalRadius);
  assert.ok(Math.abs(tracer.oilFilm(0).centreThickness - terminalThickness) < 8 * Number.EPSILON * terminalThickness);
  assert.deepEqual(tracer.budget, { released: mass, water: 0, surface: mass, bed: 0 });
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(1800);
  assert.equal(world.hash(), hash);
});

test('SEA-15 yield resistance improves held-out terminal slick radii in the wax tank', (t) => {
  // Brönner et al. Tables 1–2. Densities and oscillatory rheometer readings drive the model.
  // The film observations were taken at 180 s. Group repeats by their stated experiment IDs:
  // WRD 11–13, 5% 14, 10% 8, 20% 15–17 and 30% 10.
  const observations = [
    [894, 0.36, 1.22, 1.28, 1.27],
    [894.1, 1.25, 1.21],
    [893.7, 0.46, 1.15],
    [893.1, 1.65, 0.77, 0.71, 0.79],
    [892.4, 13.6, 0.77],
  ];
  const volume = 0.004;
  const tracer = new TracerSolver();
  const oilSpills = observations.flatMap(([density, shear], group) =>
    [0, shear].map((yieldStress) => ({
      mass: volume * density,
      material: { density, floats: true, colour: [0.05, 0.03, 0.01] },
      position: [group * 8, yieldStress > 0 ? 0 : 8],
      spreadingCoefficient: 0,
      yieldStress,
      parcels: 8,
    })),
  );
  const world = new PhysicsWorld({ rate: { num: 2, den: 1 } }).add(tracer, { oilSpills, horizontalDiffusivity: 0 });
  world.advance(360);
  let baseline = 0;
  let corrected = 0;
  let count = 0;
  let worst = 1;
  for (const [group, [, , ...radii]] of observations.entries()) {
    const unyielded = tracer.oilFilm(2 * group).radius;
    const waxy = tracer.oilFilm(2 * group + 1).radius;
    for (const measured of radii) {
      baseline += Math.log(unyielded / measured) ** 2;
      corrected += Math.log(waxy / measured) ** 2;
      worst = Math.max(worst, measured / waxy, waxy / measured);
      count++;
    }
  }
  assert.ok(corrected < baseline, 'yield should reduce the RMS log radius error across all tank observations');
  t.diagnostic(
    `RMS log radius error ${Math.sqrt(baseline / count).toFixed(3)} → ${Math.sqrt(corrected / count).toFixed(3)}. Worst ratio ${worst.toFixed(2)}.`,
  );
});

test('SEA-15 wax and constant-rate oil releases validate their time and forcing bounds', () => {
  const release = { mass: 1, position: [0, 0], spreadingCoefficient: 0 };
  const add = (settings) => new PhysicsWorld().add(new TracerSolver(), { oilSpills: [{ ...release, ...settings }] });
  assert.throws(() => add({ yieldStress: -1 }), /nonnegative shear yield stress/);
  assert.throws(() => add({ yieldStress: 1, spreadingCoefficient: 0.001 }), /fixed-volume gravity-spreading/);
  assert.throws(() => add({ yieldStress: 1, evaporation: {} }), /fixed-volume gravity-spreading/);
  assert.throws(() => add({ yieldStress: 1, dispersion: {} }), /fixed-volume gravity-spreading/);
  assert.throws(() => add({ releaseDuration: Infinity }), /nonnegative duration/);
  assert.throws(() => add({ releaseDuration: 1, yieldStress: 1 }), /fed oil patch uses gravity spreading/);
  assert.throws(() => add({ releaseDuration: 1, spreadingCoefficient: 0.001 }), /fed oil patch uses gravity spreading/);
});

test('SEA-15 constant-rate gravity spreading tracks the held-out MGO tank run through feed shutoff', (t) => {
  // Brönner et al. (2018), Table 1 and section 3: 2 L/min for 120 s, marine gas oil, experiment 18.
  const material = { density: 846, floats: true, colour: [0.05, 0.03, 0.01] };
  const volume = 0.004;
  const mass = volume * material.density;
  const releaseDuration = 120;
  const start = 0.25;
  const rate = 4;
  const waterDensity = 1025;
  const tracer = new TracerSolver();
  const batch = { mass, material, start, position: [0, 0], parcels: 32, spreadingCoefficient: 0 };
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 } }).add(tracer, {
    waterDensity,
    viscosity: 1e-6,
    horizontalDiffusivity: 0,
    oilSpills: [
      { ...batch, releaseDuration },
      { ...batch, position: [10, 0] },
    ],
  });
  world.advance(start * rate);
  assert.equal(tracer.budget.released, 0);
  assert.equal(tracer.oilFilm(0), undefined);
  assert.equal(tracer.oilFilm(1), undefined);
  const reducedGravity = (9.80665 * (waterDensity - material.density)) / waterDensity;
  // Maderich et al., Eqs. 27 and 30, use different prefactors for continuous and fixed-volume radial motion.
  const scale = ((reducedGravity * volume ** 2) / 1e-3) ** (1 / 6);
  const stoppedAt = 0.816 * scale * releaseDuration ** 0.25;
  const instantaneous = 1.06 * scale;
  const coastBias = (stoppedAt / instantaneous) ** 4;
  // Fig. 4, open circles, metres. Axes read to the nearest centimetre. These radii are not model inputs.
  const observations = [
    [30, 0.73],
    [60, 1.14],
    [90, 1.43],
    [120, 1.63],
    [180, 1.84],
    [240, 1.91],
  ];
  let baseline = 0;
  let fed = 0;
  let maxRelativeError = 0;
  let snapshot;
  for (const [time, observed] of observations) {
    world.advance((time + start) * rate);
    const film = tracer.oilFilm(0);
    const fraction = Math.min(1, time / releaseDuration);
    const expected =
      time <= releaseDuration
        ? stoppedAt * fraction ** (7 / 12)
        : instantaneous * (coastBias + time - releaseDuration) ** 0.25;
    assert.ok(Math.abs(film.radius - expected) < 64 * Number.EPSILON * expected);
    assert.ok(Math.abs(film.meanThickness * Math.PI * film.radius ** 2 - volume * fraction) < 1e-16);
    const released = mass * (1 + fraction);
    assert.ok(
      Math.abs(tracer.budget.released - released) < 64 * Number.EPSILON * released,
      `${tracer.budget.released} vs ${released} kg at ${time} s`,
    );
    assert.equal(tracer.budget.surface, tracer.budget.released);
    assert.equal(tracer.budget.water, 0);
    const batchRadius = tracer.oilFilm(1).radius;
    baseline += (batchRadius - observed) ** 2;
    fed += (film.radius - observed) ** 2;
    maxRelativeError = Math.max(maxRelativeError, Math.abs(film.radius - observed) / observed);
    if (time === 60) snapshot = world.takeSnapshot();
  }
  assert.ok(fed < baseline, 'the feed model must explain more of the observed radius history than an instant release');
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance((240 + start) * rate);
  assert.equal(world.hash(), hash);
  t.diagnostic(
    `RMS radius error ${Math.sqrt(baseline / observations.length).toFixed(3)} → ${Math.sqrt(fed / observations.length).toFixed(3)} m. Peak relative error ${(100 * maxRelativeError).toFixed(1)}%.`,
  );
});

test('SEA-15 a slick rides live wave height while dye follows submerged orbital flow across an origin cell', () => {
  const frequencies = new Float64Array([0.2, 0.4, 0.6]);
  const directions = new Float64Array([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  const energy = new Float64Array(12);
  energy[4] = 0.25 / (0.2 * Math.PI);
  const sea = new SpectralSea({ waves: { frequencies, directions, energy, depth: Infinity, density: 1025 } });
  const tracer = new TracerSolver();
  const dt = 1 / 60;
  const cellSize = 128;
  const stillLevel = 1.25;
  let x = -cellSize;
  let z = 0;
  let dx = x;
  let dy = stillLevel - 2;
  let dz = z;
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, cellSize })
    .add(tracer, {
      sea,
      cellSize,
      waterLevel: stillLevel,
      sources: [
        { material: 'oil', position: [x, 0, z], rate: 60, stop: dt },
        { material: 'dye', position: [dx, dy, dz], rate: 60, stop: dt },
      ],
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
    })
    .setCell('tracers', [1, 0, 0]);
  for (let step = 1; step <= 18; step++) {
    const time = step * dt;
    const { velocity } = sea.sample(x + cellSize, z, time);
    x += velocity[0] * dt;
    z += velocity[2] * dt;
    const y = stillLevel + sea.elevation(x + cellSize, z, time);
    const submerged = sea.water.sample(dx + cellSize, dy - stillLevel, dz, time).velocity;
    dx += submerged[0] * dt;
    dy += submerged[1] * dt;
    dz += submerged[2] * dt;
    world.advance(step);
    const particles = [...tracer.particlesOf()];
    assert.equal(particles.length, 2);
    assert.equal(particles[0].state, 'surface');
    assert.deepEqual(particles[0].position, [x, y, z]);
    assert.equal(particles[1].state, 'water');
    assert.deepEqual(particles[1].position, [dx, dy, dz]);
  }
  assert.notEqual(x, -cellSize);
  assert.equal(tracer.budget.surface, 1);
  assert.equal(tracer.budget.water, 1);
  const snapshot = world.takeSnapshot();
  world.advance(25);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(25);
  assert.equal(world.hash(), hash);

  const depthSpeed = 2;
  const crest = sea.elevation(0, 0, dt);
  const reflection = new TracerSolver();
  const secondWorld = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(reflection, {
    sea,
    water: { ...water, sample: () => ({ velocity: [0, depthSpeed, 0], density: 1025, temperature: 285 }) },
    sources: [{ material: 'dye', position: [0, crest - dt, 0], rate: 60, stop: dt }],
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
  });
  secondWorld.advance(1);
  const [parcel] = [...reflection.particlesOf()];
  assert.ok(Math.abs(parcel.position[1] - (crest - dt)) < 4 * Number.EPSILON);
  assert.equal(parcel.state, 'water');
});

test('SEA-15 dye follows the SEA-04 patch potential below a level surface', () => {
  const cells = 64;
  const spacing = 0.25;
  const k = (2 * Math.PI * 2) / (cells * spacing);
  const potential = 0.2;
  const wake = new WakeSolver();
  new PhysicsWorld().add(wake, {
    cells: [cells, cells],
    cellSize: spacing,
    sponge: 0,
    depth: Infinity,
    waterBelow: true,
    initial: (x) => [0, potential * Math.cos(k * x)],
  });
  const calm = {
    frequencies: Float64Array.from([0.1, 0.2]),
    directions: Float64Array.from([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]),
    energy: new Float64Array(8),
    depth: Infinity,
    density: 1025,
  };
  // Pick a published depth layer and exact cell centres, where no interpolation error enters the potential gradient.
  const initial = [2.125, -0.5, -4.875];
  const dt = 1 / 60;
  const sample = (patches) => {
    const sea = new SpectralSea({ waves: calm, patches });
    const tracer = new TracerSolver();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
      sea,
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
      sources: [{ material: 'dye', position: initial, rate: 60, stop: dt }],
    });
    world.advance(1);
    assert.equal(tracer.budget.water, 1);
    return [...tracer.particlesOf()][0].position;
  };
  const [x, y, z] = initial;
  const flow = potential * k * Math.exp(k * y);
  const moved = sample([wake]);
  const expected = [x - dt * flow * Math.sin(k * x), y + dt * flow * Math.cos(k * x), z];
  for (let axis = 0; axis < 3; axis++)
    assert.ok(Math.abs(moved[axis] - expected[axis]) < 64 * Number.EPSILON, `${moved} vs ${expected}`);
  assert.ok(moved[0] < x);
  assert.deepEqual(sample([]), initial);
});

test('SEA-15 an oil release conserves mass and expands through Fay’s three radial regimes', () => {
  const mass = 0.025;
  const oil = 870;
  const waterDensity = 1025;
  const nu = 1e-6;
  const strength = 0.0003;
  const gravity = 9.80665;
  const volume = mass / oil;
  const reducedG = gravity * (1 - oil / waterDensity);
  const positions = [0.25, -0.5];
  const tracer = new TracerSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
    capacity: 64,
    waterDensity,
    viscosity: nu,
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
    oilSpills: [{ mass, position: positions, spreadingCoefficient: strength, parcels: 64 }],
  });
  // Fay 1971, Tables I and II. The times lie inside the indicated dominant regimes.
  const cases = [
    [0.5, (t) => 1.14 * (reducedG * volume * t * t) ** 0.25],
    [10, (t) => 1.45 * ((reducedG * volume * volume * t ** 1.5) / Math.sqrt(nu)) ** (1 / 6)],
    [40, (t) => 2.3 * ((strength * strength * t ** 3) / (waterDensity * waterDensity * nu)) ** 0.25],
  ];
  let saved;
  for (const [time, radius] of cases) {
    world.advance(time * 60);
    const particles = [...tracer.particlesOf()];
    assert.equal(particles.length, 64);
    assert.equal(tracer.budget.released, mass);
    assert.equal(tracer.budget.surface, mass);
    let squared = 0;
    for (const particle of particles) {
      assert.equal(particle.state, 'surface');
      squared += (particle.position[0] - positions[0]) ** 2 + (particle.position[2] - positions[1]) ** 2;
    }
    const equivalent = Math.sqrt((2 * squared) / particles.length);
    assert.ok(
      Math.abs(equivalent - radius(time)) < 2e-12 * radius(time),
      `${equivalent} vs ${radius(time)} at ${time} s`,
    );
    if (time === 10) saved = world.takeSnapshot();
  }
  const hash = world.hash();
  world.restoreSnapshot(saved.bytes);
  world.advance(40 * 60);
  assert.equal(world.hash(), hash);
});

test('SEA-15 a delayed oil spill keeps its slots and follows the current alongside an ordinary source', () => {
  const tracer = new TracerSolver();
  const dt = 1 / 60;
  const oilMass = 0.5;
  const flow = { ...water, sample: () => ({ velocity: [0.25, 0, -0.5], density: 1025, temperature: 280 }) };
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
    capacity: 3,
    water: flow,
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
    sources: [{ material: 'dye', position: [0, -1, 0], rate: 60, stop: dt }],
    oilSpills: [{ mass: oilMass, position: [4, 2], start: 1, spreadingCoefficient: 0, parcels: 2 }],
  });
  world.advance(60);
  assert.equal([...tracer.particlesOf()].length, 1);
  assert.equal(tracer.budget.surface, 0);
  world.advance(61);
  const particles = [...tracer.particlesOf()];
  const oil = particles.filter((parcel) => parcel.state === 'surface');
  assert.equal(oil.length, 2);
  assert.equal(oil[0].mass + oil[1].mass, oilMass);
  assert.equal(tracer.budget.water, 1);
  const centre = (axis) => (oil[0].position[axis] + oil[1].position[axis]) / 2;
  assert.ok(Math.abs(centre(0) - (4 + 0.25 * dt)) < 8 * Number.EPSILON);
  assert.ok(Math.abs(centre(2) - (2 - 0.5 * dt)) < 8 * Number.EPSILON);
});

test('SEA-15 evaporation integrates the spreading area and conserves released, liquid and vapour mass', () => {
  const mass = 0.025;
  const volume = mass / 870;
  const buoyancy = 9.80665 * (1 - 870 / 1025);
  const tension = 0.0003;
  const evaporation = {
    temperature: 290,
    initialBoilingPoint: 400,
    distillationSlope: 650,
    massTransferCoefficient: 0.003,
  };
  const expected = (age) => {
    // Integrate the published radius curves by midpoint quadrature, independently of the solver's analytic area integral.
    const width = age / 32_768;
    let area = 0;
    for (let i = 0; i < 32_768; i++) {
      const t = (i + 0.5) * width;
      const inertial = 1.14 * (buoyancy * volume * t ** 2) ** 0.25;
      const viscous = 1.45 * ((buoyancy * volume ** 2 * t ** 1.5) / 1e-3) ** (1 / 6);
      const surface = 2.3 * ((tension ** 2 * t ** 3) / (1025 ** 2 * 1e-6)) ** 0.25;
      area += Math.max(Math.min(inertial, viscous), surface) ** 2;
    }
    const theta = (evaporation.massTransferCoefficient * Math.PI * area * width) / volume;
    const gradient = (10.3 * evaporation.distillationSlope) / evaporation.temperature;
    return (
      (mass *
        Math.log1p(
          gradient * theta * Math.exp(6.3 - (10.3 * evaporation.initialBoilingPoint) / evaporation.temperature),
        )) /
      gradient
    );
  };
  const start = 0.25;
  const times = [0.8, 10.3, 40.3]; // One age in each Fay regime, at clock times common to both rates.
  const reference = times.map((time) => expected(time - start));
  const coarse = [];
  for (const rate of [30, 60]) {
    const tracer = new TracerSolver();
    const world = new PhysicsWorld({ rate: { num: rate, den: 1 } }).add(tracer, {
      capacity: 8,
      oilSpills: [{ mass, position: [0, 0], start, spreadingCoefficient: tension, parcels: 8, evaporation }],
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
    });
    world.advance(Math.floor(start * rate));
    assert.equal(tracer.evaporatedMass, 0);
    assert.equal(tracer.budget.released, 0);
    let save;
    for (const [i, time] of times.entries()) {
      world.advance(Math.round(time * rate));
      const want = reference[i];
      assert.ok(Math.abs(tracer.evaporatedMass - want) < 2e-10, `${tracer.evaporatedMass} vs ${want} kg`);
      if (rate === 30) coarse.push(tracer.evaporatedMass);
      else assert.equal(tracer.evaporatedMass, coarse[i]);
      const { released, surface } = tracer.budget;
      const parcelMass = [...tracer.particlesOf()].reduce((sum, p) => sum + p.mass, 0);
      assert.equal(released, mass);
      assert.ok(Math.abs(surface + tracer.evaporatedMass - released) < 1e-15);
      assert.ok(Math.abs(surface - parcelMass) < 1e-15);
      if (i === 1) save = world.takeSnapshot();
    }
    const hash = world.hash();
    world.restoreSnapshot(save.bytes);
    world.advance(Math.round(times.at(-1) * rate));
    assert.equal(world.hash(), hash);
  }
});

test('SEA-15 fixed-area exposure agrees with independent 0 °C Norman Wells evaporation measurements', (t) => {
  // Stiver and Mackay (EE-49, 1983). Fit the boiling curve to the 12 Norman Wells markers in Fig. 9.
  // The evaporation measurements in Fig. 12 were collected at 0 °C, outside the 22 °C rate regression.
  const evaporation = {
    temperature: 273.15,
    initialBoilingPoint: 380.03,
    distillationSlope: 463.83,
    massTransferCoefficient: 0.01,
    referenceThickness: 1e-5,
  };
  const measured = [
    [560, 0.0791],
    [1490, 0.1243],
    [4210, 0.1795],
    [9370, 0.2291],
    [13240, 0.249],
    [20660, 0.2774],
    [32280, 0.299],
  ];
  const mass = 0.025;
  const rate = 60;
  const exposureRate = evaporation.massTransferCoefficient / evaporation.referenceThickness;
  const tracer = new TracerSolver();
  const world = new PhysicsWorld({ rate: { num: rate, den: 1 } }).add(tracer, {
    capacity: 4,
    oilSpills: [{ mass, position: [0, 0], spreadingCoefficient: 0, parcels: 4, evaporation }],
    horizontalDiffusivity: 0,
  });
  const slope = (10.3 * evaporation.distillationSlope) / evaporation.temperature;
  let maximumError = 0;
  for (const [exposure, fraction] of measured) {
    world.advance(Math.round((exposure / exposureRate) * rate));
    // The distillation fit residual plus plot reading uncertainty is ≤4.3 K. The largest effect
    // on evaporated fraction is that error divided by the distillation slope (Eq. 13).
    // Fig. 12 reading adds 0.001 in fraction and up to 75 in exposure, plus half a tick.
    const exposureError = 75 + exposureRate / (2 * rate);
    const bound = 4.3 / evaporation.distillationSlope + 0.001 + Math.log(exposure / (exposure - exposureError)) / slope;
    const predicted = tracer.evaporatedMass / mass;
    const error = Math.abs(predicted - fraction);
    assert.ok(error <= bound, `exposure ${exposure}: ${predicted} vs ${fraction} ± ${bound}`);
    assert.ok(Math.abs(tracer.budget.surface + tracer.evaporatedMass - mass) < 1e-15);
    maximumError = Math.max(maximumError, error);
  }
  t.diagnostic(`Peak evaporation error ${(100 * maximumError).toFixed(2)} percentage points.`);
});

test('SEA-15 fixed evaporative exposure requires a finite positive reference thickness', () => {
  for (const referenceThickness of [0, -1e-5, NaN, Infinity]) {
    const tracer = new TracerSolver();
    const evaporation = {
      temperature: 273.15,
      initialBoilingPoint: 380,
      distillationSlope: 460,
      massTransferCoefficient: 0.01,
      referenceThickness,
    };
    assert.throws(
      () =>
        new PhysicsWorld().add(tracer, {
          capacity: 2,
          oilSpills: [{ mass: 0.025, position: [0, 0], spreadingCoefficient: 0, parcels: 2, evaporation }],
        }),
      /positive finite referenceThickness/,
    );
  }
});

test('SEA-15 a completely evaporated release clears its parcels and leaves the other slick unchanged', () => {
  const tracer = new TracerSolver();
  const config = { temperature: 300, initialBoilingPoint: 300, distillationSlope: 0, massTransferCoefficient: 3 };
  const world = new PhysicsWorld().add(tracer, {
    capacity: 4,
    oilSpills: [
      { mass: 0.02, position: [-1, 0], spreadingCoefficient: 0.01, parcels: 2, evaporation: config },
      {
        mass: 0.03,
        position: [1, 0],
        spreadingCoefficient: 0,
        parcels: 2,
        evaporation: { ...config, massTransferCoefficient: 0 },
      },
    ],
    horizontalDiffusivity: 0,
  });
  world.advance(120);
  const parcels = [...tracer.particlesOf()];
  assert.equal(parcels.length, 2);
  assert.equal(parcels[0].mass + parcels[1].mass, 0.03);
  assert.equal(tracer.evaporatedMass, 0.02);
  assert.ok(Math.abs(tracer.budget.surface - 0.03) < 1e-16);
  assert.equal(tracer.budget.released, 0.05);
});

function verticalMoments(tracer, initialHeight) {
  const heights = [...tracer.particlesOf()].map((parcel) => parcel.position[1] - initialHeight);
  const mean = heights.reduce((total, height) => total + height, 0) / heights.length;
  const variance = heights.reduce((total, height) => total + (height - mean) ** 2, 0) / (heights.length - 1);
  return { mean, variance };
}

test('SEA-15 a vertical diffusivity gradient gives the drift and midpoint variance in a linear mixing layer', () => {
  const surface = 5;
  const depth = 14;
  const n = 8192;
  const worldRate = { num: 60, den: 1 };
  const dt = 1 / worldRate.num;
  const tracer = new TracerSolver();
  const world = new PhysicsWorld({ rate: worldRate }).add(tracer, {
    waterLevel: surface,
    sources: [{ material: 'dye', position: [0, surface - depth, 0], rate: n / dt, stop: dt }],
    capacity: n,
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
    verticalDiffusivityProfile: [
      { depth: 10, diffusivity: 0.2 / dt },
      { depth: 20, diffusivity: 1.4 / dt },
    ],
  });
  world.advance(1);
  const { mean, variance } = verticalMoments(tracer, surface - depth);
  // Fick's law in a locally linear layer gives a drift -K′t of -0.12 m and variance 2 K₀t + (K′t)².
  const want = 2 * 0.68 + 0.12 ** 2;
  const meanSE = Math.sqrt(want / n);
  const varianceSE = want * Math.sqrt(2 / (n - 1));
  assert.ok(Math.abs(mean + 0.12) < 4 * meanSE, `${mean} vs -0.12 m`);
  assert.ok(Math.abs(variance - want) < 4 * varianceSE, `${variance} vs ${want} m²`);
  assert.equal(tracer.budget.water, n);
  // A uniform control sees the same normal for parcel zero. Only the drift differs at the sampled midpoint K.
  const control = new TracerSolver();
  const controlWorld = new PhysicsWorld({ rate: worldRate }).add(control, {
    waterLevel: surface,
    capacity: 1,
    sources: [{ material: 'dye', position: [0, surface - depth, 0], rate: 1 / dt, stop: dt }],
    horizontalDiffusivity: 0,
    verticalDiffusivity: (0.68 + 0.12 ** 2 / 2) / dt,
  });
  controlWorld.advance(1);
  const drift = tracer.particlesOf().next().value.position[1] - control.particlesOf().next().value.position[1];
  assert.ok(Math.abs(drift + 0.12) < 8 * Number.EPSILON, `${drift} vs -0.12 m after equal noise`);
  const save = world.takeSnapshot();
  world.advance(3);
  const hash = world.hash();
  world.restoreSnapshot(save.bytes);
  world.advance(3);
  assert.equal(world.hash(), hash);
});

test('SEA-15 CMO experiment 4 compares a profile from microstructure with separate Rhodamine dispersion', () => {
  // Oakey & Greenan (2004), Table 2. The midpoint of the independent EPSONDE range (1.0–2.0) drives local diffusion.
  const microstructure = 1.5e-6;
  const depth = 17;
  const n = 4096;
  const hours = 97;
  const hour = 3600;
  const rate = { num: 60, den: 1 };
  const dt = 1 / rate.num;
  // In still water, replacing each physical hour by one world step leaves the diffusion product K·t unchanged.
  const accelerated = (microstructure * hour) / dt;
  const tracer = new TracerSolver();
  const world = new PhysicsWorld({ rate }).add(tracer, {
    capacity: n,
    bed: 70,
    horizontalDiffusivity: 0,
    verticalDiffusivityProfile: [
      { depth: 14, diffusivity: accelerated },
      { depth: 20, diffusivity: accelerated },
    ],
    sources: [{ material: 'dye', position: [0, -depth, 0], rate: n / dt, stop: dt }],
  });
  world.advance(hours);
  const { variance } = verticalMoments(tracer, -depth);
  const inferred = variance / (2 * hours * hour);
  // Held-out response: dye-based 1.8 ± 0.4 from Ledwell et al. (2004), Fig. 14, inferred from fluorescence surveys.
  assert.ok(inferred >= 1.4e-6 && inferred <= 2.2e-6, `${inferred} m²/s from parcel dispersion`);
  assert.equal(tracer.budget.water, n);
});

test('SEA-15 wave-averaged tracers follow the directional Stokes transport in deep and finite water', () => {
  const gravity = 9.80665;
  const waveNumbers = [0.18, 0.46];
  const amplitudes = [0.3, 0.15];
  const headings = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const level = 1.25;
  const releaseDepths = [0, 0.75, 4];
  const rate = { num: 60, den: 1 };
  for (const depth of [Infinity, 7]) {
    // Pick two exact roots of linear dispersion, then obtain their corresponding frequency bins.
    const omega = waveNumbers.map((k) => Math.sqrt(gravity * k * Math.tanh(k * depth)));
    const frequencies = Float64Array.from(omega, (speed) => speed / (2 * Math.PI));
    const width = frequencies[1] - frequencies[0];
    const energy = new Float64Array(8);
    energy[0] = amplitudes[0] ** 2 / (2 * width * (Math.PI / 2));
    energy[5] = amplitudes[1] ** 2 / (2 * width * (Math.PI / 2));
    const waves = { frequencies, directions: Float64Array.from(headings), energy, depth, density: 1025 };
    const sea = new SpectralSea({ waves });
    const tracer = new TracerSolver();
    const mean = depth === Infinity ? undefined : [0.1, 0, -0.045];
    const world = new PhysicsWorld({ rate }).add(tracer, {
      capacity: 3,
      sea,
      water: mean && { ...water, sample: () => ({ velocity: mean, density: 1025, temperature: 285 }) },
      stokesSpectrum: waves,
      waterLevel: level,
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
      sources: releaseDepths.map((d, index) => ({
        material: index === 0 ? 'oil' : 'dye',
        position: [0, level - d, 0],
        rate: 60,
        stop: 1 / 60,
      })),
    });
    world.advance(60);
    const snapshot = world.takeSnapshot();
    const seconds = 2.5;
    world.advance(60 * seconds);
    const particles = [...tracer.particlesOf()];
    for (const [index, d] of releaseDepths.entries()) {
      const wants = waveNumbers.map((k, i) => {
        // Breivik et al. (2014), eqs. 1 and 4, per monochromatic component; use the cosh/sinh form in finite water.
        const weight =
          depth === Infinity ? Math.exp(-2 * k * d) : Math.cosh(2 * k * (depth - d)) / (2 * Math.sinh(k * depth) ** 2);
        return (amplitudes[i] ** 2 * omega[i] * k * weight + (mean?.[i * 2] ?? 0)) * seconds;
      });
      const [x, y, z] = particles[index].position;
      assert.ok(Math.abs(x - wants[0]) < 1e-12, `${x} vs ${wants[0]} at ${d} m`);
      assert.ok(Math.abs(z - wants[1]) < 1e-12, `${z} vs ${wants[1]} at ${d} m`);
      if (index === 0) assert.equal(y, level + sea.elevation(x, z, seconds));
      else assert.equal(y, level - d);
    }
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance(60 * seconds);
    assert.equal(world.hash(), hash);
  }
});

test('SEA-15 shallow-wave Stokes drift agrees with independent particle-tracking profiles', (t) => {
  // Melito et al. (2026), section 3.1: camera waterline, measured above the platform.
  const depth = 0.12;
  const period = 1;
  const amplitude = 0.025 / 2;
  const density = 1000;
  const spectrum = {
    frequencies: new Float64Array([1 / period]),
    directions: new Float64Array([0]),
    energy: new Float64Array([(amplitude * amplitude * period) / (4 * Math.PI)]),
    depth,
    density,
  };
  // Fig. 7 red triangles, mm/s, for the three six-wave blocks. The velocity observations come from the
  // Lagrangian–Eulerian difference of subsurface particle tracks. No velocity enters the simulated spectrum.
  const profiles = [
    [0.05, [7.2, 6.5, 5.1]],
    [0.06, [6.0, 4.7, 4.6]],
    [0.075, [5.2, 4.4, 4.0]],
    [0.09, [5.6, 4.8, 3.7]],
    [0.1, [4.7, 4.0, 4.0]],
  ];
  const tracer = new TracerSolver();
  const hz = 60;
  const world = new PhysicsWorld({ rate: { num: hz, den: 1 } }).add(tracer, {
    waterDensity: density,
    bed: depth,
    stokesSpectrum: spectrum,
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
    sources: profiles.map(([depth]) => ({ material: 'dye', rate: hz, stop: 1 / hz, position: [0, -depth, 0] })),
  });
  const duration = 6;
  world.advance(hz * duration);
  const particles = [...tracer.particlesOf()];
  assert.equal(particles.length, profiles.length);
  // Axis tick spacing is 5 mm/s per 48 pixels. Allow two pixels for reading an overlapping marker.
  const digitization = (2 * 5) / 48;
  const velocities = [];
  let squared = 0;
  for (const [i, [depth, blocks]] of profiles.entries()) {
    const [x, y, z] = particles[i].position;
    const speed = (x / duration) * 1000;
    assert.equal(y, -depth);
    assert.equal(z, 0);
    assert.ok(speed >= Math.min(...blocks) - digitization && speed <= Math.max(...blocks) + digitization);
    for (const measured of blocks) squared += (speed - measured) ** 2;
    velocities.push(speed.toFixed(2));
  }
  const rmse = Math.sqrt(squared / (profiles.length * 3));
  t.diagnostic(`Drift ${velocities.join(', ')} mm/s. RMS error across the 15 measured values ${rmse.toFixed(2)} mm/s.`);
});

function radialVariance(particles) {
  const n = particles.length;
  const cx = particles.reduce((sum, p) => sum + p.position[0], 0) / n;
  const cz = particles.reduce((sum, p) => sum + p.position[2], 0) / n;
  return particles.reduce((sum, p) => sum + (p.position[0] - cx) ** 2 + (p.position[2] - cz) ** 2, 0) / (n - 1);
}

test('SEA-15 a Richardson cloud grows cubically from each release time and replays its age state', () => {
  const n = 4096;
  const dt = 1 / 60;
  const delayedStop = 61 / 60;
  const tracer = new TracerSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
    capacity: 2 * n,
    horizontalDiffusivity: 0.75,
    horizontalDispersion: { referenceScale: 3 },
    verticalDiffusivity: 0,
    sources: [
      { material: 'dye', position: [0, -1, 0], rate: n / dt, start: 0, stop: dt },
      { material: 'dye', position: [50, -1, 0], rate: n / (delayedStop - 1), start: 1, stop: delayedStop },
    ],
  });
  world.advance(60);
  const initial = [...tracer.particlesOf()];
  assert.equal(initial.length, n);
  // With K_ref=3/4 m²/s at 3 m, the radial variance satisfies q′=3q^(2/3) and q=t³ from a point.
  const fractionalSE = 1 / Math.sqrt(n - 1);
  assert.ok(Math.abs(radialVariance(initial) - 1) < 6 * fractionalSE);
  const snapshot = world.takeSnapshot();
  world.advance(120);
  const particles = [...tracer.particlesOf()];
  assert.equal(particles.length, 2 * n);
  for (const [cohort, want] of [
    [particles.slice(0, n), 8],
    [particles.slice(n), 1],
  ]) {
    const variance = radialVariance(cohort);
    assert.ok(Math.abs(variance - want) < 6 * want * fractionalSE, `${variance} vs ${want} m²`);
  }
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(120);
  assert.equal(world.hash(), hash);
});

test('SEA-15 Poje drifter calibration improves nine held-out Cape Kennedy dye extents', (context) => {
  // Poje et al. (2014) Fig. 6 black squares: apparent K_a = 37.6 m²/s at 30 km from the log fit.
  // A four-thirds scale law gives q ∝ t³, so instantaneous K at that scale is 3 K_a.
  const inputDiffusivity = 112.9;
  // Okubo (1971) Table 1, all nine open-water Cape Kennedy observations from releases 3–6. No fit uses these rows.
  const observations = [
    [76, 1200],
    [112, 2400],
    [185, 5010],
    [197, 8580],
    [256, 3150],
    [266, 8970],
    [269, 4650],
    [284, 3870],
    [356, 5040],
  ];
  const n = 4096;
  const dt = 1 / 60;
  const errors = [];
  for (const horizontalDispersion of [undefined, { referenceScale: 30_000 }]) {
    const tracer = new TracerSolver();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
      capacity: n,
      // Still-water similarity: each tick represents 1,000 s, with K rescaled to preserve K dt.
      horizontalDiffusivity: (inputDiffusivity * 1000) / dt,
      horizontalDispersion,
      verticalDiffusivity: 0,
      sources: [{ material: 'dye', position: [0, -1, 0], rate: n / dt, stop: dt }],
    });
    errors.push(
      observations.map(([tick, observed]) => {
        world.advance(tick);
        const scale = 3 * Math.sqrt(radialVariance([...tracer.particlesOf()]));
        return Math.abs(Math.log(scale / observed));
      }),
    );
    assert.equal(tracer.budget.water, n);
  }
  const [constant, scaled] = errors;
  for (const [i, error] of scaled.entries())
    assert.ok(error < constant[i], `${observations[i][0]} ks: log error ${error} vs fixed-K ${constant[i]}`);
  const rms = (values) => Math.sqrt(values.reduce((sum, error) => sum + error ** 2, 0) / values.length);
  context.diagnostic(
    `RMS log extent error ${rms(constant).toFixed(3)} fixed, ${rms(scaled).toFixed(3)} scaled. Worst scale-law ratio ${Math.exp(Math.max(...scaled)).toFixed(2)}.`,
  );
});

test('SEA-15 a breaker entrains the Delvigne–Sweeney mass and number moments by diameter class', () => {
  const mass = 0.025;
  const dt = 1 / 60;
  const minimum = 20e-6;
  const maximum = 400e-6;
  const coefficient = 840;
  const count = 8;
  const height = 0.3;
  const energy = 15;
  const turnover = 0.5;
  const tracer = new TracerSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
    capacity: 2 * count,
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
    oilSpills: [
      {
        mass,
        position: [0, 0],
        spreadingCoefficient: 0,
        parcels: count,
        dispersion: {
          minimumDiameter: minimum,
          maximumDiameter: maximum,
          entrainmentCoefficient: coefficient,
          classes: count,
          breaking: { energy, height, turnover },
        },
      },
    ],
  });
  world.advance(1);
  const drops = [...tracer.particlesOf()].filter((parcel) => parcel.state === 'water');
  const inertialRadiusScale = 1.14 * ((9.80665 * (1 - 870 / 1025) * mass) / 870) ** 0.25;
  const areaTime = 0.5 * Math.PI * inertialRadiusScale ** 2 * dt ** 2;
  const expected = (areaTime * coefficient * energy ** 0.57 * turnover * (maximum ** 1.7 - minimum ** 1.7)) / 1.7;
  assert.equal(drops.length, count);
  assert.ok(Math.abs(tracer.budget.water - expected) < 1e-12 * expected);
  assert.ok(Math.abs(tracer.budget.surface + tracer.budget.water - mass) < 1e-15);
  let numberMoment = 0;
  for (const [index, drop] of drops.entries()) {
    const diameter = tracer.materialList[drop.material].diameter;
    const lo = minimum * (maximum / minimum) ** (index / count);
    const hi = minimum * (maximum / minimum) ** ((index + 1) / count);
    assert.ok(lo < diameter && diameter < hi);
    assert.ok(-1.5 * height < drop.position[1] && drop.position[1] < 0);
    numberMoment += drop.mass / diameter ** 3;
  }
  const exactNumber = (areaTime * coefficient * energy ** 0.57 * turnover * (minimum ** -1.3 - maximum ** -1.3)) / 1.3;
  assert.ok(Math.abs(numberMoment - exactNumber) < 1e-12 * exactNumber);
});

test('SEA-15 submerged oil resurfaces into its parent slick while vapour and ordinary dye stay accounted', () => {
  const mass = 0.025;
  const dt = 1 / 60;
  const tracer = new TracerSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
    capacity: 17,
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
    sources: [{ material: 'dye', position: [0, -0.1, 0], rate: 60, stop: dt }],
    oilSpills: [
      {
        mass,
        position: [0, 0],
        spreadingCoefficient: 0.0003,
        parcels: 8,
        evaporation: {
          temperature: 290,
          initialBoilingPoint: 400,
          distillationSlope: 650,
          massTransferCoefficient: 0.003,
        },
        dispersion: {
          minimumDiameter: 0.001,
          maximumDiameter: 0.002,
          classes: 8,
          entrainmentCoefficient: 840,
          breaking: (_x, _z, time) => ({ energy: 15, height: 0.05, turnover: time < dt ? 1 : 0 }),
        },
      },
    ],
  });
  world.advance(1);
  assert.ok(tracer.budget.water > 1);
  assert.ok(tracer.evaporatedMass > 0);
  const saved = world.takeSnapshot();
  world.advance(2400);
  assert.equal([...tracer.particlesOf()].length, 9);
  assert.ok(Math.abs(tracer.budget.water - 1) < 1e-15);
  assert.ok(Math.abs(tracer.budget.surface + tracer.evaporatedMass - mass) < 1e-15);
  const hash = world.hash();
  world.restoreSnapshot(saved.bytes);
  world.advance(2400);
  assert.equal(world.hash(), hash);
});

test('SEA-15 an invalid breaker sample leaves both slicks ready to retry the same tick', () => {
  const make = (energy) => {
    const tracer = new TracerSolver();
    const dispersion = {
      minimumDiameter: 20e-6,
      maximumDiameter: 50e-6,
      classes: 2,
      entrainmentCoefficient: 840,
      breaking: { energy: 10, height: 0.2, turnover: 0.8 },
    };
    const release = { mass: 0.025, spreadingCoefficient: 0, parcels: 2 };
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
      capacity: 8,
      oilSpills: [
        { ...release, position: [0, 0], dispersion },
        {
          ...release,
          position: [1, 0],
          dispersion: {
            ...dispersion,
            breaking: () => ({ ...dispersion.breaking, energy: energy() }),
          },
        },
      ],
    });
    return { tracer, world };
  };
  let energy = -1;
  const trial = make(() => energy);
  assert.throws(() => trial.world.advance(1), /supply finite nonnegative energy/);
  assert.equal(trial.tracer.budget.released, 0);
  energy = 10;
  trial.world.advance(1);
  const control = make(() => 10);
  control.world.advance(1);
  assert.equal(trial.world.hash(), control.world.hash());
});

test('SEA-15 a live propeller race lifts its predicted sediment mass and cuts the same packed volume from TerrainBed', async () => {
  await Physics.load();
  const model = KVLCC2_L7;
  const dt = 1 / 60;
  const waterDensity = 1025;
  const grainDensity = 2650;
  const grain = 0.00025;
  const porosity = 0.4;
  const height = 0.05;
  const roughness = 0.001;
  const bottom = -0.5;
  const x = -4.1;
  const width = 0.2;
  const make = (revolutions) => {
    const physics = new Physics(null, { fixedTimestep: dt, gravity: [0, 0, 0] });
    const body = physics.addBody(null, {
      position: [0, 0, 0],
      colliders: {
        shape: 'box',
        halfExtents: [model.length / 2, model.draught, model.beam / 2],
        mass: waterDensity * model.volume,
      },
    });
    const ship = new ShipSolver();
    const terrain = new TerrainBed();
    const tracer = TracerSolver.withBedWash();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics })
      .add(ship, { ships: [{ row: body.row, model }] })
      .add(terrain, {
        columns: 32,
        rows: 10,
        width: 12,
        depth: 3,
        elevations: () => bottom,
        bedrock: () => bottom - 0.025,
      })
      .add(tracer, {
        bed: terrain.bed,
        water: ship.water,
        bedWash: {
          water: ship.water,
          bounds: [x - width / 2, -width / 2, x + width / 2, width / 2],
          cells: [1, 1],
          referenceHeight: height,
          roughnessLength: roughness,
        },
        bedJets: { mobileLayer: { thickness: 0.025, porosity } },
        horizontalDiffusivity: 0,
        verticalDiffusivity: 0,
      })
      .couple(['ship', 'rigid', 'tracers', 'bed'], 'staggered');
    ship.control(0).revolutions = revolutions;
    return { world, tracer, terrain, ship };
  };
  const { world, tracer, terrain, ship } = make(16);
  const bedBefore = terrain.volume(bottom);
  world.advance(1);
  const velocity = ship.water.sample(x, bottom + height, 0, dt).velocity;
  const friction = (0.4 * Math.hypot(velocity[0], velocity[2])) / Math.log(height / roughness);
  const stress = waterDensity * friction ** 2;
  const reducedG = 9.80665 * (grainDensity / waterDensity - 1);
  const size = grain * Math.cbrt(reducedG / 1e-12);
  const critical =
    (0.3 / (1 + 1.2 * size) + 0.055 * (1 - Math.exp(-0.02 * size))) * (grainDensity - waterDensity) * 9.80665 * grain;
  assert.ok(stress > critical, `${stress} Pa vs ${critical} Pa`);
  const mass =
    dt *
    width ** 2 *
    0.00033 *
    grainDensity *
    Math.sqrt(reducedG * grain) *
    size ** 0.3 *
    (stress / critical - 1) ** 1.5;
  assert.ok(Math.abs(tracer.jetErosion - mass) < 1e-12 * mass, `${tracer.jetErosion} vs ${mass} kg`);
  assert.ok(Math.abs((bedBefore - terrain.volume(bottom)) * grainDensity * (1 - porosity) - mass) < 1e-10);
  assert.equal(terrain.refusedVolume(), 0);
  const [parcel] = [...tracer.particlesOf()];
  assert.equal(parcel.state, 'water');
  assert.ok(Math.abs(parcel.position[0] - x) < 1e-12);
  assert.ok(Math.abs(parcel.position[1] - (bottom + height)) < 1e-12);
  const snapshot = world.takeSnapshot();
  world.advance(12);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(12);
  assert.equal(world.hash(), hash);
  const idle = make(0);
  idle.world.advance(1);
  assert.equal(idle.tracer.jetErosion, 0);
});

test('SEA-15 bed wash uses the true sloping bed area and the tangential flow in another origin cell', () => {
  const terrain = new TerrainBed();
  const tracer = new TracerSolver();
  const cellSize = 32;
  const slope = 0.5;
  const normalY = 1 / Math.hypot(1, slope);
  const normalX = -slope * normalY;
  const speed = 0.6;
  const height = 0.04;
  const roughness = 0.001;
  const referenceBottom = -0.75;
  const shear = 1025 * ((0.4 * speed) / Math.log(height / roughness)) ** 2;
  const threshold = 0.05 * (2650 - 1025) * 9.80665 * 0.00025;
  const erodibility = 0.02;
  const samples = [];
  const wash = {
    medium: 'water',
    cell: [1, 1, 1],
    sample(x, y, z) {
      samples.push([x, y, z]);
      return {
        velocity: [speed * normalY + 0.7 * normalX, -speed * normalX + 0.7 * normalY, 0],
        density: 1025,
        temperature: 285,
      };
    },
  };
  const world = new PhysicsWorld({ cellSize, rate: { num: 60, den: 1 } })
    .add(terrain, { columns: 8, rows: 8, width: 2, depth: 2, elevations: (x) => referenceBottom + slope * x })
    .add(tracer, {
      bed: terrain.bed,
      cellSize,
      bedWash: {
        water: wash,
        bounds: [-0.1, -0.05, 0.1, 0.05],
        cells: [1, 1],
        referenceHeight: height,
        roughnessLength: roughness,
      },
      bedJets: { criticalShields: 0.05, erodibility },
    });
  world.advance(1);
  assert.equal(samples.length, 1);
  const expected = [normalX * height - cellSize, referenceBottom + normalY * height - cellSize, -cellSize];
  for (const [axis, value] of samples[0].entries())
    assert.ok(Math.abs(value - expected[axis]) < 1e-12, `${samples[0]} vs ${expected}`);
  const mass = ((0.02 / normalY) * erodibility * (shear / threshold - 1)) / 60;
  assert.ok(Math.abs(tracer.jetErosion - mass) < 1e-14, `${tracer.jetErosion} vs ${mass} kg`);
});

test('SEA-15 the native bow tunnel jet cuts and advects the same dry sand from the live bed', async () => {
  await Physics.load();
  const dt = 1 / 60;
  const model = KVLCC2_L7;
  const density = 1025;
  const bulk = 2650 * 0.6;
  const bottom = -0.5;
  const height = 0.05;
  const roughness = 0.001;
  const jetX = 2;
  const jetZ = -0.7;
  const physics = new Physics(null, { fixedTimestep: dt, gravity: [0, 0, 0] });
  const body = physics.addBody(null, {
    position: [0, 0, 0],
    colliders: {
      shape: 'box',
      halfExtents: [model.length / 2, model.draught, model.beam / 2],
      mass: density * model.volume,
    },
  });
  const ship = new ShipSolver();
  const terrain = new TerrainBed();
  const tracer = TracerSolver.withBedWash();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(new RigidSolver(), { physics })
    .add(ship, {
      ships: [
        {
          row: body.row,
          model,
          thruster: { diameter: 0.2, power: 5, position: jetX },
          thrusterOutlet: { halfSpan: 0.43, depth: -(bottom + height) },
        },
      ],
    })
    .add(terrain, {
      columns: 20,
      rows: 12,
      width: 5,
      depth: 3,
      elevations: () => bottom,
      bedrock: () => bottom - 0.025,
    })
    .add(tracer, {
      bed: terrain.bed,
      water: ship.water,
      bedWash: {
        water: ship.water,
        bounds: [jetX - 0.05, jetZ - 0.05, jetX + 0.05, jetZ + 0.05],
        cells: [1, 1],
        referenceHeight: height,
        roughnessLength: roughness,
      },
      bedJets: { mobileLayer: { thickness: 0.025, porosity: 0.4 } },
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
    })
    .couple(['ship', 'rigid', 'tracers', 'bed'], 'staggered');
  const bedBefore = terrain.volume(bottom);
  const controls = ship.control(0);
  world.advance(1);
  assert.equal(tracer.jetErosion, 0);
  controls.thruster = 1;
  world.advance(2);
  assert.ok(ship.status(0).thruster > 0);
  const velocity = ship.water.sample(jetX, bottom + height, jetZ, 2 * dt).velocity;
  assert.ok(velocity[2] < 0);
  const raised = tracer.jetErosion;
  assert.ok(raised > 0 && raised === tracer.budget.water);
  assert.ok(Math.abs((bedBefore - terrain.volume(bottom)) * bulk - raised) < 1e-12);
  assert.equal(terrain.refusedVolume(), 0);
  const snapshot = world.takeSnapshot();
  world.advance(3);
  assert.ok(tracer.particlesOf().next().value.position[2] < jetZ);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(3);
  assert.equal(world.hash(), hash);
});

test('SEA-15 dense sand pickup reduces error against independent high-velocity flume erosion', (t) => {
  // Heijmeijer et al. (2022), Tables 2–3 and Figure 11. Independent shear and bed retreat in the BOKA flume.
  const observations = [
    [3.5, 4],
    [10, 7],
    [43, 28],
    [62, 29],
  ];
  const material = { density: 2650, diameter: 125e-6, colour: [0.7, 0.6, 0.4] };
  const waterDensity = 1000;
  const porosity = 0.43;
  const bulkDensity = material.density * (1 - porosity);
  const referenceHeight = 0.02;
  const roughnessLength = 0.0001;
  const width = 0.1;
  const area = width * width;
  const measure = (shear, denseSand) => {
    const terrain = new TerrainBed();
    const tracer = TracerSolver.withBedWash();
    const speed = (Math.sqrt(shear / waterDensity) * Math.log(referenceHeight / roughnessLength)) / 0.4;
    const fluid = {
      medium: 'water',
      cell: [0, 0, 0],
      sample: () => ({ velocity: [speed, 0, 0], density: waterDensity, temperature: 293 }),
    };
    const bottom = -0.3;
    const thickness = 0.08;
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(terrain, {
      columns: 8,
      rows: 8,
      width: 0.4,
      depth: 0.4,
      elevations: () => bottom,
      bedrock: () => bottom - thickness,
    });
    world.add(tracer, {
      bed: terrain.bed,
      waterDensity,
      viscosity: 1e-6,
      bedWash: {
        water: fluid,
        bounds: [-width / 2, -width / 2, width / 2, width / 2],
        cells: [1, 1],
        referenceHeight,
        roughnessLength,
      },
      bedJets: { grains: material, denseSand, mobileLayer: { thickness, porosity } },
    });
    world.couple(['tracers', 'bed'], 'staggered');
    const before = terrain.volume(bottom);
    world.advance(1);
    assert.equal(terrain.refusedVolume(), 0);
    assert.ok(Math.abs((before - terrain.volume(bottom)) * bulkDensity - tracer.jetErosion) < 1e-12);
    return ((tracer.jetErosion * 60) / area / bulkDensity) * 1000;
  };
  const grainStress = (material.density - waterDensity) * 9.80665 * material.diameter;
  assert.equal(measure(grainStress / 2, true), measure(grainStress / 2, false));
  let baseline = 0;
  let damped = 0;
  let worst = 1;
  for (const [stress, rate] of observations) {
    const original = measure(stress, false);
    const updated = measure(stress, true);
    assert.ok(Math.abs(original / updated - stress / grainStress) < 1e-12);
    baseline += Math.log(original / rate) ** 2;
    damped += Math.log(updated / rate) ** 2;
    worst = Math.max(worst, rate / updated, updated / rate);
  }
  assert.ok(damped < baseline, 'damping must reduce the pooled error, including the highest shear runs');
  t.diagnostic(
    `RMS log erosion error ${Math.sqrt(baseline / observations.length).toFixed(3)} → ${Math.sqrt(damped / observations.length).toFixed(3)}. Worst ratio ${worst.toFixed(2)}.`,
  );
});

function estuarineFlocSpeed(diameter) {
  const primary = 40e-6;
  const stokes = ((2650 / 1025 - 1) * 9.80665 * primary * diameter) / 18e-6;
  let lo = 0;
  let hi = stokes;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (mid * (1 + 0.15 * ((mid * diameter) / 1e-6) ** 0.687) < stokes) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

test('SEA-15 Winterwerp floc growth converges to the integrated settling path under fixed exposure', () => {
  const primary = 40e-6;
  const equilibrium = 120e-6;
  const seconds = 1.5;
  const G = 4;
  const breakup = 1e8;
  const aggregation = 40_000;
  const concentration = 0.4;
  const primitive = (x) => Math.log(x / (1 - x)) - 1 / x;
  const start = primitive(primary / equilibrium);
  const lambda = 0.5 * breakup * G ** 1.5 * equilibrium ** 2;
  const exactSpeed = (time) => {
    const target = start + lambda * time;
    let lo = primary / equilibrium;
    let hi = 1;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (primitive(mid) < target) lo = mid;
      else hi = mid;
    }
    return estuarineFlocSpeed((equilibrium * (lo + hi)) / 2);
  };
  // Composite Simpson quadrature of the independent implicit diameter solution.
  const intervals = 1024;
  const h = seconds / intervals;
  let exact = exactSpeed(0) + exactSpeed(seconds);
  for (let i = 1; i < intervals; i++) exact += (i % 2 ? 4 : 2) * exactSpeed(i * h);
  exact *= h / 3;
  const errors = [1, 2].map((factor) => {
    // Scaling both kinetic coefficients changes only the time coordinate of the held exposure.
    const tracer = new TracerSolver();
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
      sources: [{ material: 'silt', position: [0, -1, 0], rate: 60, stop: 1 / 60 }],
      flocculation: {
        aggregation: aggregation / factor,
        breakup: breakup / factor,
        environment: { concentration, shearRate: G },
      },
    });
    world.advance(seconds * factor * 60);
    const [parcel] = [...tracer.particlesOf()];
    assert.equal(tracer.budget.water, 1);
    return Math.abs((-1 - parcel.position[1]) / factor - exact);
  });
  assert.ok(errors[0] < 3e-5 && errors[1] < errors[0], `${errors}`);
  assert.ok(Math.abs(errors[0] / errors[1] - 2) < 0.2, `${errors}`);
});

test('SEA-15 shear-limited breakup predicts the held-out Tran dilution trials', (t) => {
  // Tran et al. (2018), Set B. Mean D50 and its temporal sample SD over eleven 1-minute measurements
  // centred at preparation, dilution start, midpoint, end and 30 minutes after each dilution.
  const trials = [
    [
      50,
      [
        [133.88, 6.88],
        [135.39, 6.19],
        [116.7, 7.54],
        [84.18, 7.01],
        [79.61, 3.53],
      ],
    ],
    [
      100,
      [
        [124.99, 5.2],
        [133.14, 8.23],
        [121.94, 5.46],
        [80.69, 3.16],
        [85.1, 4.81],
      ],
    ],
    [
      200,
      [
        [137.7, 7.04],
        [130.42, 14.25],
        [121.91, 4.08],
        [78.71, 3.4],
        [82.82, 7.68],
      ],
    ],
  ];
  const primary = 5e-6;
  const viscosity = 1e-6;
  const waterDensity = 1000;
  const yieldForce = 1e-10;
  const grain = { density: 2650, diameter: primary, colour: [0.21, 0.18, 0.14] };
  const targetShear = 50;
  const rate = 60;
  const timeScale = 300;
  const labSecondsPerStep = timeScale / rate;
  // Kuprenas et al. (2018), §4.2. Transform the published Set A coefficients to the n_f=2 SI form.
  // Multiplying both rates by the clock scale preserves the competition and stands for 5 s of lab time per tick.
  const aggregation = (0.45 * timeScale) / (grain.density * primary);
  const breakup = (1.16e-6 * timeScale * Math.sqrt((waterDensity * viscosity) / yieldForce)) / primary;
  const stokesFactor = ((grain.density / waterDensity - 1) * 9.80665 * primary) / (18 * viscosity);
  let squaredError = 0;
  let observedVariance = 0;
  let maximumError = 0;
  for (const [duration, observed] of trials) {
    const tracer = new TracerSolver();
    const world = new PhysicsWorld({ rate: { num: rate, den: 1 } }).add(tracer, {
      capacity: 1,
      bed: 500,
      viscosity,
      waterDensity,
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
      sources: [{ material: grain, position: [0, -1, 0], rate, stop: 1 / rate }],
      flocculation: {
        material: grain,
        aggregation,
        breakup,
        yieldForce,
        environment: (_x, _y, _z, time) => ({
          concentration: 0.4 - 0.35 * Math.min(1, Math.max(0, (time * timeScale) / 60 - 60) / duration),
          shearRate: targetShear,
        }),
      },
    });
    const times = [30, 60, 60 + duration / 2, 60 + duration, 90 + duration];
    const height = () => tracer.particlesOf().next().value.position[1];
    let snapshot;
    for (const [i, minute] of times.entries()) {
      const tick = (minute * 60) / labSecondsPerStep;
      world.advance(tick - 1);
      const previous = height();
      world.advance(tick);
      const speed = (previous - height()) * rate;
      // Invert the independently evaluated drag balance, using only the observed terminal displacement.
      let lower = speed / stokesFactor;
      let upper = 0.01;
      for (let k = 0; k < 43; k++) {
        const d = (lower + upper) / 2;
        if (speed * (1 + 0.15 * ((speed * d) / viscosity) ** 0.687) > stokesFactor * d) lower = d;
        else upper = d;
      }
      const actual = 1e6 * (lower + upper) * 0.5;
      const [reference, scatter] = observed[i];
      const error = Math.abs(actual - reference);
      squaredError += error ** 2;
      observedVariance += scatter ** 2;
      maximumError = Math.max(maximumError, error);
      assert.equal(tracer.budget.water, 1);
      if (i === 2) snapshot = world.takeSnapshot();
    }
    const hash = world.hash();
    world.restoreSnapshot(snapshot.bytes);
    world.advance((times.at(-1) * 60) / labSecondsPerStep);
    assert.equal(world.hash(), hash);
  }
  const rmsError = Math.sqrt(squaredError / 15);
  const pooledScatter = Math.sqrt(observedVariance / 15);
  assert.ok(rmsError <= pooledScatter, `RMS error ${rmsError} µm vs measured scatter ${pooledScatter} µm`);
  t.diagnostic(
    `Set B RMS ${rmsError.toFixed(2)} µm, measured scatter ${pooledScatter.toFixed(2)} µm, peak ${maximumError.toFixed(2)} µm.`,
  );
});

test('SEA-15 shear-limited flocculation refuses invalid yield force', () => {
  for (const yieldForce of [0, -1e-10, Infinity, NaN, 1e-8]) {
    assert.throws(
      () =>
        new PhysicsWorld().add(new TracerSolver(), {
          flocculation: {
            aggregation: 30,
            breakup: 700,
            yieldForce,
            environment: { concentration: 0.4, shearRate: 50 },
          },
        }),
      /finite positive yieldForce/,
    );
  }
});

test('SEA-15 removing suspended concentration breaks mature flocs back toward primary grains and replays', () => {
  const primary = 40e-6;
  const mature = 120e-6;
  const tracer = new TracerSolver();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(tracer, {
    capacity: 1,
    horizontalDiffusivity: 0,
    verticalDiffusivity: 0,
    sources: [{ material: 'silt', position: [0, -1, 0], rate: 60, stop: 1 / 60 }],
    flocculation: {
      initialDiameter: mature,
      aggregation: 40_000,
      breakup: 1e8,
      environment: (_x, _y, _z, time) => ({ concentration: time <= 1 ? 0.4 : 0, shearRate: 4 }),
    },
  });
  const height = () => tracer.particlesOf().next().value.position[1];
  world.advance(60);
  assert.ok(Math.abs(-1 - height() - estuarineFlocSpeed(mature)) < 1e-12);
  const snapshot = world.takeSnapshot();
  world.advance(60 * 29);
  const before = height();
  world.advance(60 * 30);
  assert.ok(Math.abs(before - height() - estuarineFlocSpeed(primary)) < 2e-10);
  assert.equal(tracer.budget.water, 1);
  assert.equal(tracer.budget.released, 1);
  const hash = world.hash();
  world.restoreSnapshot(snapshot.bytes);
  world.advance(60 * 30);
  assert.equal(world.hash(), hash);
});

test('SEA-15 fixed measured aggregate sizes improve held-out Wax Lake Delta settling predictions', (t) => {
  // Nghiem et al. (2024), Fig. 6. Site median of the sample-wise number-weighted RMS primary diameter,
  // then geometric mean of optical diameters and displacement speeds. Units are µm and mm/s.
  const profiles = [
    { id: 'WDs21-DP18', primary: 3.75428, aggregate: 157.52492, observed: 0.455868 },
    { id: 'WDs21-DP19', primary: 1.56645, aggregate: 131.43677, observed: 0.299166 },
    { id: 'WDs21-DP22', primary: 3.25672, aggregate: 122.10597, observed: 0.452429 },
    { id: 'Wf21B-DP08', primary: 1.52641, aggregate: 122.00899, observed: 0.830128 },
  ];
  const settling = (primary, aggregate) => {
    const tracer = new TracerSolver();
    const grain = { density: 2650, diameter: primary * 1e-6, colour: [0.45, 0.35, 0.2] };
    const rate = { num: 60, den: 1 };
    const world = new PhysicsWorld({ rate }).add(tracer, {
      capacity: 1,
      waterDensity: 1000,
      viscosity: 1e-6,
      horizontalDiffusivity: 0,
      verticalDiffusivity: 0,
      sources: [{ material: grain, position: [0, -1, 0], rate: 60, stop: 1 / 60 }],
      flocculation:
        aggregate === undefined
          ? undefined
          : {
              material: grain,
              initialDiameter: aggregate * 1e-6,
              aggregation: 0,
              breakup: 1,
              environment: { concentration: 0, shearRate: 0 },
            },
    });
    world.advance(60);
    const [parcel] = [...tracer.particlesOf()];
    assert.equal(parcel.mass, 1);
    assert.equal(tracer.budget.water, 1);
    return (-1 - parcel.position[1]) * 1000;
  };
  let baseline = 0;
  let cohesive = 0;
  let worst = 1;
  const predictions = [];
  for (const { id, primary, aggregate, observed } of profiles) {
    const ordinary = settling(primary);
    const floc = settling(primary, aggregate);
    assert.ok(Math.abs(Math.log(floc / observed)) < Math.abs(Math.log(ordinary / observed)), id);
    baseline += Math.log(ordinary / observed) ** 2;
    cohesive += Math.log(floc / observed) ** 2;
    worst = Math.max(worst, observed / floc, floc / observed);
    predictions.push(floc.toFixed(3));
  }
  t.diagnostic(
    `Predicted ${predictions.join(', ')} mm/s. RMS log speed error ${Math.sqrt(baseline / profiles.length).toFixed(3)} → ${Math.sqrt(cohesive / profiles.length).toFixed(3)}. Worst ratio ${worst.toFixed(2)}.`,
  );
});
