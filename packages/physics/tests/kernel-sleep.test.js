// Islands and sleeping through Wasm.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, loadKernel } from '../dist/next.js';

function still(x = 0, rows = 8) {
  const world = new KernelWorld(rows);
  world.setGravity(0, 0, 0);
  const body = world.addBody('dynamic');
  world.addCollider(body, 'ball', [0.5]);
  world.columns.positionX[body] = x;
  return { world, body };
}

test('a still body sleeps after the window, wakes on request, and sleepers leave the step', async () => {
  await loadKernel();
  const { world, body } = still();
  assert.equal(world.awakeCount, 1);
  let steps = 0;
  while (!world.isSleeping(body) && steps < 100) {
    world.step(1 / 60);
    steps++;
  }
  assert.ok(steps >= 30 && steps <= 31, `${steps} steps of the 0.5 s window`);
  assert.equal(world.awakeCount, 0);
  assert.equal(world.islandCount, 0);
  world.wake(body);
  assert.equal(world.isSleeping(body), false);
  assert.equal(world.awakeCount, 1);
  world.step(1 / 60);
  assert.equal(world.islandCount, 1);
});

test('touching bodies make one island, and fixed bodies join none', async () => {
  await loadKernel();
  const world = new KernelWorld(4);
  world.setGravity(0, 0, 0);
  const [a, b, c] = [world.addBody('dynamic'), world.addBody('dynamic'), world.addBody('dynamic')],
    wall = world.addBody('fixed'),
    { positionX } = world.columns;
  for (const body of [a, b, c]) world.addCollider(body, 'ball', [0.5]);
  world.addCollider(wall, 'ball', [0.5], { density: 0 });
  positionX[b] = 0.7;
  positionX[c] = 2.1;
  positionX[wall] = 1.4;
  world.step(1 / 60);
  assert.equal(world.pairCount, 3);
  assert.equal(world.islandCount, 2, 'a and b; c alone, as the wall carries nothing across');
});

test('sleep asks, wake reaches the whole island, setCanSleep holds it up', async () => {
  await loadKernel();
  const world = new KernelWorld(4);
  world.setGravity(0, 0, 0);
  const a = world.addBody('dynamic'),
    b = world.addBody('dynamic');
  world.addCollider(a, 'ball', [0.5]);
  world.addCollider(b, 'ball', [0.5]);
  world.columns.positionX[b] = 0.7;
  world.step(1 / 60);
  world.sleep(a);
  world.step(1 / 60);
  assert.equal(world.isSleeping(a), false, 'b is not ready yet, and an island goes together');
  world.sleep(b);
  world.step(1 / 60);
  assert.equal(world.isSleeping(a), true);
  assert.equal(world.isSleeping(b), true);
  world.wake(b);
  assert.equal(world.isSleeping(a), false);
  world.setCanSleep(a, false);
  for (let i = 0; i < 60; i++) world.step(1 / 60);
  assert.equal(world.isSleeping(a) || world.isSleeping(b), false);
  world.setCanSleep(a, true);
  for (let i = 0; i < 40; i++) world.step(1 / 60);
  assert.equal(world.isSleeping(b), true);
});

test('the thresholds read back and bad ones are refused', async () => {
  await loadKernel();
  const { world, body } = still();
  assert.equal(world.sleepEnergy, Math.fround(2e-4));
  assert.equal(world.sleepTime, 0.5);
  world.setSleep(1, 0.25);
  assert.equal(world.sleepEnergy, 1);
  assert.equal(world.sleepTime, 0.25);
  let steps = 0;
  while (!world.isSleeping(body) && steps < 100) {
    world.step(1 / 60);
    steps++;
  }
  assert.ok(steps >= 15 && steps <= 16, `${steps}`);
  for (const [energy, time] of [
    [-1, 1],
    [1, -1],
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
  ])
    assert.throws(() => world.setSleep(energy, time), RangeError);
});

test('a dead row is ignored by wake and sleep and reads as awake', async () => {
  await loadKernel();
  const { world, body } = still();
  world.removeBody(body);
  world.wake(body);
  world.sleep(body);
  assert.equal(world.isSleeping(body), false);
  assert.equal(world.awakeCount, 0);
  assert.equal(world.isSleeping(100), false);
});
