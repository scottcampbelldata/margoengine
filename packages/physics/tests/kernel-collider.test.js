// Bodies and colliders through Wasm: free lists, mass from shapes, and growth.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, loadKernel } from '../dist/next.js';

test('mass, centre and moments come from the colliders', async () => {
  await loadKernel();
  const world = new KernelWorld(2),
    body = world.addBody('dynamic'),
    { inverseMass, inertiaX, inertiaY, localCenterY } = world.columns;
  world.addCollider(body, 'box', [0.5, 1, 1.5], { density: 2 });
  assert.equal(inverseMass[body], Math.fround(1 / 12));
  assert.ok(Math.abs(inertiaX[body] - 13) <= 13 * 2 ** -21, 'm (b^2 + c^2) / 3 for a 12 kg box');
  assert.ok(Math.abs(inertiaY[body] - 10) <= 10 * 2 ** -21);
  world.addCollider(body, 'ball', [1], { position: [0, 3, 0], density: 0 });
  assert.equal(inverseMass[body], Math.fround(1 / 12), 'a density of zero adds no mass');
  assert.equal(localCenterY[body], 0);
  const ball = world.addCollider(body, 'ball', [1], { position: [0, 3, 0], density: 12 / ((4 / 3) * Math.PI) });
  assert.ok(Math.abs(localCenterY[body] - 1.5) <= 1.5 * 2 ** -21, 'equal masses meet half way');
  assert.equal(world.removeCollider(ball), true);
  assert.equal(world.removeCollider(ball), false);
  assert.equal(localCenterY[body], 0);
});

test('additional mass scales the inertia', async () => {
  await loadKernel();
  const world = new KernelWorld(1),
    body = world.addBody('dynamic'),
    { inverseMass, inertiaX, additionalMass } = world.columns;
  world.addCollider(body, 'capsule', [0.5, 1], { density: 1 });
  const mass = 1 / inverseMass[body],
    moment = inertiaX[body];
  additionalMass[body] = mass;
  world.updateMass(body);
  assert.ok(Math.abs(1 / inverseMass[body] - 2 * mass) <= 2 * mass * 2 ** -21);
  assert.ok(Math.abs(inertiaX[body] - 2 * moment) <= 2 * moment * 2 ** -21);
});

test('freed rows come back last in, first out, and hold nothing of the old row', async () => {
  await loadKernel();
  const world = new KernelWorld(4, 4),
    [a, b, c] = [world.addBody('dynamic'), world.addBody('dynamic'), world.addBody('dynamic')];
  const collider = world.addCollider(b, 'ball', [1]);
  world.columns.positionX[b] = 9;
  const generation = world.columns.generation[b],
    colliderGeneration = world.columns.colliderGeneration[collider];
  assert.equal(world.removeBody(b), true);
  assert.equal(world.removeBody(b), false);
  assert.equal(world.removeBody(-1), false);
  assert.equal(world.removeBody(99), false);
  assert.equal(world.removeBody(1.5), false);
  assert.equal(world.removeBody(a), true);
  assert.equal(world.addBody('fixed'), a);
  assert.equal(world.addBody('dynamic'), b);
  assert.equal(world.addBody('dynamic'), c + 1);
  assert.equal(world.columns.positionX[b], 0);
  assert.equal(world.columns.inverseMass[b], 0);
  assert.equal(world.columns.generation[b], generation + 1);
  assert.equal(world.addCollider(b, 'ball', [1]), collider);
  assert.equal(world.columns.colliderGeneration[collider], colliderGeneration + 1);
});

test('addCollider grows the world by itself', async () => {
  await loadKernel();
  const world = new KernelWorld(1, 1),
    body = world.addBody('dynamic'),
    rows = [];
  for (let i = 0; i < 40; i++) rows.push(world.addCollider(body, 'ball', [0.1], { position: [i, 0, 0] }));
  assert.deepEqual(rows, Array.from({ length: 40 }, (_, i) => i));
  assert.ok(world.colliderCapacity >= 40);
  assert.equal(world.capacity, 1);
  assert.ok(Math.abs(world.columns.localCenterX[body] - 19.5) <= 19.5 * 2 ** -20);
});

test('a collider the kernel cannot use is refused with what to do', async () => {
  await loadKernel();
  const world = new KernelWorld(2),
    body = world.addBody('dynamic');
  assert.throws(() => world.addCollider(5, 'ball', [1]), { name: 'RangeError', message: /holds no body/ });
  assert.throws(() => world.addCollider(body, 'cloud', [1]), { name: 'RangeError', message: /Unknown shape/ });
  assert.throws(() => world.addCollider(body, 'box', [1, 1]), { name: 'RangeError', message: /3 finite sizes/ });
  assert.throws(() => world.addCollider(body, 'ball', [0]), RangeError);
  assert.throws(() => world.addCollider(body, 'ball', [Number.NaN]), RangeError);
  assert.throws(() => world.addCollider(body, 'ball', [1], { density: -1 }), { message: /Density/ });
  assert.throws(() => world.addCollider(body, 'ball', [1], { position: [Number.NaN, 0, 0] }), { message: /finite/ });
  assert.throws(() => world.addCollider(body, 'ball', [1], { rotation: [1, 1, 0, 0] }), { message: /unit quaternion/ });
  assert.equal(world.columns.inverseMass[body], 0, 'nothing was added');
});
