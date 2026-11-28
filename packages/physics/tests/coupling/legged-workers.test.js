import assert from 'node:assert/strict';
import test from 'node:test';
import { LeggedLocomotion } from '../../dist/legged.js';
import { expectedLeggedWork, followLegged, leggedCell, terrainHeight } from '../fixtures/legged-workers.mjs';

for (const count of [73, 117]) {
  test(`LIFE-01 native stance work and signed replay agree for ${count} bipeds and quadrupeds`, async () => {
    const serial = await followLegged(count, 1);
    const { state } = serial.accepted;
    const bearsLoad = ({ stance, force }) => stance && force[1] > 0;
    const supporting = state.feet.flat().filter(bearsLoad);
    assert.ok(
      state.feet.some((feet, row) => row % 2 === 0 && feet.some(bearsLoad)),
      'biped support',
    );
    assert.ok(
      state.feet.some((feet, row) => row % 2 === 1 && feet.some(bearsLoad)),
      'quadruped support',
    );
    assert.ok(
      state.feet.flat().some(({ stance }) => !stance),
      'swing rows',
    );
    assert.ok(supporting.some(({ force }) => Math.hypot(force[0], force[2]) > 0));
    for (const {
      position: [x, y, z],
    } of supporting) {
      // Triangle interpolation of this plane only adds f32 vertex rounding and f64 arithmetic error.
      assert.ok(Math.abs(y - terrainHeight(x, z)) <= 2 ** -24);
    }
    assert.deepEqual([...new Set(state.poses.map(({ gait }) => gait))].sort(), ['canter', 'run', 'trot', 'walk']);
    assert.equal(
      state.poses.some(({ fallen }) => fallen),
      false,
    );
    assert.equal(Object.keys(state.ports).length, 5);
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, leggedCell);

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const run = shared ? await followLegged(count, threads, shared) : serial;
      assert.deepEqual(run.accepted.state, state);
      assert.deepEqual(run.replay, run.accepted);
      for (const [index, receipt] of run.accepted.work.entries()) {
        assert.deepEqual(receipt, expectedLeggedWork(run.accepted.stance[index], threads));
        assert.ok(receipt.workers.every(({ pairedContactDots }) => pairedContactDots > 0));
      }
    }
  });
}

test('LIFE-01 native legged consumes applied load and preserves abort reasons', async () => {
  const loaded = await followLegged(9, 4);
  const unloaded = await followLegged(9, 4, true, false);
  assert.ok(
    loaded.accepted.state.poses.some(
      ({ velocity }, row) => velocity[1] !== unloaded.accepted.state.poses[row].velocity[1],
    ),
  );
  const cancelled = new Error('Cancel the legged worker load.');
  await assert.rejects(
    LeggedLocomotion.load({ threads: 4, signal: AbortSignal.abort(cancelled) }),
    (cause) => cause === cancelled,
  );
});
