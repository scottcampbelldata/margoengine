// Solver settings through Wasm: the setters check, hold across a snapshot, and change what the solver does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, loadKernel } from '../dist/index.js';
// Bad input to a body, collider, shape, query or mesh is a coded MargoError linking its help entry (Part 1, item 3).
const rigidCoded = (error) =>
  error?.name === 'MargoError' &&
  error.code === 'unsupported' &&
  /See https:..margoengine.com.errors#physics-(bodies|meshes)$/.test(error.message);

function resting(options) {
  const world = new KernelWorld(8);
  world.setSolver(options);
  const floor = world.addBody('fixed');
  world.addCollider(floor, 'box', [5, 0.5, 5], { density: 0 });
  const body = world.addBody('dynamic');
  world.addCollider(body, 'box', [0.5, 0.5, 0.5], { density: 1000 });
  world.columns.positionY[body] = 1.2;
  for (let i = 0; i < 120; i++) world.step(1 / 60);
  return { world, y: world.columns.positionY[body] };
}

test('solver settings read back, check their range and survive a snapshot', async () => {
  await loadKernel();
  const world = new KernelWorld(8);
  const defaults = world.solver;
  assert.equal(defaults.contactHertz, 120);
  assert.equal(defaults.jointShare, 1);
  world.setSolver({ contactHertz: 60, jointShare: 0.5, allowedPenetration: 0.001 });
  assert.equal(world.solver.contactHertz, 60);
  assert.equal(world.solver.contactDamping, defaults.contactDamping);
  assert.throws(() => world.setSolver({ jointShare: 2 }), rigidCoded);
  assert.throws(() => world.setSolver({ contactHertz: -1 }), rigidCoded);
  assert.throws(() => world.setSolver({ contactMaxPush: NaN }), rigidCoded);
  assert.throws(() => world.setSolver({ contactMaxPush: Infinity }), rigidCoded);
  assert.equal(world.solver.jointShare, 0.5, 'a refused call changes nothing');
  const saved = world.snapshot();
  world.setSolver({ contactHertz: 30 });
  world.restore(saved);
  assert.equal(world.solver.contactHertz, 60);
});

test('the allowed penetration is the depth a resting box keeps', async () => {
  await loadKernel();
  const tight = resting({ allowedPenetration: 0 }).y;
  const loose = resting({ allowedPenetration: 0.02 }).y;
  assert.ok(tight > 1 - 0.005 && tight < 1.001, `tight rest ${tight}`);
  assert.ok(loose < tight - 0.01, `loose rest ${loose} sits deeper than ${tight}`);
});

test('a world with the same settings replays bit for bit', async () => {
  await loadKernel();
  const a = resting({ contactHertz: 40, contactDamping: 4 }).world.hash;
  const b = resting({ contactHertz: 40, contactDamping: 4 }).world.hash;
  assert.equal(a, b);
});

test('warm start of 1 is the default, and a cold start still rests a box but carries nothing between substeps', async () => {
  await loadKernel();
  assert.equal(new KernelWorld(8).solver.warmStart, 1);
  assert.throws(() => new KernelWorld(8).setSolver({ warmStart: 1.5 }), rigidCoded);
  const warm = resting({});
  const cold = resting({ warmStart: 0 });
  assert.ok(Math.abs(cold.y - 1) < 0.01, `cold rest ${cold.y}`);
  assert.notEqual(warm.world.hash, cold.world.hash);
});
