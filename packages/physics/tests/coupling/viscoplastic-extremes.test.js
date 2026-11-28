import assert from 'node:assert/strict';
import test from 'node:test';
import { VISCOPLASTIC_INLET_WORDS, VISCOPLASTIC_LAYOUT, ViscoplasticSolver } from '../../dist/viscoplastic.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const rate = { num: 60, den: 1 };
const point = { position: [0.5, 0.5, 0.5], volume: 0.01 };
const box = { cells: [2, 2, 2], spacing: 0.5, points: [point] };
const error = (message) => ({ name: 'MargoError', code: 'state', message });

function stateBytes(world, solver) {
  return solver
    .stateRegions()
    .map(({ byteOffset, byteLength }) => Buffer.from(new Uint8Array(world.memory.buffer, byteOffset, byteLength)));
}

test('viscoplastic setup and rendering errors name a correction', async () => {
  await assert.rejects(ViscoplasticSolver.load(null), error(/Pass an options object/));
  await assert.rejects(ViscoplasticSolver.load({ id: ' ' }), error(/nonempty name/));
  await assert.rejects(ViscoplasticSolver.load({ terrain: { columns: -1 } }), error(/valid TerrainBed shape/));
  const solver = await ViscoplasticSolver.load();
  for (const [invalid, expected] of [
    [{ cells: null }, /three positive whole cell counts/],
    [{ cells: [1000, 1000, 1000] }, /fewer cells or points/],
    [{ origin: [2 ** 53, 0, 0] }, /Use a local origin and larger cells/],
    [{ spacing: Number.MIN_VALUE }, /squared cell spacing/],
    [{ walls: Array(6) }, /six booleans/],
    [{ points: [null] }, /position and volume/],
    [{ points: [{ ...point, volume: Number.MAX_VALUE }] }, /point mass/],
    [{ points: [{ ...point, velocityGradient: [null, null, null] }] }, /three finite values/],
  ])
    assert.throws(() => new PhysicsWorld({ rate }).add(solver, { ...box, ...invalid }), error(expected));
  const world = new PhysicsWorld({ rate }).add(solver, box);
  assert.throws(() => solver.sample(1), error(/row below capacity/));
  assert.throws(() => solver.particleSource(new Float32Array(5)), error(/six words per active point/));
  assert.throws(
    () => solver.particleSource(new Float32Array(world.memory.buffer, 0, 6)),
    error(/outside the physics arena/),
  );
  assert.throws(() => solver.particleSource(undefined, [0.5, 0, 0]), error(/whole world-cell/));
  assert.throws(() => solver.particleSource(undefined, [1e10, 0, 0]), error(/nearer render cell/));
});

test('an over-budget explicit viscoplastic tick keeps every accepted byte', async () => {
  for (const shared of [false, true]) {
    const solver = await ViscoplasticSolver.load();
    const world = new PhysicsWorld({ rate, gravity: [0, 0, 0], memory: worldMemory(shared) }).add(solver, {
      cells: [1, 1, 1],
      spacing: 0.05,
      bulkModulus: 1e12,
      points: [{ position: [0.025, 0.025, 0.025], volume: 1e-7 }],
    });
    const before = stateBytes(world, solver);
    assert.throws(() => world.advance(1), error(/4096 explicit microsteps.*Increase cell spacing/));
    assert.equal(world.tick, 0);
    assert.deepEqual(stateBytes(world, solver), before);
  }
});

const field = {
  name: 'large-outlet-feed',
  kind: 'particleSet',
  quantity: 'volumeRate',
  unit: 'SI',
  centring: 'particle',
};

class LargeOutletFeed {
  describe() {
    return { id: field.name, rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] };
  }

  init(host) {
    this.host = host;
    this.region = host.allocate('flow', VISCOPLASTIC_INLET_WORDS * 8, 'f64', VISCOPLASTIC_LAYOUT);
    regionWords(host.memory, this.region).set([0.99, 0.5, 0.5, 4, 0, 0, 1.3e308]);
  }

  step() {}
  importPorts() {}
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
  exportPorts(tick) {
    return [{ field: field.name, region: this.region, tick, cell: this.host.cell }];
  }
}

test('an overflowing cumulative inlet ledger is refused before accepting a new candidate', async (t) => {
  for (const [shared, threads] of [
    [false, 1],
    [true, 1],
    [true, 4],
  ]) {
    const solver = await ViscoplasticSolver.load({ inlet: field, threads });
    t.after(() => solver[Symbol.dispose]());
    const world = new PhysicsWorld({ rate, gravity: [0, 0, 0], memory: worldMemory(shared) })
      .add(new LargeOutletFeed(), {})
      .add(solver, {
        cells: [1, 1, 1],
        spacing: 1,
        capacity: 1,
        density: 1e-304,
        bulkModulus: 1e-304,
        shearModulus: 1e-305,
        yieldStress: 0,
        consistency: 0,
        walls: [true, false, true, true, true, true],
      });
    world.advance(82);
    assert.equal(solver.budget.activePoints, 0);
    assert.ok(solver.budget.injectedReferenceVolume > 1.77e308);
    assert.equal(solver.budget.injectedReferenceVolume, solver.budget.escapedReferenceVolume);
    const before = stateBytes(world, solver);
    const work = solver.workCounts();
    const acceptedTick = world.tick;
    const saved = world.takeSnapshot();
    for (let pass = 0; pass < 2; pass++) {
      assert.throws(() => world.advance(83), error(/cumulative injected reference volume/));
      assert.equal(world.tick, acceptedTick);
      assert.deepEqual(stateBytes(world, solver), before);
      assert.deepEqual(solver.workCounts(), work);
      world.restoreSnapshot(saved.bytes);
    }
  }
});

test('particle source packs accepted active slots in the current or supplied render cell', async () => {
  const solver = await ViscoplasticSolver.load();
  const cell = [2, 0, -1];
  const velocity = [0.25, -0.5, 0.75];
  const world = new PhysicsWorld({ rate }).add(solver, { ...box, capacity: 3, points: [{ ...point, velocity }] }, cell);
  const out = new Float32Array(6);
  const source = solver.particleSource(out, cell);
  assert.equal(source.positions, out);
  assert.equal(source.velocities, out);
  assert.equal(source.count, 1);
  assert.equal(source.stride, 6);
  assert.equal(source.velocityOffset, 3);
  assert.deepEqual(Array.from(out), [...point.position, ...velocity]);
  assert.deepEqual(solver.exportPorts(0)[0].cell, cell);
  const worldPosition = [8192.5, 0.5, -4095.5];
  assert.deepEqual(Array.from(solver.particleSource(out, [0, 0, 0]).positions), [...worldPosition, ...velocity]);
  world.shiftOrigin(cell);
  assert.deepEqual(solver.exportPorts(0)[0].cell, [0, 0, 0]);
  assert.deepEqual(Array.from(solver.particleSource(out).positions), [...point.position, ...velocity]);
});

test('a stale shared renderer destination cannot overwrite accepted viscoplastic records', async () => {
  const solver = await ViscoplasticSolver.load();
  const world = new PhysicsWorld({ rate, memory: worldMemory(true) }).add(solver, box);
  const { region } = solver.exportPorts(0)[0];
  const oldView = new Float32Array(world.memory.buffer, region.byteOffset, 6);
  world.memory.grow(1);
  assert.notEqual(oldView.buffer, world.memory.buffer);
  const before = stateBytes(world, solver);
  assert.throws(() => solver.particleSource(oldView), error(/standalone ArrayBuffer/));
  assert.deepEqual(stateBytes(world, solver), before);
  assert.deepEqual(Array.from(solver.particleSource().positions), [...point.position, 0, 0, 0]);
});
