import assert from 'node:assert/strict';
import test from 'node:test';
import { VortexForcing } from '../../dist/vortices.js';
import { expectedCell, followVortexWater } from '../fixtures/vortex-water-workers.mjs';

function checkWork(work, cells, threads, windStress) {
  assert.equal(work.threads, threads);
  assert.equal(work.cells, cells);
  assert.ok(work.wetCells > 0 && work.wetCells < cells);
  assert.equal(work.pressureSamples, 4 * work.wetCells);
  assert.equal(work.pairedRadiusLanes, work.pressureSamples);
  assert.equal(work.windSamples, windStress ? work.wetCells : 0);
  assert.equal(work.workers.length, threads);
  for (const [part, worker] of work.workers.entries()) {
    const start = Math.floor((part * cells) / threads);
    const end = Math.floor(((part + 1) * cells) / threads);
    assert.equal(worker.cells, end - start);
    assert.ok(worker.wetCells > 0 && worker.wetCells < worker.cells);
    assert.equal(worker.pressureSamples, 4 * worker.wetCells);
    assert.equal(worker.pairedRadiusLanes, worker.pressureSamples);
    assert.equal(worker.windSamples, windStress ? worker.wetCells : 0);
  }
}

for (const [kind, nx, nz, windStress] of [
  ['cyclone', 19, 13, true],
  ['tornado', 23, 17, true],
  ['waterspout', 19, 13, true],
  ['dustDevil', 23, 17, false],
  ['fireWhirl', 19, 13, true],
]) {
  test('ATMO-05 ' + kind + ' signed water forcing replays exactly in scalar and native partitions', async () => {
    const scalar = await followVortexWater(kind, nx, nz, 0, windStress);
    const { state } = scalar.accepted;
    assert.equal(scalar.replay.state.snapshot.hash, state.snapshot.hash);
    assert.deepEqual(scalar.replay.state, state);
    assert.deepEqual(state.cell, expectedCell);
    assert.deepEqual(state.waterCell, expectedCell);
    assert.ok(state.forces.some((q) => q > 0) && state.forces.some((q) => q < 0));
    assert.deepEqual(Array.from(state.dryForcing), [0, 0, 0, 0, 0]);
    assert.ok(state.water.some((value, index) => index % 3 !== 0 && value !== 0));
    let ordinary;
    for (const [threads, shared] of [[1, false], [1, true], [2, true], [4, true]]) {
      const actual = await followVortexWater(kind, nx, nz, threads, windStress, shared);
      assert.equal(actual.accepted.state.snapshot.hash, state.snapshot.hash);
      assert.deepEqual(actual.accepted.state, state);
      assert.deepEqual(actual.replay, actual.accepted);
      ordinary ??= actual.accepted.work;
      for (const [frame, work] of actual.accepted.work.entries()) {
        checkWork(work, nx * nz, threads, windStress);
        assert.equal(work.wetCells, ordinary[frame].wetCells);
      }
    }
  });
}

test('ATMO-05 reports a coded native thread option error and keeps the caller abort reason', async () => {
  await assert.rejects(VortexForcing.load({ water: true, threads: 3 }), /Choose 1, 2 or 4.*#vortex/);
  const reason = new Error('cancel vortex loading');
  await assert.rejects(
    VortexForcing.load({ water: true, threads: 4, signal: AbortSignal.abort(reason) }),
    (cause) => cause === reason,
  );
});
