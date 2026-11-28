import assert from 'node:assert/strict';
import test from 'node:test';
import { WakeSolver } from '../../dist/sea.js';
import { PhysicsWorld } from '../../dist/world.js';

const dt = 1 / 60;
const rate = { num: 60, den: 1 };
const cell = [-11, 3, -9];
const field = {
  name: 'wake-surface-load',
  kind: 'bodySet',
  quantity: 'seaSource',
  unit: 'SI',
  centring: 'particle',
};
const submerged = { ...field, name: 'wake-submerged-load', quantity: 'submergedSeaSource' };
const offset = 64;

function buffer(rows) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  new Float64Array(memory.buffer, offset, rows.length).set(rows);
  return memory;
}

function port(field, memory, options = {}) {
  return {
    field: field.name,
    tick: 0,
    cell,
    region: { name: field.name, byteOffset: offset, byteLength: 80, layout: 1, type: 'f64', memory },
    ...options,
  };
}

function inputError(correction) {
  return (error) => {
    assert.equal(error.name, 'MargoError');
    assert.equal(error.code, 'state');
    assert.match(error.message, correction);
    return true;
  };
}

test('borrowed signed wake sources publish atomically with velocity, rain and projected volume', () => {
  const surface = buffer([-1.125, 0, 1.1, 120, 0.015, 1.25, -1, 1.1, 22, -0.003]);
  const depth = buffer([0, 0, 1.1, 1, 0.006, 0.5, -0.25, 0.5, 0, 0.001]);
  const cases = [false, true].map((grow) => {
    const world = new PhysicsWorld({ rate });
    let grew = false;
    const wake = new WakeSolver('wake', field, { field: submerged, depths: [0, 0.5, 1] }, {});
    world.add(
      wake,
      {
        cells: [24, 15],
        cellSize: 0.25,
        depth: 1.8,
        sponge: 0,
        waterBelow: true,
        initial: (x, z) => [0.001 * x + 0.002 * z, 0],
        sources: () => {
          if (grow && !grew) {
            world.arena.memory.grow(1);
            grew = true;
          }
          return [{ x: 0, z: 0, radius: 0.6, volume: 0.004, pressure: 16 }];
        },
      },
      cell,
    );
    return { world, wake };
  });
  const ctx = {
    level: 0,
    seed: 1,
    tick: 0,
    cell,
    inputs: new Map([
      [field.name, port(field, surface)],
      [submerged.name, port(submerged, depth)],
    ]),
  };

  for (const { wake } of cases) wake.step(ctx, dt);
  assert.deepEqual(cases[0].world.takeSnapshot().bytes, cases[1].world.takeSnapshot().bytes);
  const { world, wake } = cases[0];
  assert.ok(wake.heights().some((h) => Math.abs(h) > 0.01));
  assert.deepEqual(wake.submergedSourceWork(), { rows: 2, transforms: 2 });
  assert.ok(wake.velocityAt(0.25, -0.2, 0.25).some((v) => v !== 0));
  const state = world.takeSnapshot();
  const sample = wake.sample(0, 0);
  const work = wake.fftWork();
  const published = wake.exportPorts(1);
  assert.deepEqual(
    published.map((value) => value.cell),
    [cell, cell],
  );

  const badSurface = buffer([-1.125, 0, 1.1, 120, 0.015, 1.25, -1, 1.1, Number.NaN, 1]);
  const badDepth = buffer([0, 0, 1.1, 0, 0.006, 0.5, -0.25, 0.5, 3, 0.001]);
  const sourcePort = ctx.inputs.get(field.name);
  for (const [fieldName, bad, fix] of [
    [field.name, port(field, badSurface), /finite pressure and volume/],
    [submerged.name, port(submerged, badDepth), /band/],
    [field.name, { ...sourcePort, cell: [-12, 3, -9] }, /same signed world cell/],
    [field.name, { ...sourcePort, region: { ...sourcePort.region, byteOffset: offset + 3 } }, /owning memory/],
    [field.name, { ...sourcePort, region: { ...sourcePort.region, byteOffset: 65_536 } }, /owning memory/],
  ]) {
    const rejected = { ...ctx, tick: 1, inputs: new Map(ctx.inputs).set(fieldName, bad) };
    assert.throws(() => wake.step(rejected, dt / 2), inputError(fix));
    assert.deepEqual(world.takeSnapshot().bytes, state.bytes);
    assert.deepEqual(wake.sample(0, 0), sample);
    assert.deepEqual(wake.fftWork(), work);
    assert.deepEqual(wake.submergedSourceWork(), { rows: 2, transforms: 2 });
  }
  assert.throws(() => wake.step(ctx, Number.NaN), inputError(/finite positive wake duration/));
  assert.deepEqual(world.takeSnapshot().bytes, state.bytes);

  for (const { wake } of cases) wake.step({ ...ctx, tick: 1 }, dt);
  assert.deepEqual(cases[0].world.takeSnapshot().bytes, cases[1].world.takeSnapshot().bytes);
  world.restoreSnapshot(state.bytes);
  wake.step({ ...ctx, tick: 1 }, dt);
  assert.deepEqual(world.takeSnapshot().bytes, cases[1].world.takeSnapshot().bytes);
});

test('restoring the initial height reproduces the initial finite difference before the first step', () => {
  const wake = new WakeSolver();
  const world = new PhysicsWorld({ rate }).add(wake, {
    cells: [16, 16],
    cellSize: 0.25,
    sponge: 0,
    initial: (x) => [0.05 * Math.cos(Math.PI * x), 0],
  });
  const snapshot = world.takeSnapshot();
  const initial = wake.sample(0, 0);
  assert.ok(initial.height > 0.04);
  assert.equal(initial.velocity[1], 0);
  world.advance(4);
  assert.ok(wake.sample(0, 0).velocity[1] < 0);
  const advanced = world.takeSnapshot().bytes;
  world.restoreSnapshot(snapshot.bytes);
  assert.deepEqual(wake.sample(0, 0), initial);
  world.advance(4);
  assert.deepEqual(world.takeSnapshot().bytes, advanced);
});

test('a phase limit refusal leaves the previous step duration reusable', () => {
  const create = () => {
    const wake = new WakeSolver();
    const world = new PhysicsWorld({ rate }).add(wake, {
      cells: [16, 16],
      cellSize: 0.25,
      sponge: 0,
      initial: (x) => [0.05 * Math.cos(Math.PI * x), 0],
    });
    return { world, wake };
  };
  const steady = create();
  const trial = create();
  steady.world.advance(1);
  trial.world.advance(1);
  const old = trial.world.takeSnapshot();
  // Low modes fit the pinned interval at this duration and later modes do not.
  assert.throws(
    () => trial.wake.step({ level: 0, seed: 0, tick: 1, cell: [0, 0, 0], inputs: new Map() }, 200_000),
    inputError(/finer time step/),
  );
  assert.deepEqual(trial.world.takeSnapshot().bytes, old.bytes);
  steady.world.advance(2);
  trial.world.advance(2);
  assert.deepEqual(trial.world.takeSnapshot().bytes, steady.world.takeSnapshot().bytes);
});
