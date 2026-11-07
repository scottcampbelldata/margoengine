// The broad phase through Wasm: pairs read from JS, and views that survive growth inside a step.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, loadKernel } from '../dist/next.js';

/** A free ball at a place, with a velocity along x. */
function ball(world, x, speed = 0) {
  const body = world.addBody('dynamic'),
    collider = world.addCollider(body, 'ball', [0.5]);
  world.columns.positionX[body] = x;
  world.columns.linearX[body] = speed;
  return { body, collider };
}

test('pairs start and stop as fat boxes meet and part', async () => {
  await loadKernel();
  const world = new KernelWorld(2);
  world.setGravity(0, 0, 0);
  const a = ball(world, 0),
    b = ball(world, 3, -2);
  world.step(1 / 60);
  assert.equal(world.pairCount, 0);
  assert.deepEqual(world.pairs(), []);
  let meetings = 0;
  for (let i = 0; i < 60 && !world.pairCount; i++) {
    world.step(1 / 60);
    meetings = i;
  }
  assert.deepEqual(world.pairs(), [[a.collider, b.collider]]);
  // Ball b is at 3 - (i + 1) / 30 when pass i looks. Boxes meet when the gap between the balls is at most two margins of
  // 0.04 m plus the 1/30 m the step can reach, so no sooner than x = 1.1133, pass 56. A box can lag one margin behind, but
  // the pair must exist before the step that could touch, x = 1.0333, pass 58.
  assert.ok(meetings >= 56 && meetings <= 58, `pair began on pass ${meetings}`);
  world.columns.linearX[b.body] = 20;
  for (let i = 0; i < 30; i++) world.step(1 / 60);
  assert.equal(world.pairCount, 0);
});

test('growth inside a step rebinds the views', async () => {
  await loadKernel();
  const world = new KernelWorld(200);
  world.setGravity(0, 0, 0);
  for (let i = 0; i < 200; i++) ball(world, 0);
  const before = world.columns.positionX;
  world.step(1 / 60);
  assert.equal(world.pairCount, (200 * 199) / 2);
  assert.notEqual(world.columns.positionX, before, 'new views after the pairs outgrew their rows');
  assert.equal(world.columns.positionX.length, 200);
  world.columns.positionX[7] = 4;
  assert.equal(world.columns.positionX[7], 4);
  const pairs = world.pairs();
  assert.equal(pairs.length, world.pairCount);
  assert.ok(pairs.every(([a, b]) => a < b));
});

test('a fixed body written by hand needs touch', async () => {
  await loadKernel();
  const world = new KernelWorld(2);
  world.setGravity(0, 0, 0);
  ball(world, 0);
  const wall = world.addBody('fixed');
  world.addCollider(wall, 'box', [1, 1, 1], { density: 0 });
  world.columns.positionX[wall] = 100;
  world.step(1 / 60);
  assert.equal(world.pairCount, 0);
  world.columns.positionX[wall] = 1;
  world.step(1 / 60);
  assert.equal(world.pairCount, 0);
  world.touch(wall);
  world.step(1 / 60);
  assert.equal(world.pairCount, 1);
});

test('the pair list is the same at any capacity', async () => {
  await loadKernel();
  const run = (bodies, colliders) => {
    const world = new KernelWorld(bodies, colliders);
    world.setGravity(0, 0, 0);
    for (let i = 0; i < 40; i++) ball(world, i * 0.4, ((i * 7) % 5) - 2);
    const lists = [];
    for (let i = 0; i < 40; i++) {
      world.step(1 / 60);
      lists.push(world.pairs());
    }
    return lists;
  };
  assert.deepEqual(run(1, 1), run(500, 900));
});
