// Writing poses to meshes walks the kernel's awake list (next/sync.ts): what it writes, and what it no longer touches.
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Physics } from '../dist/next.js';

await Physics.load();
const DT = 1 / 60;

/** An engine on a stand-in renderer that counts mesh lookups (`mesh.check`) and `writePoses` rows. */
async function counted(capacity = 256) {
  const engine = new Engine(
      { width: 1, height: 1 },
      await TransformStore.create(capacity),
      { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
      undefined,
      null,
    ),
    counts = { lookups: 0, calls: 0, rows: 0 };
  engine.meshes.get = (key) => {
    counts.lookups++;
    return Map.prototype.get.call(engine.meshes, key);
  };
  engine.writePoses = (ids, poses, count) => {
    counts.calls++;
    counts.rows += count;
    return Engine.prototype.writePoses.call(engine, ids, poses, count);
  };
  const reset = () => {
    const copy = { ...counts };
    counts.lookups = counts.calls = counts.rows = 0;
    return copy;
  };
  return { engine, reset };
}
const ball = { shape: 'sphere', radius: 0.5 };
const mesh = (engine, x) => engine.createMesh().setGeometry(box(1)).setPosition([x, 0, 0]);

test('sleeping bodies cost a sync nothing: one writePoses and one lookup for each moving body', async () => {
  const { engine, reset } = await counted(),
    physics = new Physics(null, { gravity: [0, 0, 0], interpolate: false }),
    moving = [],
    resting = [];
  for (let i = 0; i < 200; i++) {
    const fast = i % 4 === 0,
      body = physics.addBody(mesh(engine, i * 3), { colliders: ball, canSleep: !fast, linearVelocity: [0, +fast, 0] });
    (fast ? moving : resting).push(body);
  }
  for (const body of resting) body.sleep();
  for (let frame = 0; frame < 3; frame++) physics.update(DT);
  assert.ok(resting.every((body) => body.sleeping));
  assert.equal(physics.kernel.awakeCount, 50);
  reset();
  physics.update(DT);
  assert.deepEqual(reset(), { lookups: 50, calls: 1, rows: 50 }, 'the 150 sleepers are not looked at');
  for (const body of moving) assert.equal(Math.fround(body.position[1]), body.mesh.position.y);
  physics.dispose();
  engine.dispose();
});

test('a body that falls asleep is written once more, at rest, then not again', async () => {
  const { engine, reset } = await counted(),
    physics = new Physics(null, { gravity: [0, 0, 0] }),
    body = physics.addBody(mesh(engine, 0), { colliders: ball, linearVelocity: [1, 0, 0] });
  physics.update(DT * 1.5);
  assert.equal(reset().rows, 1, 'moving: written');
  body.sleep();
  physics.update(DT);
  assert.ok(body.sleeping);
  assert.equal(reset().rows, 1, 'the step that put it to sleep: one final write');
  assert.equal(body.mesh.position.x, Math.fround(body.position[0]), 'the final write is the pose at rest');
  reset();
  for (let frame = 0; frame < 5; frame++) physics.update(DT);
  assert.deepEqual(reset(), { lookups: 0, calls: 0, rows: 0 }, 'asleep: nothing');
  body.wakeUp();
  body.setLinearVelocity([0, 0, 1]);
  physics.update(DT);
  assert.equal(reset().rows, 1, 'awake again: written');
  physics.dispose();
  engine.dispose();
});

test('a sleeper or fixed body placed by hand is written once', async () => {
  const { engine, reset } = await counted(),
    physics = new Physics(null, { gravity: [0, 0, 0] }),
    sleeper = physics.addBody(mesh(engine, 0), { colliders: ball }),
    floor = physics.addBody(mesh(engine, 5), { type: 'fixed', colliders: ball });
  sleeper.sleep();
  for (let frame = 0; frame < 3; frame++) physics.update(DT);
  reset();
  sleeper.setPosition([0, 7, 0], false);
  floor.setPosition([5, -2, 0]);
  physics.update(DT);
  assert.ok(sleeper.sleeping);
  assert.equal(reset().rows, 2);
  assert.equal(sleeper.mesh.position.y, 7);
  assert.equal(floor.mesh.position.y, -2);
  physics.update(DT);
  assert.equal(reset().rows, 0);
  physics.dispose();
  engine.dispose();
});

test('sleeping bodies on child meshes keep their world pose while the parent moves, a new parent included', async () => {
  const { engine, reset } = await counted(),
    physics = new Physics(null, { gravity: [0, 0, 0] }),
    parent = mesh(engine, 10),
    child = mesh(engine, 1).setParent(parent),
    later = mesh(engine, 4),
    body = physics.addBody(child, { colliders: ball }),
    other = physics.addBody(later, { colliders: ball });
  body.sleep();
  other.sleep();
  for (let frame = 0; frame < 3; frame++) physics.update(DT);
  assert.ok(body.sleeping && other.sleeping);
  parent.setPosition([20, 0, 0]);
  physics.update(DT);
  assert.equal(child.position.x, Math.fround(body.position[0] - 20), 'child of a moved parent');
  reset();
  // A resting body whose root mesh gains a parent: the mesh keeps the body's world pose.
  later.setParent(parent);
  physics.update(DT);
  assert.equal(later.position.x, Math.fround(other.position[0] - 20));
  assert.equal(reset().calls, 0, 'children go through the setters, never a root batch');
  physics.dispose();
  engine.dispose();
});

test('a body whose mesh was disposed is removed at the end of the sync, the others still written', async () => {
  const { engine } = await counted(),
    physics = new Physics(null, { gravity: [0, 0, 0], interpolate: false }),
    bodies = [0, 1, 2].map((i) => physics.addBody(mesh(engine, i * 3), { colliders: ball, linearVelocity: [0, 1, 0] }));
  physics.update(DT);
  bodies[1].mesh.dispose();
  physics.update(DT);
  assert.equal(physics.owns(bodies[1]), false);
  assert.equal(bodies[0].valid && bodies[2].valid, true);
  for (const body of [bodies[0], bodies[2]]) assert.equal(body.mesh.position.y, Math.fround(body.position[1]));
  physics.dispose();
  engine.dispose();
});
