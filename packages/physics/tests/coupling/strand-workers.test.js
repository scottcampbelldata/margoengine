import assert from 'node:assert/strict';
import test from 'node:test';
import { StrandSolver } from '../../dist/strands.js';
import { expectedStrandWork, followStrands, strandCell } from '../fixtures/strand-workers.mjs';

for (const [guides, pointsPerGuide] of [
  [1025, 3],
  [1193, 5],
]) {
  test(`SOFT-03 native ${guides}-guide prediction preserves signed motion, contact and replay`, async () => {
    const plain = await followStrands(guides, pointsPerGuide, 1);
    const { state } = plain.accepted;
    assert.deepEqual(state.cells, [strandCell, strandCell]);
    assert.ok(state.pending[0] > 0 && state.pending[5] < 0, JSON.stringify(state.pending));
    assert.ok(state.spin < 0 && state.tip !== 0);

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const run = shared ? await followStrands(guides, pointsPerGuide, threads, shared) : plain;
      assert.deepEqual(run.accepted.state, state);
      assert.deepEqual(run.replay, run.accepted);
      for (const receipt of run.accepted.work)
        assert.deepEqual(receipt, expectedStrandWork(guides, pointsPerGuide, threads));
    }
  });
}

test('SOFT-03 native loading reports unsupported worker counts and preserves abort reasons', async () => {
  await assert.rejects(StrandSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#strands/);
  const abort = new Error('Cancel the strand load.');
  await assert.rejects(StrandSolver.load({ threads: 4, signal: AbortSignal.abort(abort) }), (cause) => cause === abort);
});
