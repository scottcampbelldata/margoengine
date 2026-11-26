// The tracers' coupling checks (SEA-15): `TracerSolver` held to the harness, the same plume at 24, 30 and 60 frames a second
// and a seek equal to a continuous run, with a breach leaking ore and a slick drifting in a current.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SpectralSea, WakeSolver } from '../../dist/sea.js';
import { TracerSolver } from '../../dist/tracers.js';
import { PhysicsWorld } from '../../dist/world.js';
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
