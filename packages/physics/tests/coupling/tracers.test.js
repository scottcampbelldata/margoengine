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
