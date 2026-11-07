// What only the own entry does: calls it does not serve yet, snapshots, poses read straight from the columns.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, Physics, loadKernel } from '../dist/next.js';

await Physics.load();
const DT = 1 / 60;

test('a call that is not served yet says so, and what to use', () => {
  const physics = new Physics(null),
    body = physics.addBody(null);
  const unsupported = { code: 'unsupported', message: /not in the own solver yet|does not have yet/ };
  for (const call of [
    () => physics.addModel(),
    () => physics.createCharacterController(),
    () => physics.removeController(),
    () => physics.raycast(),
    () => physics.raycastAll(),
    () => physics.shapeCast(),
    () => physics.projectPoint(),
    () => physics.intersectPoint(),
    () => physics.intersectShape(),
    () => physics.debugRender(),
    () => physics.on('contactstart', () => {}),
    () => physics.addBody(null, { ccd: true }),
    () => physics.addBody(null, { dominance: 1 }),
    () => physics.addBody(null, { colliders: { shape: 'cylinder', radius: 1, halfHeight: 1 } }),
    () => physics.addBody(null, { colliders: { shape: 'sphere', radius: 1, sensor: true } }),
    () => body.setType('fixed'),
    () => body.setMassProperties(),
    () => body.setAdditionalMass(1, [1, 1, 1]),
    () => {
      body.ccd = true;
    },
    () => {
      body.enabled = false;
    },
    () => new Physics(null, { contactFilter: () => true }),
  ])
    assert.throws(call, unsupported);
  assert.equal(physics.bodyCount, 1, 'a refused body leaves nothing behind');
  assert.equal(physics.supportsShape('cylinder'), false);
  assert.equal(physics.supportsShape('capsule'), true);
  assert.throws(() => new Physics(null, { rapier: {} }), TypeError);
  physics.dispose();
});

test('defaults: density 1, 8 substeps of 2 passes', () => {
  const physics = new Physics(null),
    body = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  assert.equal(body.mass, 1);
  assert.equal(physics.substeps, 8);
  assert.equal(physics.iterations, 2);
  physics.substeps = 2;
  assert.equal(new Physics(null, { substeps: 4 }).substeps, 4);
  assert.equal(new Physics(null, { solverIterations: 3 }).substeps, 3, 'the old name is kept for a release');
  assert.equal(physics.solverIterations, 2);
  physics.dispose();
});

test('a massless collider adds nothing, and a mass gives the density for the shape', () => {
  const physics = new Physics(null),
    body = physics.addBody(null, { colliders: { shape: 'capsule', radius: 1, halfHeight: 2, massless: true } });
  assert.equal(body.mass, 0);
  body.addCollider({ shape: 'capsule', radius: 1, halfHeight: 2, mass: 7 });
  assert.ok(Math.abs(body.mass - 7) <= 7e-6);
  assert.ok(Math.abs(body.colliders[1].boundingRadius - 3) <= 1e-6);
  physics.dispose();
});

test('a quaternion is normalised by the kernel, and a bad one refused', () => {
  const physics = new Physics(null),
    body = physics.addBody(null, { rotation: [0, 0, 3, 4] });
  assert.deepEqual(body.rotation, [0, 0, Math.fround(0.6), Math.fround(0.8)]);
  assert.throws(() => body.setRotation([0, 0, 0, 0]), RangeError);
  assert.throws(() => body.setRotation([0, 0, Number.NaN, 1]), RangeError);
  physics.dispose();
});

test('wakeUp false moves a sleeper without waking it', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  body.sleep();
  physics.step();
  body.setPosition([4, 0, 0], false);
  assert.equal(body.sleeping, true);
  physics.step();
  assert.deepEqual(body.position, [4, 0, 0]);
  physics.dispose();
});

test('hash, bytes and steps read as unsigned numbers', async () => {
  await loadKernel();
  const world = new KernelWorld(2);
  let seen = false;
  for (let i = 0; i < 16; i++) {
    world.addBody('dynamic');
    assert.ok(world.hash >= 0 && world.hash <= 0xffffffff);
    seen ||= world.hash > 0x7fffffff;
  }
  assert.ok(seen, 'a run of hashes has its top bit set in half of them');
  const stand = Object.create(KernelWorld.prototype);
  stand.api = { world_bytes: () => -1, world_steps: () => -2, world_hash: () => -3 };
  assert.equal(stand.bytes, 0xffffffff);
  assert.equal(stand.steps, 0xfffffffe);
  assert.equal(stand.hash, 0xfffffffd);
});

/** A small world that does something at every step, for the snapshot tests. */
function moving(bodies = 6) {
  const world = new KernelWorld(2, 2);
  for (let i = 0; i < bodies; i++) {
    const body = world.addBody('dynamic');
    world.addCollider(body, 'box', [0.5, 0.25 + i / 8, 1], { density: 1 });
    world.columns.positionX[body] = i * 0.75;
    world.columns.angularY[body] = i;
  }
  return world;
}

test('a snapshot is the whole world: going back and on again gives the same bits', async () => {
  await loadKernel();
  const world = moving();
  for (let i = 0; i < 50; i++) world.step(DT);
  const saved = world.snapshot(),
    at = world.hash;
  assert.equal(saved.byteLength, world.bytes);
  for (let i = 0; i < 50; i++) world.step(DT);
  const later = world.hash;
  assert.notEqual(later, at);
  world.restore(saved);
  assert.equal(world.hash, at);
  assert.equal(world.steps, 50);
  for (let i = 0; i < 50; i++) world.step(DT);
  assert.equal(world.hash, later);
});

test('a snapshot restores into a world of any size, and its views follow', async () => {
  await loadKernel();
  const world = moving();
  for (let i = 0; i < 20; i++) world.step(DT);
  const saved = world.snapshot(),
    at = world.hash,
    small = new KernelWorld(1, 1);
  small.restore(saved);
  assert.equal(small.hash, at);
  assert.equal(small.capacity, world.capacity);
  assert.equal(small.columns.positionX[5], world.columns.positionX[5]);
  for (let i = 0; i < 20; i++) {
    small.step(DT);
    world.step(DT);
  }
  assert.equal(small.hash, world.hash);
  const large = new KernelWorld(1000, 1000);
  large.restore(world.snapshot());
  assert.equal(large.hash, world.hash);
  assert.equal(large.capacity, world.capacity);
});

test('a snapshot does not alias the world, and bytes that are not one are refused', async () => {
  await loadKernel();
  const world = moving(),
    saved = world.snapshot(),
    at = world.hash;
  world.step(DT);
  world.restore(saved);
  assert.equal(world.hash, at);
  assert.throws(() => world.restore(new Uint8Array(4)), { name: 'RangeError', message: /not a snapshot/ });
  assert.throws(() => world.restore(new Uint8Array(saved.byteLength)), { message: /not a snapshot/ });
  assert.throws(() => world.restore(saved.subarray(0, 1024)), { message: /not a snapshot/ });
  assert.equal(world.hash, at, 'a refused restore changes nothing');
});
