// The replay proof in Node: the scenes of replay-scene.js against the hashes a native run and every browser must also give.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { KernelWorld, Physics } from '../dist/next.js';
import { kernelSourceHash } from '../scripts/build-kernel.mjs';
import { REPLAY_EVERY, REPLAY_STEPS, kernelScene, physicsScene } from './replay-scene.js';

const golden = JSON.parse(readFileSync(new URL('fixtures/replay-hash.json', import.meta.url), 'utf8'));
await Physics.load();

test('the hashes on file were made by the kernel as it stands', () => {
  assert.equal(golden.kernelSource, kernelSourceHash(), 'run node packages/physics/scripts/replay-golden.mjs');
  assert.equal(golden.steps, REPLAY_STEPS);
  assert.equal(golden.every, REPLAY_EVERY);
});

test('10,000 steps of the kernel give the hashes on file', () => {
  assert.deepEqual(kernelScene(KernelWorld), golden.kernel);
});

test('10,000 steps through Physics give the hashes on file', () => {
  assert.deepEqual(physicsScene(Physics), golden.physics);
});

test('the kernel scene reaches what it claims to cover', () => {
  let sleepers = 0,
    pairs = 0,
    islands = 0,
    grew = false,
    capacity = 0;
  kernelScene(KernelWorld, REPLAY_STEPS, (world, step) => {
    let asleep = 0;
    for (let row = 0; row < world.capacity; row++) if (world.isSleeping(row)) asleep++;
    sleepers = Math.max(sleepers, asleep);
    pairs = Math.max(pairs, world.pairCount);
    islands = Math.max(islands, world.islandCount);
    if (step > 0 && world.capacity !== capacity) grew = true;
    capacity = world.capacity;
  });
  assert.ok(sleepers >= 8, `at most ${sleepers} sleepers at once`);
  assert.ok(pairs >= 8, `at most ${pairs} pairs`);
  assert.ok(islands >= 8, `at most ${islands} islands`);
  assert.ok(grew, 'the world grew during the run');
});

test('a world that moved one bit gives a different hash: the proof can fail', () => {
  const steps = 200,
    clean = kernelScene(KernelWorld, steps),
    moved = kernelScene(KernelWorld, steps, (world, step) => {
      if (step === 50) world.columns.positionX[0] += 2 ** -20;
    });
  assert.equal(clean[0], golden.kernel[0]);
  assert.notEqual(moved[0], clean[0]);
});
