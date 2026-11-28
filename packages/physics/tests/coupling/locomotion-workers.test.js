import assert from 'node:assert/strict';
import test from 'node:test';
import { GroundLocomotion } from '../../dist/locomotion.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { expectedCell, expectedRows, followLocomotion } from '../fixtures/locomotion-workers.mjs';

function checkWork(work, count, threads) {
  assert.equal(work.threads, threads);
  assert.equal(work.workers.length, threads);
  for (const [key, expected] of Object.entries(expectedRows(0, count))) assert.equal(work[key], expected);
  assert.ok(work.stanceRows > 0 && work.stanceRows < work.contactRows);
  assert.ok(work.pairedContactDots > work.bodies);
  for (const [part, worker] of work.workers.entries()) {
    const start = Math.floor((part * count) / threads);
    const end = Math.floor(((part + 1) * count) / threads);
    for (const [key, expected] of Object.entries(expectedRows(start, end))) assert.equal(worker[key], expected);
    assert.ok(worker.pairedContactDots > 0 && worker.stanceRows > 0);
  }
}

for (const count of [205, 275]) {
  test('LIFE-02 native contact and signed replay agree on ' + count + ' mixed bodies', async () => {
    const baseline = await followLocomotion(count, 1);
    const { state, work } = baseline.accepted;
    assert.equal(baseline.replay.state.snapshot.hash, state.snapshot.hash);
    assert.deepEqual(baseline.replay, baseline.accepted);
    assert.ok(state.snakeContact.force[1] > 0);
    assert.notEqual(state.snakeContact.force[0], 0);
    assert.ok(state.snake.phase > 0 && state.lizard.phase > 0);
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, expectedCell);
    for (const [threads, shared] of [[1, true], [2, true], [4, true]]) {
      const result = await followLocomotion(count, threads, shared);
      assert.equal(result.accepted.state.snapshot.hash, state.snapshot.hash);
      assert.deepEqual(result.accepted.state, state);
      assert.deepEqual(result.replay, result.accepted);
      for (const [frame, receipt] of result.accepted.work.entries()) {
        checkWork(receipt, count, threads);
        const { threads: _one, workers: _serial, ...counts } = work[frame];
        const { threads: _many, workers: _parallel, ...sameCounts } = receipt;
        assert.deepEqual(sameCounts, counts);
      }
    }
  });
}

test('LIFE-02 validates helper options and reports empty worker ranges on a single body', async () => {
  await assert.rejects(GroundLocomotion.load({ threads: 3 }), /Choose 1, 2 or 4.*#locomotion/);
  const bodies = [{ kind: 'lizard' }];
  using rejected = await GroundLocomotion.load({ threads: 2 });
  const plain = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) });
  assert.throws(() => plain.add(rejected, { bodies }), /Use shared world memory.*#locomotion/);

  using movement = await GroundLocomotion.load({ threads: 4 });
  const shared = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) });
  shared.add(movement, { bodies });
  shared.advance(1);
  const { workers } = movement.readNativeWork();
  const zero = { ...expectedRows(0, 0), stanceRows: 0, pairedContactDots: 0 };
  assert.deepEqual(workers.slice(0, 3), [zero, zero, zero]);
  assert.equal(workers[3].contactRows, 5);
});
