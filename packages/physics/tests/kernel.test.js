// KernelWorld: the views alias the kernel's memory, rows survive growth, and the load behaves like Physics.load.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KernelWorld, loadKernel } from '../dist/next.js';

test('a world before the load says what to do', async () => {
  // This file's first test: nothing in this process has loaded the kernel yet.
  assert.throws(() => new KernelWorld(), { code: 'state', message: /loadKernel/ });
  const aborted = AbortSignal.abort(new Error('stop'));
  await assert.rejects(loadKernel({ signal: aborted }), /stop/);
  await loadKernel();
  await loadKernel();
});

test('column views read what the kernel holds, as f32 and u32', async () => {
  await loadKernel();
  const world = new KernelWorld(8),
    { positionX, flags } = world.columns;
  assert.ok(positionX instanceof Float32Array);
  assert.ok(flags instanceof Uint32Array);
  assert.equal(positionX.length, 8);
  const empty = world.hash;
  positionX[3] = 1.5;
  assert.notEqual(world.hash, empty, 'a write through a view lands in the world the kernel hashes');
  positionX[3] = 0;
  assert.equal(world.hash, empty);
});

test('reserve keeps rows at their index, and views are rebuilt', async () => {
  await loadKernel();
  const world = new KernelWorld(4),
    { positionY: before } = world.columns;
  before[2] = 7.25;
  world.columns.flags[3] = 9;
  world.reserve(100_000);
  assert.equal(world.capacity, 100_000);
  assert.equal(world.columns.positionY[2], 7.25);
  assert.equal(world.columns.flags[3], 9);
  assert.equal(world.columns.positionY[4], 0);
  assert.equal(world.columns.positionY.length, 100_000);
  assert.ok(world.bytes > 100_000 * 4 * Object.keys(world.columns).length - 1);
  assert.throws(() => world.reserve(2 ** 23), RangeError);
});

test('two worlds share no memory', async () => {
  await loadKernel();
  const a = new KernelWorld(4),
    b = new KernelWorld(4);
  a.columns.positionX[0] = 1;
  assert.equal(b.columns.positionX[0], 0);
  assert.notEqual(a.hash, b.hash);
});

test('a capacity the kernel refuses throws', async () => {
  await loadKernel();
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 23]) assert.throws(() => new KernelWorld(bad), RangeError);
});
