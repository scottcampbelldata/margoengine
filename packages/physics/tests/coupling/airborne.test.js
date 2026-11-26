import assert from 'node:assert/strict';
import test from 'node:test';
import { AeolianTransport } from '../../dist/aeolian.js';
import { AirborneParticles } from '../../dist/airborne.js';
import { bedSurface, TerrainBed } from '../../dist/earth.js';
import { FoamSolver } from '../../dist/foam.js';
import { jonswap } from '../../dist/waves.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const shape = { columns: 3, rows: 3, width: 3, depth: 3, centre: [0, 0] };
const dust = { kind: 'mineral-dust', diameter: 20e-6, mass: 0.00001, position: [-1, 1, -0.2] };
const spray = { kind: 'sea-spray', diameter: 60e-6, mass: 0.00001, position: [1, 0.5, 0.3] };
const wind = {
  medium: 'air',
  cell: [0, 0, 0],
  sample(x, y, _z, _time, out) {
    out.velocity[0] = x > 0 ? -2 : 4;
    out.velocity[1] = y > 0.75 ? 0.22 : 0;
    out.velocity[2] = 0;
    out.density = 1.225;
    out.temperature = 288.15;
    return out;
  },
};
const mass = (solver) => {
  const { initial, supplied, airborne, deposited, evaporated, outflow, waiting } = solver.budget;
  assert.ok(
    Math.abs(initial + supplied - airborne - deposited - evaporated - outflow - waiting) <=
      2048 * Number.EPSILON * (initial + supplied),
  );
};

test('PA-54: separate locations sample opposite horizontal winds and different vertical flow', async () => {
  const solver = await AirborneParticles.load();
  const world = new PhysicsWorld({ rate }).add(solver, { initial: [dust, spray], wind });
  world.advance(10);
  const [left, right] = solver.readParticles();
  assert.ok(left.position[0] > dust.position[0] && right.position[0] < spray.position[0]);
  assert.ok(left.velocity[1] > 0 && right.velocity[1] < 0);
  mass(solver);
});

test('PA-61 and PA-55: live windblown dust enters from EARTH-07 and settles against the TerrainBed', async () => {
  const transport = await AeolianTransport.load();
  const airborne = await AirborneParticles.load({ terrain: true, dustField: transport.dustField });
  const ground = new TerrainBed();
  const world = new PhysicsWorld({ rate })
    .add(ground, { ...shape, elevations: (x) => 0.02 * x })
    .add(transport, { grid: shape, initialSaltation: 0.05, frictionVelocity: [0.6, 0], dustEfficiency: 0.001 })
    .add(airborne, {
      capacity: 512,
      terrain: shape,
      wind: {
        ...wind,
        sample(_x, _y, _z, _t, out) {
          out.velocity = [0.25, 0, 0];
          out.density = 1.225;
          out.temperature = 288.15;
          return out;
        },
      },
      dustReleaseHeight: 0.0002,
    });
  world.advance(10);
  assert.ok(transport.budget.dust > 0, 'the bed producer released fine mass');
  assert.ok(airborne.budget.supplied > 0, 'the airborne solver consumed the live dust port');
  assert.ok(airborne.budget.deposited > 0, 'contact is camera-independent');
  assert.ok(airborne.readParticles().every((p) => p.kind === 'mineral-dust' && p.velocity[0] > 0));
  mass(airborne);
});

test('PA-21 and RITS-4: active whitecaps from SEA-13 supply a size distribution and a directional spray plume', async () => {
  const frequencies = new Float64Array(24).map((_, i) => 0.06 * 1.12 ** i);
  const directions = new Float64Array(16).map((_, j) => (2 * Math.PI * j) / 16);
  const spectrum = jonswap(
    { height: 4, period: 6, direction: 0 },
    { frequencies, directions, energy: new Float64Array(24 * 16), depth: Infinity, density: 1025 },
  );
  const waves = {
    cell: [0, 0, 0],
    sample(_x, _z, out = { ...spectrum, energy: new Float64Array(spectrum.energy.length) }) {
      out.energy.set(spectrum.energy);
      return out;
    },
  };
  const airborne = await AirborneParticles.load({ whitecaps: true });
  const foam = new FoamSolver();
  const seaWind = {
    ...wind,
    sample(_x, _y, _z, _t, out) {
      out.velocity = [8, 0, 0];
      out.density = 1.225;
      out.temperature = 288.15;
      return out;
    },
  };
  const world = new PhysicsWorld({ rate })
    .add(foam, {
      waves,
      cells: [12, 12],
      cellSize: 3,
      wind: seaWind,
      statistics: 18,
    })
    .add(airborne, {
      capacity: 1536,
      spray: { columns: 12, rows: 12, spacing: 3, centre: [0, 0], releaseHeight: 0.1 },
      wind: seaWind,
    });
  world.advance(180);
  const particles = airborne.readParticles();
  assert.ok(airborne.budget.supplied > 0);
  assert.ok(particles.every((p) => p.kind === 'sea-spray' && p.velocity[0] > 0));
  assert.equal(new Set(particles.map((p) => p.diameter)).size, 3);
  mass(airborne);
});

test('PA-61: a ground source releases dust at a footstep and replay preserves its later windward track', async () => {
  const solver = await AirborneParticles.load({ emissions: true });
  const field = solver.emissionField;
  let region;
  let host;
  const producer = {
    describe: () => ({ id: 'footstepDust', rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] }),
    init(h) {
      host = h;
      region = h.allocate('mineral-rate', 8, 'f64', 1);
    },
    step({ tick }) {
      regionWords(host.memory, region)[0] = tick === 7 ? 0.00012 : 0;
    },
    importPorts() {},
    exportPorts(tick) {
      return [{ field: field.name, region, tick, cell: [0, 0, 0] }];
    },
    stateRegions: () => [region],
    extraState: () => [],
  };
  const world = new PhysicsWorld({ rate }).add(producer, {}).add(solver, {
    capacity: 24,
    wind,
    terrain: bedSurface(shape, new Float64Array(16)),
    sources: [{ ...dust, rate: 0 }],
  });
  world.advance(6);
  assert.equal(solver.budget.supplied, 0);
  const saved = world.takeSnapshot();
  world.advance(18);
  assert.ok(solver.budget.supplied > 0);
  assert.ok(solver.readParticles().every((p) => p.position[0] > dust.position[0]));
  const expected = world.hash();
  world.restoreSnapshot(saved.bytes);
  world.advance(18);
  assert.equal(world.hash(), expected);
  mass(solver);
});

test('PA-04: the same noisy environmental particles at 24, 30 and 60 fps, including mid-step restore', async () => {
  const available = await Promise.all(Array.from({ length: 5 }, () => AirborneParticles.load()));
  const make = (frames = { num: 24, den: 1 }) =>
    new PhysicsWorld({ rate: frames, seed: 95 }).add(available.pop(), {
      initial: [dust, spray],
      wind,
      humidity: 0.9,
      turbulence: { rms: [0.1, 0.05, 0.2], time: 0.2 },
    });
  frameRateIndependent(make, { seconds: 2 });
  seekEqualsContinuous(make, { frames: 48, at: 7, cap: 277 });
});
