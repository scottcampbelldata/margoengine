import assert from 'node:assert/strict';
import test from 'node:test';
import { AccretionDiskSolver, KerrGeodesicSolver, kerrCircularOrbit } from '../../dist/accretion.js';
import { Arena, PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const field = { name: 'annulusFeed', kind: 'scalarSeries', quantity: 'diskMassSupply', unit: 'kg/s', centring: 'face' };
const G = 6.6743e-11;
const C = 299_792_458;

function feed(rate = 3) {
  let host, region;
  return {
    describe: () => ({ id: 'accretionSupply', rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] }),
    init(h) {
      host = h;
      region = h.allocate('outer-feed', 8, 'f64', 1);
    },
    step({ tick }) {
      regionWords(host.memory, region)[0] = tick < 20 ? rate : 0;
    },
    exportPorts(tick) {
      return [{ field: field.name, region, tick, cell: [0, 0, 0] }];
    },
    importPorts() {},
    stateRegions: () => [region],
    extraState: () => [],
  };
}

function monitor(disk, tracer) {
  let host, memory;
  const fields = [disk.heatingField, disk.phaseField, tracer.coordinatesField];
  return {
    describe: () => ({
      id: 'accretionObservation',
      rate: 0,
      stableRate: () => 0,
      fields: fields.map((field) => ({ field, access: 'read' })),
    }),
    init(h) {
      host = h;
      memory = h.allocate('accretion-observation', 24, 'f64', 1);
    },
    step({ inputs }) {
      const read = (field) => regionWords(host.memory, inputs.get(field.name).region);
      const heat = read(disk.heatingField);
      const phase = read(disk.phaseField);
      const coordinates = read(tracer.coordinatesField);
      regionWords(host.memory, memory).set([heat[heat.length - 1], phase[0] - phase[phase.length - 1], coordinates[2]]);
    },
    exportPorts: () => [],
    importPorts() {},
    stateRegions: () => [memory],
    extraState: () => [],
    observation() {
      return regionWords(host.memory, memory).slice();
    },
  };
}

async function make(rate = { num: 60, den: 1 }, shared = true, supply = 3) {
  const disk = await AccretionDiskSolver.load({ feedField: field });
  const tracer = new KerrGeodesicSolver();
  const sink = monitor(disk, tracer);
  const world = new PhysicsWorld({ rate, arena: new Arena(worldMemory(shared)) })
    .add(feed(supply), {})
    .add(disk, { centralMass: 1 / G, edges: [10, 11, 14, 20], viscosity: 1 })
    .add(tracer, { ...kerrCircularOrbit(10, 0.4), centralMass: (C * C * C) / G, radius: 10, spin: 0.4 })
    .add(sink, {})
    .couple(['accretionSupply', 'accretionDisk', 'kerrGeodesic', 'accretionObservation'], 'staggered');
  return { world, disk, tracer, sink };
}

test('a registered mass feed drives live heating, Kepler shear and coordinates to an observation solver', async () => {
  const powered = await make();
  const empty = await make({ num: 60, den: 1 }, true, 0);
  powered.world.advance(60);
  empty.world.advance(60);
  const budget = powered.disk.budget();
  assert.ok(Math.abs(budget.suppliedMass - 1) < 8 * Number.EPSILON, '20 distinct supply ticks deliver one kg');
  assert.ok(budget.accretedMass > 0, 'some of the fed mass reaches the central sink');
  assert.ok(powered.sink.observation()[0] > 0, 'viscosity heats the new mass');
  assert.equal(empty.sink.observation()[0], 0);
  assert.ok(powered.sink.observation()[1] > 0, 'inner and outer annuli do not stay still together');
  assert.equal(powered.sink.observation()[2], powered.tracer.sample().azimuth);
  assert.equal(powered.sink.observation()[0], powered.disk.ring(2).heating);
  assert.ok(Math.abs(budget.remainingMass + budget.accretedMass - budget.suppliedMass) < 128 * Number.EPSILON);
});

test('SPACE-03 gives identical native memory modes, frame rates and exact resumed observations', async () => {
  const [plain, shared] = await Promise.all([make(undefined, false), make()]);
  plain.world.advance(60);
  shared.world.advance(60);
  assert.equal(plain.world.hash(), shared.world.hash());
  assert.deepEqual(plain.sink.observation(), shared.sink.observation());

  const rates = [24, 30, 60];
  const byRate = new Map();
  for (const fps of rates) byRate.set(fps, (await make({ num: fps, den: 1 })).world);
  frameRateIndependent((rate) => byRate.get(rate.num), { rates });
  const pairs = [await make({ num: 24, den: 1 }), await make({ num: 24, den: 1 })];
  seekEqualsContinuous(() => pairs.pop().world, { at: 14, frames: 29 });
});

test('SPACE-03 accepts signed foreign supply and refuses invalid disk trials atomically', async () => {
  const disk = await AccretionDiskSolver.load({ feedField: field });
  try {
    const cell = [-6, 4, -9];
    const world = new PhysicsWorld()
      .add(feed(0), {})
      .add(disk, { centralMass: 1 / G, edges: [2, 3, 4, 6, 8], viscosity: 1, initialDensity: 2 }, cell);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const value = new Float64Array(memory.buffer, 24, 1);
    value[0] = 6;
    const region = { name: 'borrowed-feed', byteOffset: 24, byteLength: 8, layout: 1, type: 'f64', memory };
    const supply = { field: field.name, tick: 0, region, cell: [-31, -9, 2] };
    const context = { tick: 0, level: 0, seed: 0, cell, inputs: new Map([[field.name, supply]]) };
    const dt = 1 / 60;
    disk.step(context, dt);
    assert.equal(disk.budget().suppliedMass, 0.1);
    for (const port of disk.exportPorts(0)) assert.deepEqual(port.cell, cell);
    const snapshot = world.takeSnapshot().bytes.slice();
    const receipt = disk.readNativeWork();
    const check = (action, message, code = 'state') => {
      assert.throws(action, { code, message });
      assert.deepEqual(world.takeSnapshot().bytes, snapshot);
      assert.deepEqual(disk.readNativeWork(), receipt);
    };
    supply.region = { ...region, layout: 2 };
    check(() => disk.step(context, dt), /layout-1 f64 outer supply.*#accretion/, 'version');
    supply.region = { ...region, byteOffset: 25 };
    check(() => disk.step(context, dt), /aligned f64 offset.*#accretion/);
    supply.region = region;
    value[0] = Infinity;
    check(() => disk.step(context, dt), /finite, nonnegative supplied mass rate.*#accretion/);
    value[0] = 0;
    check(() => disk.step(context, -dt), /nonnegative step duration.*#accretion/);
    check(
      () => disk.step(context, Number.MAX_VALUE),
      /transport or heating.*Reduce mass, flux or step duration.*#accretion/,
    );
    const end = () => {
      world.shiftOrigin([1, -5, 11]);
      for (const port of disk.exportPorts(0)) assert.deepEqual(port.cell, [-7, 9, -20]);
      world.advance(5);
      return world.takeSnapshot().bytes.slice();
    };
    const advanced = end();
    world.restoreSnapshot(snapshot);
    assert.deepEqual(end(), advanced);
  } finally {
    disk[Symbol.dispose]();
  }
});

test('SPACE-03 rejects a Kerr trial that cannot fit a bounded observer step and keeps the accepted coordinates', () => {
  const tracer = new KerrGeodesicSolver();
  const cell = [-17, 4, -2];
  const world = new PhysicsWorld().add(
    tracer,
    { ...kerrCircularOrbit(10, 0.4), centralMass: (C * C * C) / G, radius: 10, spin: 0.4 },
    cell,
  );
  const initial = world.takeSnapshot().bytes.slice();
  const context = { tick: 0, level: 0, seed: 0, cell, inputs: new Map() };
  assert.deepEqual(tracer.exportPorts(0)[0].cell, cell);
  assert.throws(() => tracer.step(context, 100000), {
    code: 'state',
    message: /cannot resolve the orbit.*Shorten the step.*#accretion/,
  });
  assert.deepEqual(world.takeSnapshot().bytes, initial);
  world.shiftOrigin([7, -5, 6]);
  assert.deepEqual(tracer.exportPorts(0)[0].cell, [-24, 9, -8]);
  world.advance(10);
  const end = world.takeSnapshot().bytes.slice();
  world.restoreSnapshot(initial);
  world.shiftOrigin([7, -5, 6]);
  world.advance(10);
  assert.deepEqual(world.takeSnapshot().bytes, end);
});
