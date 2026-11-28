import assert from 'node:assert/strict';
import test from 'node:test';
import { SeismicGround } from '../../dist/seismic.js';
import { expectedCell, expectedWork, followSeismic } from '../fixtures/seismic-workers.mjs';

for (const [width, depth] of [
  [31, 27],
  [37, 31],
]) {
  test('EARTH-08 layered P-SV worker stencils and signed-origin replay agree on ' + width + '×' + depth, async () => {
    const baseline = await followSeismic(width, depth, 1);
    const { state } = baseline.accepted;
    assert.deepEqual(baseline.replay, baseline.accepted);
    assert.ok(state.motion.peakHorizontalAcceleration > 0);
    assert.ok(state.motion.velocity.every((velocity) => Number.isFinite(velocity) && velocity !== 0));
    assert.ok(state.inside.every((velocity) => Number.isFinite(velocity) && velocity !== 0));
    assert.ok(Math.abs(state.building.displacement) > 0);
    assert.ok(state.soil.cyclicStress > 0);
    assert.equal(Object.keys(state.ports).length, 2);
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, expectedCell);

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const actual = shared ? await followSeismic(width, depth, threads, shared) : baseline;
      assert.deepEqual(actual.accepted.state, state);
      assert.deepEqual(actual.replay, actual.accepted);
      const expected = expectedWork(width, depth, threads);
      for (const receipt of actual.accepted.work) assert.deepEqual(receipt, expected);
    }
  });
}

test('EARTH-08 worker options are coded, abort is preserved, and empty strata do not write cells', async () => {
  await assert.rejects(SeismicGround.load({ threads: 3 }), /Choose 1, 2 or 4.*#seismic/);
  const stop = new Error('Cancel earthquake playback before loading.');
  await assert.rejects(SeismicGround.load({ threads: 4, signal: AbortSignal.abort(stop) }), (cause) => cause === stop);

  const plain = await followSeismic(2, 2, 1);
  const parallel = await followSeismic(2, 2, 4);
  assert.deepEqual(parallel.accepted.state, plain.accepted.state);
  assert.deepEqual(parallel.replay, parallel.accepted);
  for (const receipt of parallel.accepted.work) assert.deepEqual(receipt, expectedWork(2, 2, 4));
  assert.deepEqual(
    parallel.accepted.work.at(-1).workers.map((worker) => worker.velocityCells),
    [0, 2, 0, 2],
  );
});
