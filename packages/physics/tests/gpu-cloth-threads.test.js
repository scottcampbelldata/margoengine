// @margoengine/physics/gpu-cloth's CPU route on worker threads (SOFT-01 point 6): a static schedule shares every pass of
// every substep among the threads, so 1, 2, 4 and 8 threads step a cloth to the same bits, do the same work in all, and
// share it evenly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { GPUCloth } from '../dist/gpu-cloth.js';
import { SoftBodyDesc } from '../dist/soft.js';

await Physics.load();
await GPUCloth.load();

/** A 24 by 24 flag pinned along its pole in a gusty wind, falling onto a sphere: every pass the kernel has. */
async function flag(threads) {
  await GPUCloth.load(undefined, { threads });
  const n = 24,
    pole = Array.from({ length: n }, (_, j) => j);
  const cloth = new GPUCloth(
    SoftBodyDesc.cloth([0, 2, 0], [0.05, 0, 0], [0, -0.05, 0], n, n).setPinnedParticles(pole),
    {
      threads,
      wind: [4, 0, 1],
      turbulence: 0.3,
      colliders: [{ shape: 'sphere', position: [0.6, 1.2, 0.1], radius: 0.25 }],
    },
  );
  cloth.step(20);
  const { state } = await cloth.snapshot();
  const out = { state, work: { ...cloth.stats.work }, threadWork: cloth.stats.threadWork };
  cloth.dispose();
  return out;
}

test('1, 2, 4 and 8 threads step a cloth to the same bits and do the same work, shared evenly', async () => {
  const one = await flag(1);
  assert.equal(one.threadWork, undefined, 'one thread reports no shares');
  const total = one.work.particles + one.work.edges + one.work.colliderTests;
  for (const threads of [2, 4, 8]) {
    const run = await flag(threads);
    assert.deepEqual(
      new Uint32Array(run.state.buffer),
      new Uint32Array(one.state.buffer),
      `${threads} threads: the same bits`,
    );
    assert.deepEqual(run.work, one.work, `${threads} threads: the same work`);
    assert.equal(run.threadWork.length, threads);
    assert.equal(
      run.threadWork.reduce((a, b) => a + b, 0),
      total,
      `${threads} threads: the shares sum to the work`,
    );
    // Each pass gives every thread n / threads of its items, give or take one: the pinned pole (24 of 576 particles, all
    // in the first share) is the only unevenness, so no thread does more than 1.1 times an even share.
    const even = total / threads;
    for (const share of run.threadWork)
      assert.ok(share <= 1.1 * even && share > 0.85 * even, `${threads} threads: ${run.threadWork}`);
  }
});

test('threads are a whole number from 1 to 64, and a cloth of more threads than were loaded is refused', async () => {
  const desc = SoftBodyDesc.cloth([0, 0, 0], [0.1, 0, 0], [0, 0, 0.1], 3, 3);
  for (const threads of [0, 1.5, 65])
    assert.throws(
      () => new GPUCloth(desc, { threads }),
      (e) => e.name === 'MargoError' && /errors#gpu-cloth/.test(e.message),
    );
  await assert.rejects(GPUCloth.load(undefined, { threads: 0 }), (e) => e.name === 'MargoError');
  assert.throws(
    () => new GPUCloth(desc, { threads: 3 }),
    (e) => e.name === 'MargoError' && /GPUCloth.load/.test(e.message),
  );
});
