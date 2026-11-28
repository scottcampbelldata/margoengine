import assert from 'node:assert/strict';
import test from 'node:test';
import { IceSolver } from '../../dist/ice.js';
import { expectedIceWork, followIce, iceCell, iceWaterMasses } from '../fixtures/ice-thermal-workers.mjs';

for (const sites of [257, 341]) {
  test(
    'ICE-05 native phase-energy balances match scalar sheets, frost and icicles at ' + sites + ' sites',
    async () => {
      const baseline = await followIce(sites, 0);
      const { state } = baseline.accepted;
      const { first, samples } = state;
      assert.deepEqual(baseline.replay, baseline.accepted);

      assert.ok(samples[0].thickness > first[0].thickness, 'cold insulated saline sheet freezes');
      assert.ok(samples[1].thickness > first[1].thickness, 'vapour deposits on cold frost');
      assert.ok(samples[2].length > first[2].length && samples[2].meltwater > 0, 'icicle tip grows and drips');
      assert.ok(samples[3].thickness < first[3].thickness && samples[3].heatAbsorbed > 0, 'warm sheet ablates');
      assert.ok(samples[4].thickness < first[4].thickness && samples[4].meltwater > 0, 'warm frost thaws');
      assert.ok(samples[5].length < first[5].length && samples[5].meltwater > 0, 'warm icicle melts');
      const { expectedSteam, expectedDrainage, steam, drainage } = iceWaterMasses(first);
      assert.ok(Math.abs(steam - expectedSteam) <= 12 * Number.EPSILON * expectedSteam);
      assert.ok(Math.abs(drainage - expectedDrainage) <= 12 * Number.EPSILON * expectedDrainage);
      for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, iceCell);

      for (const [threads, shared] of [
        [1, false],
        [1, true],
        [2, true],
        [4, true],
      ]) {
        const actual = await followIce(sites, threads, shared);
        assert.deepEqual(actual.accepted.state, state);
        assert.deepEqual(actual.replay, actual.accepted);
        for (const receipt of actual.accepted.work) assert.deepEqual(receipt, expectedIceWork(sites, threads));
      }
    },
  );
}

test('ICE-05 validates worker options and accepts a single physical tail on four participants', async () => {
  await assert.rejects(IceSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#ice-thermal/);
  const stop = new Error('Cancel thermal playback before loading.');
  await assert.rejects(IceSolver.load({ threads: 4, signal: AbortSignal.abort(stop) }), (cause) => cause === stop);

  const plain = await followIce(1, 1);
  const parallel = await followIce(1, 4);
  assert.deepEqual(parallel.accepted.state, plain.accepted.state);
  assert.deepEqual(parallel.replay, parallel.accepted);
  assert.deepEqual(parallel.accepted.work.at(-1), expectedIceWork(1, 4));
  assert.deepEqual(
    parallel.accepted.work.at(-1).workers.map((worker) => worker.sites),
    [0, 0, 0, 1],
  );
});
