import assert from 'node:assert/strict';
import test from 'node:test';
import { AccretionDiskSolver, KerrGeodesicSolver, kerrCircularOrbit, kerrIsco } from '../dist/accretion.js';
import { PhysicsWorld } from '../dist/world.js';

const G = 6.6743e-11;
const C = 299_792_458;
const MASS = (C * C * C) / G; // Gravitational time is 1 second, gravitational length is c metres.
const RATE = { num: 60, den: 1 };

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (bound ${tolerance})`);
}

async function disk(params, arena) {
  const solver = await AccretionDiskSolver.load();
  const world = new PhysicsWorld({ rate: RATE, arena }).add(solver, params);
  return { solver, world };
}

function orbit(params, options) {
  const solver = new KerrGeodesicSolver(options);
  const world = new PhysicsWorld({ rate: RATE }).add(solver, { centralMass: MASS, ...params });
  return { solver, world };
}

test('nonuniform annuli preserve the exact zero-torque steady solution and its one-face heating', async () => {
  const edges = [10, 11, 12.5, 16, 20, 31];
  const viscosity = [2, 0.6, 0.4, 1.1, 2];
  const flow = 7;
  const radii = viscosity.map((_, i) => (edges[i] + edges[i + 1]) / 2);
  const steady = (r, nu) => (flow / (3 * Math.PI * nu)) * (1 - Math.sqrt(edges[0] / r));
  const densities = radii.map((r, i) => steady(r, viscosity[i]));
  const { solver, world } = await disk({ centralMass: 1 / G, edges, viscosity, initialDensity: densities, feed: flow });
  world.advance(120);
  const e = 256 * Number.EPSILON;
  for (let i = 0; i < radii.length; i++) {
    const ring = solver.ring(i),
      r = radii[i];
    near(ring.density, densities[i], e, 'steady density');
    near(ring.inwardFlow, flow, e * flow, 'same flux at each face');
    const expectedHeat = (3 * flow * (1 - Math.sqrt(edges[0] / r))) / (8 * Math.PI * r * r * r);
    near(ring.heating, expectedHeat, e * expectedHeat, 'one-face viscous flux');
    near(ring.phase, 2 / Math.sqrt(r * r * r), e, 'Kepler phase');
  }
  assert.ok(solver.ring(0).phase > solver.ring(4).phase, 'the inner emitter advances more in the same two seconds');
  near(solver.budget().accretedMass, 2 * flow, e * flow, 'inner accretion matches supplied mass');
  near(
    solver.budget().remainingMass,
    solver.budget().initialMass,
    e * solver.budget().initialMass,
    'steady stored mass',
  );
});

test('both zero-torque faces match the one-annulus implicit balance even at large diffusion Courant number', async () => {
  const l = 3,
    r = 9,
    c = (l + r) / 2,
    nu = 1e12,
    feed = 21;
  const area = Math.PI * (r * r - l * l);
  const w = (nu * Math.sqrt(c)) / area;
  const kl = (3 * Math.PI) / (Math.sqrt(c) - Math.sqrt(l));
  const kr = (3 * Math.PI) / (Math.sqrt(r) - Math.sqrt(c));
  const { solver, world } = await disk({
    centralMass: 100 / G,
    edges: [l, r],
    viscosity: nu,
    initialDensity: 2,
    outerBoundary: 'zero-torque',
    feed,
  });
  world.advance(1);
  const dt = 1 / 60;
  const expected = (2 * area + feed * dt) / (1 + dt * (kl + kr) * w);
  const budget = solver.budget();
  near(budget.remainingMass, expected, expected * 32 * Number.EPSILON, 'implicit remaining mass');
  near(budget.accretedMass, dt * kl * w * expected, budget.initialMass * 32 * Number.EPSILON, 'inner loss');
  near(budget.escapedMass, dt * kr * w * expected, budget.initialMass * 32 * Number.EPSILON, 'outer loss');
  near(
    budget.remainingMass + budget.accretedMass + budget.escapedMass,
    budget.initialMass + budget.suppliedMass,
    budget.initialMass * 32 * Number.EPSILON,
    'complete mass ledger',
  );
});

test('a viscous ring spreads in both directions with a closed mass budget and without negative densities', async () => {
  const { solver, world } = await disk({
    centralMass: 1 / G,
    edges: [4, 5, 6, 8, 9, 12],
    viscosity: 0.2,
    initialDensity: [0, 0, 10, 0, 0],
    innerBoundary: 'sealed',
  });
  world.advance(60);
  assert.equal(solver.budget().accretedMass, 0);
  assert.equal(solver.budget().escapedMass, 0);
  assert.ok(solver.ring(2).density < 10);
  assert.ok(solver.ring(1).density > 0 && solver.ring(3).density > 0);
  for (let i = 0; i < solver.ringCount; i++) assert.ok(solver.ring(i).density >= 0);
  near(
    solver.budget().remainingMass,
    solver.budget().initialMass,
    solver.budget().initialMass * 64 * Number.EPSILON,
    'closed disk mass',
  );
});

test('Schwarzschild, prograde and retrograde Kerr circular orbits match their exact coordinate frequencies', () => {
  for (const [spin, sense] of [
    [0, 1],
    [0.8, 1],
    [0.8, -1],
  ]) {
    const r = 10;
    const constants = kerrCircularOrbit(r, spin, sense);
    const { solver, world } = orbit({ ...constants, spin, radius: r });
    world.advance(1_200);
    const sample = solver.sample();
    const omega = sense / (r * Math.sqrt(r) + sense * spin);
    near(sample.radius / C, r, 1024 * Number.EPSILON * r, 'circular radius');
    near(sample.azimuth, 20 * omega, 1024 * Number.EPSILON, 'circular angle');
    assert.equal(sample.polarAngle, Math.PI / 2);
    if (spin === 0)
      near(
        sample.properTime,
        20 * Math.sqrt(1 - 3 / r),
        2048 * Number.EPSILON * 20,
        'Schwarzschild circular proper time',
      );
  }
  assert.equal(kerrIsco(), 6);
  assert.equal(kerrIsco(1), 1);
  assert.equal(kerrIsco(1, -1), 9);
});

test('an inclined Schwarzschild circular orbit follows its exact plane with a nonzero Carter constant', () => {
  const r = 10,
    tilt = 0.5;
  const { energy, axialAngularMomentum: total } = kerrCircularOrbit(r);
  const axialAngularMomentum = total * Math.cos(tilt);
  const { solver, world } = orbit({
    energy,
    axialAngularMomentum,
    carterConstant: total * total - axialAngularMomentum * axialAngularMomentum,
    radius: r,
    polarDirection: -1,
  });
  world.advance(4_800);
  const result = solver.sample(),
    phase = 80 / (r * Math.sqrt(r));
  const sine = Math.sin(result.polarAngle);
  // h=1/60, omega=0.032; the integrated RK4 phase error is O(t omega (h omega)^4).
  const error = 3e-11;
  near(result.radius / C, r, error, 'inclined circular radius');
  near(sine * Math.cos(result.azimuth), Math.cos(phase), error, 'orbital plane x');
  near(sine * Math.sin(result.azimuth), Math.cos(tilt) * Math.sin(phase), error, 'orbital plane y');
  near(Math.cos(result.polarAngle), Math.sin(tilt) * Math.sin(phase), error, 'orbital plane z');
});

test('radial fall reproduces the Schwarzschild exterior time and stays above the horizon', () => {
  const start = 8;
  const { solver, world } = orbit({ radius: start, energy: 1, axialAngularMomentum: 0 });
  world.advance(720);
  const result = solver.sample();
  const r = result.radius / C;
  const t = (radius) => {
    const u = Math.sqrt(radius / 2);
    return 4 * ((u * u * u) / 3 + u) + 2 * Math.log((u - 1) / (u + 1));
  };
  // Far from the horizon, the autonomous log-radius RK4 step bounds the accumulated time error by O(h^4).
  near(t(start) - t(r), 12, 2e-10, 'radial observer time');
  near(
    result.properTime,
    (2 / (3 * Math.sqrt(2))) * (start * Math.sqrt(start) - r * Math.sqrt(r)),
    2e-10,
    'radial proper time',
  );
  world.advance(7_200);
  assert.ok(solver.sample().horizonOffset > 0 && solver.sample().horizonOffset < 1e-4);
  assert.ok(solver.sample().radius >= 2 * C);
});

test('a Schwarzschild photon circle retains zero proper time and Kerr frame dragging changes sign with spin', () => {
  const { solver, world } = orbit({ radius: 3, energy: 1, axialAngularMomentum: 3 * Math.sqrt(3), tracer: 'light' });
  world.advance(60);
  near(solver.sample().azimuth, 1 / (3 * Math.sqrt(3)), 128 * Number.EPSILON, 'light ring angular velocity');
  assert.equal(solver.sample().properTime, 0);
  const positive = orbit({ radius: 8, energy: 1, axialAngularMomentum: 0, spin: 0.8 });
  const negative = orbit({ radius: 8, energy: 1, axialAngularMomentum: 0, spin: -0.8 });
  positive.world.advance(60);
  negative.world.advance(60);
  assert.ok(positive.solver.sample().azimuth > 0);
  assert.equal(positive.solver.sample().azimuth, -negative.solver.sample().azimuth);
  assert.equal(positive.solver.sample().radius, negative.solver.sample().radius);
});

test('an eccentric Schwarzschild trajectory turns at the two roots of its radial potential', () => {
  const p = 10,
    e = 0.2;
  // Solve R(r)=0 at r=p/(1±e) to fix both constants independently of the time integrator.
  const periapsis = p / (1 + e),
    apoapsis = p / (1 - e);
  const denom = p - 3 - e * e;
  const energy = Math.sqrt(((p - 2) * (p - 2) - 4 * e * e) / (p * denom));
  const momentum = p / Math.sqrt(denom);
  const { solver, world } = orbit({ radius: periapsis, energy, axialAngularMomentum: momentum });
  const radii = [];
  for (let frame = 3; frame <= 24_000; frame += 3) {
    world.advance(frame);
    radii.push(solver.sample().radius / C);
  }
  const max = Math.max(...radii);
  const turn = radii.indexOf(max);
  assert.ok(turn > 0 && turn < radii.length - 1, 'the outward radial motion turns inward within the measured orbit');
  // With the specified constants, |d²r/dt²| < 0.1 on [8,13]. A 0.05 s sample interval then contributes < 3.2e-5.
  near(max, apoapsis, 3.2e-5, 'apocentre');
  assert.ok(radii[radii.length - 1] < max - 0.2, 'the trajectory leaves apocentre instead of sticking to it');
  assert.ok(Math.min(...radii) >= periapsis - 4e-9);
});

test('a production bundle keeps the two feature-local accretion Wasm assets', { timeout: 15_000 }, async () => {
  const { mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { build } = await import('vite');
  const root = resolve(import.meta.dirname, '../../../test-results/accretion-consumer', String(process.pid));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<script type="module" src="./main.js"></script>');
  writeFileSync(
    join(root, 'main.js'),
    'import {AccretionDiskSolver} from "@margoengine/physics/accretion"; window.disk = () => AccretionDiskSolver.load();',
  );
  await build({ root, configFile: false, publicDir: false, logLevel: 'warn', build: { target: 'es2022' } });
  const folder = join(root, 'dist/assets');
  const assets = readdirSync(folder).filter((name) => name.endsWith('.wasm'));
  assert.equal(assets.length, 2);
  for (const asset of assets) {
    const mode = asset.startsWith('accretion-kernel-shared-') ? '-shared' : '';
    assert.deepEqual(
      readFileSync(join(folder, asset)),
      readFileSync(new URL(`../dist/accretion-kernel${mode}.wasm`, import.meta.url)),
    );
  }
});
