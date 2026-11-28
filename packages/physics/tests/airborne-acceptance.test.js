import assert from 'node:assert/strict';
import test from 'node:test';
import { AirborneParticles } from '../dist/airborne.js';
import { PhysicsWorld, regionWords } from '../dist/world.js';

const rate = { num: 240, den: 1 };
const gravity = [0, 0, 0];
const first = { kind: 'mineral-dust', diameter: 12e-6, mass: 0.001, position: [-1, 2, 0] };
const second = { ...first, kind: 'freshwater-mist', position: [1, 2, 0] };

const acceptedRegions = (world, solver) =>
  solver.stateRegions().map((region) => Array.from(regionWords(world.memory, region)));

const parcelPort = (world, solver) => {
  const port = world.fields.port(solver.particleField.name);
  return { tick: port.tick, cell: [...port.cell], bytes: Array.from(regionWords(world.memory, port.region)) };
};

test('ATMO-06 discards source mass and a partially sampled candidate if the next wind sample is invalid', async () => {
  using solver = await AirborneParticles.load();
  let invalid = false;
  const xs = [];
  const wind = {
    medium: 'air',
    cell: [0, 0, 0],
    sample(x) {
      xs.push(x);
      return { density: 1.225, temperature: 288.15, velocity: [invalid && x > 0.5 ? NaN : 0.7, 0, 0] };
    },
  };
  const params = {
    initial: [first, second],
    sources: [{ kind: 'mineral-dust', diameter: 12e-6, position: [0, 2, 0], rate: 0.01 }],
    capacity: 9,
    wind,
    humidity: 0.88,
    turbulence: { rms: [0.03, 0, 0], time: 0.7 },
  };
  const world = new PhysicsWorld({ rate, gravity, seed: 11 }).add(solver, params);
  world.advance(1);
  const prior = world.takeSnapshot();
  const acceptedTick = world.tick;
  const oldRegions = acceptedRegions(world, solver);
  const oldPort = parcelPort(world, solver);
  const oldBudget = solver.budget;
  const oldWork = solver.workCounts();
  const oldParticles = solver.readParticles();

  xs.length = 0;
  invalid = true;
  assert.throws(() => world.advance(2), {
    name: 'MargoError',
    code: 'state',
    message: /sample wind velocity/,
  });
  assert(xs[0] < 0 && xs[1] > 0.5);
  assert.equal(world.tick, acceptedTick);
  assert.deepEqual(solver.readParticles(), oldParticles);
  assert.deepEqual(solver.budget, oldBudget);
  assert.deepEqual(solver.workCounts(), oldWork);
  assert.deepEqual(acceptedRegions(world, solver), oldRegions);
  assert.deepEqual(parcelPort(world, solver), oldPort);

  invalid = false;
  world.advance(2);
  const recovered = world.takeSnapshot().bytes;
  world.restoreSnapshot(prior.bytes);
  world.advance(2);
  assert.deepEqual(world.takeSnapshot().bytes, recovered);
});

test('ATMO-06 publishes its signed origin consistently through far-cell integration and rewind', async () => {
  using solver = await AirborneParticles.load();
  const origin = [1_234_567, -2_345_678, 3_456_789];
  const shifted = [-7_654_321, 8_765_432, -9_876_543];
  const world = new PhysicsWorld({ rate, gravity }).add(solver, { initial: [first], capacity: 3 }, origin);
  world.advance(1);
  const prior = world.takeSnapshot();
  assert.deepEqual(solver.cell, origin);
  assert(solver.exportPorts(world.tick).every(({ cell }) => cell.every((value, i) => value === origin[i])));
  assert.deepEqual(parcelPort(world, solver).cell, origin);
  assert.deepEqual(world.fields.port(solver.massField.name).cell, origin);
  world.shiftOrigin(shifted);
  world.advance(2);
  const after = origin.map((value, index) => value - shifted[index]);
  assert.deepEqual(solver.cell, after);
  assert(solver.exportPorts(world.tick).every(({ cell }) => cell.every((value, i) => value === after[i])));
  assert.deepEqual(parcelPort(world, solver).cell, after);
  assert.deepEqual(world.fields.port(solver.massField.name).cell, after);
  assert.deepEqual(solver.readParticles()[0].position, first.position);
  world.restoreSnapshot(prior.bytes);
  assert.deepEqual(solver.cell, origin);
  assert.deepEqual(parcelPort(world, solver).cell, origin);
});
