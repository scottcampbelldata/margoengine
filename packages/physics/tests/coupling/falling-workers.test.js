import assert from 'node:assert/strict';
import test from 'node:test';
import { FALLING_BODY_WORDS, FALLING_SPHERE_DRAW_WORDS, FallingSolver } from '../../dist/falling.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { expectedCell, followFalling } from '../fixtures/falling-workers.mjs';

function checkWork(receipt, count, threads) {
  assert.equal(receipt.threads, threads);
  assert.equal(receipt.workers.length, threads);
  assert.equal(receipt.bodies, count);
  assert.equal(receipt.simdStatePairs, 28 * receipt.rk4Evaluations);
  assert.ok(receipt.rk4Evaluations > 3 * count);
  for (const [part, worker] of receipt.workers.entries()) {
    const start = Math.floor((part * count) / threads);
    const end = Math.floor(((part + 1) * count) / threads);
    assert.equal(worker.bodies, end - start);
    assert.ok(worker.rk4Evaluations > 3 * worker.bodies);
    assert.equal(worker.simdStatePairs, 28 * worker.rk4Evaluations);
  }
}

for (const count of [303, 457]) {
  test('AERO-05 mixed native plate, samara and sphere flight replays on ' + count + ' signed body rows', async () => {
    const baseline = await followFalling(count, 1);
    const { state, work } = baseline.accepted;
    assert.equal(baseline.replay.state.snapshot.hash, state.snapshot.hash);
    assert.deepEqual(baseline.replay, baseline.accepted);
    assert.deepEqual(state.cell, expectedCell);
    assert.equal(state.poses.length, count * FALLING_BODY_WORDS);
    assert.equal(state.draw.length, Math.floor(count / 3) * FALLING_SPHERE_DRAW_WORDS);
    assert.ok(Math.abs(state.plate.angularVelocity[2]) > 0 && state.plate.position[1] < 5.1);
    assert.ok(state.samara.angularVelocity[1] > 0 && state.samara.position[1] < 5.22);
    assert.ok(Math.abs(state.grounded.position[1] - state.groundedRadius) < 64 * Number.EPSILON);
    assert.equal(state.grounded.velocity[1], 0);
    for (const [threads, shared] of [[1, true], [2, true], [4, true]]) {
      const actual = await followFalling(count, threads, shared);
      assert.equal(actual.accepted.state.snapshot.hash, state.snapshot.hash);
      assert.deepEqual(actual.accepted.state, state);
      assert.deepEqual(actual.replay, actual.accepted);
      for (const [i, receipt] of actual.accepted.work.entries()) {
        checkWork(receipt, count, threads);
        assert.equal(receipt.rk4Evaluations, work[i].rk4Evaluations);
      }
    }
  });
}

test('AERO-05 native helper failures name the correction and loading preserves the AbortSignal reason', async () => {
  await assert.rejects(FallingSolver.load({ threads: 3 }), { code: 'unsupported', message: /Choose 1, 2 or 4.*#falling/ });
  const reason = new Error('cancel mixed flight');
  await assert.rejects(FallingSolver.load({ threads: 4, signal: AbortSignal.abort(reason) }), (error) => error === reason);
  using rejected = await FallingSolver.load({ threads: 2 });
  const plain = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  assert.throws(
    () => plain.add(rejected, { bodies: [{ kind: 'sphere', diameter: 0.01, mass: 0.001 }] }),
    { code: 'unsupported', message: /Use shared world memory.*#falling/ },
  );
});
