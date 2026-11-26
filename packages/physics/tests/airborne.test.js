import assert from 'node:assert/strict';
import test from 'node:test';
import { AirborneParticles } from '../dist/airborne.js';
import { regionWords, PhysicsWorld, worldMemory } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const gravity = [0, -9.80665, 0];
const density = 1.225;
const temp = 288.15;
const close = (actual, wanted, scale = 1) =>
  assert.ok(
    Math.abs(actual - wanted) <= 1024 * Number.EPSILON * Math.max(scale, Math.abs(wanted)),
    `${actual} vs ${wanted}`,
  );

function stokes(d, rho) {
  const t = temp / 273.15;
  const viscosity = (1.716e-5 * t * Math.sqrt(t) * (273.15 + 110.4)) / (temp + 110.4);
  const knudsen = (2 * (viscosity / density) * Math.sqrt(Math.PI / (2 * 287.05 * temp))) / d;
  const slip = 1 + knudsen * (1.257 + 0.4 * Math.exp(-1.1 / knudsen));
  return (18 * viscosity) / (rho * d * d * slip);
}

function wind(velocity) {
  return {
    medium: 'air',
    cell: [0, 0, 0],
    sample(x, y, z, seconds) {
      return { velocity: velocity(x, y, z, seconds), density, temperature: temp };
    },
  };
}

test('Stokes and buoyancy give the analytic settling and relaxation trajectories in both memory modes', async () => {
  const diameter = 12e-6;
  const rho = 1000;
  const initial = { kind: 'freshwater-mist', diameter, mass: 0.001, position: [0, 2, 0] };
  const u = 0.03;
  for (const memory of [worldMemory(false), worldMemory(true)]) {
    const solver = await AirborneParticles.load();
    const world = new PhysicsWorld({ rate, gravity, memory }).add(solver, {
      initial: [initial],
      wind: wind(() => [u, 0, 0]),
      drag: 'stokes',
    });
    const beta = stokes(diameter, rho);
    for (const frame of [1, 12, 60]) {
      world.advance(frame);
      const seconds = frame / 60;
      const a = Math.exp(-seconds * beta);
      const velocityIntegral = (1 - a) / beta;
      const terminal = (gravity[1] * (1 - density / rho)) / beta;
      const sample = solver.readParticles()[0];
      close(sample.position[0], u * (seconds - velocityIntegral), u);
      close(sample.position[1], 2 + terminal * (seconds - velocityIntegral), 2);
      close(sample.velocity[0], u * (1 - a), u);
      close(sample.velocity[1], terminal * (1 - a), Math.abs(terminal));
      assert.equal(sample.mass, 0.001);
    }
  }
});

test('droplet diameter squared obeys diffusion-limited evaporation and salt residue retains its solute mass', async () => {
  const solver = await AirborneParticles.load();
  const diameter = 0.0002;
  const humidity = 0.8;
  const world = new PhysicsWorld({ rate, gravity: [0, 0, 0] }).add(solver, {
    initial: [
      { kind: 'freshwater-mist', diameter, mass: 1, position: [0, 2, 0] },
      { kind: 'sea-spray', diameter: 1e-6, mass: 1, position: [0, 2, 0] },
    ],
    wind: wind(() => [0, 0, 0]),
    humidity,
  });
  world.advance(1);
  const [mist, salt] = solver.readParticles();
  const c = temp - 273.15;
  const pressure = 611.21 * Math.exp(((18.678 - c / 234.5) * c) / (257.14 + c));
  const k = (8 * 2.5e-5 * pressure * (1 - humidity)) / (461.5 * temp * 1000);
  const d2 = diameter * diameter - k / 60;
  close(mist.diameter * mist.diameter, d2, d2);
  close(mist.mass, (Math.sqrt(d2) / diameter) ** 3);
  // In the flat-interface kappa limit D_eq^3 / D_dry^3 = 1 + kappa RH/(1-RH).
  const wetRatio = 1 + (1.12 * humidity) / (1 - humidity);
  const dryShare = 0.035 / 2160 / (0.035 / 2160 + 0.965 / 1000);
  close(salt.diameter, 1e-6 * Math.cbrt(dryShare * wetRatio), 1e-6);
  close(salt.mass, 0.035 * (1 + (wetRatio - 1) * (1000 / 2160)));
  const dry = await AirborneParticles.load();
  const dryWorld = new PhysicsWorld({ rate, gravity: [0, 0, 0] }).add(dry, {
    initial: [{ kind: 'sea-spray', diameter: 1e-6, mass: 1, position: [0, 2, 0] }],
    humidity: 0,
  });
  dryWorld.advance(1);
  close(dry.readParticles()[0].mass, 0.035);
  close(solver.budget.evaporated, 2 - mist.mass - salt.mass);
});

test('one stochastic step has the exact homogeneous OU mean and variance within sampling confidence', async () => {
  const solver = await AirborneParticles.load();
  const n = 1024;
  const p = { kind: 'mineral-dust', diameter: 5e-6, mass: 1e-6, position: [0, 3, 0] };
  const sigma = 1.5;
  const correlation = 0.3;
  // 240 Hz frame rate exposes exactly one solver tick.
  const world = new PhysicsWorld({ rate: { num: 240, den: 1 }, seed: 41, gravity: [0, 0, 0] }).add(solver, {
    initial: Array(n).fill(p),
    capacity: n,
    turbulence: { rms: [sigma, 0, 0], time: correlation },
  });
  world.advance(1);
  const values = regionWords(world.memory, world.fields.port(solver.particleField.name).region);
  const samples = Array.from({ length: n }, (_, i) => values[16 * i + 6]);
  const mean = samples.reduce((sum, x) => sum + x, 0) / n;
  const actual = samples.reduce((sum, x) => sum + (x - mean) * (x - mean), 0) / (n - 1);
  const variance = sigma * sigma * (1 - Math.exp(-2 / (240 * correlation)));
  assert.ok(Math.abs(mean) < 6 * Math.sqrt(variance / n));
  assert.ok(Math.abs(actual - variance) < 6 * variance * Math.sqrt(2 / (n - 1)));
});

test('capacity preserves source mass pending and open-boundary outflow enters the ledger', async () => {
  const solver = await AirborneParticles.load();
  const p = { kind: 'mineral-dust', diameter: 10e-6, position: [0, 2, 0] };
  const world = new PhysicsWorld({ rate, gravity: [0, 0, 0] }).add(solver, {
    initial: [{ ...p, mass: 1 }],
    sources: [{ ...p, rate: 0.6 }],
    wind: wind(() => [4, 0, 0]),
    bounds: [
      [-1, 1, -1],
      [0.02, 3, 1],
    ],
    capacity: 1,
  });
  world.advance(1);
  assert.ok(solver.budget.outflow >= 1);
  assert.ok(solver.budget.waiting > 0 || solver.budget.airborne > 0);
  close(solver.budget.supplied, 0.01);
  const { initial, supplied, airborne, deposited, evaporated, outflow, waiting } = solver.budget;
  close(initial + supplied, airborne + deposited + evaporated + outflow + waiting);
});

test('the two exact lazy kernels survive a production web build', { timeout: 30_000 }, async () => {
  const { mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { build } = await import('vite');
  const root = resolve(import.meta.dirname, '../../../test-results/airborne-consumer', String(process.pid));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<script type="module" src="./main.js"></script>');
  writeFileSync(
    join(root, 'main.js'),
    'import {AirborneParticles} from "@margoengine/physics/airborne"; window.airborne = () => AirborneParticles.load();',
  );
  await build({ root, configFile: false, publicDir: false, logLevel: 'warn', build: { target: 'es2022' } });
  const assets = join(root, 'dist/assets');
  const files = readdirSync(assets);
  for (const base of ['airborne-kernel', 'airborne-kernel-shared']) {
    const names = files.filter(
      (name) =>
        name.startsWith(base + '-') &&
        name.endsWith('.wasm') &&
        (base.endsWith('shared') || !name.startsWith('airborne-kernel-shared-')),
    );
    assert.equal(names.length, 1, `separate ${base} asset`);
    assert.deepEqual(
      readFileSync(join(assets, names[0])),
      readFileSync(new URL(`../dist/${base}.wasm`, import.meta.url)),
    );
  }
});
