import assert from 'node:assert/strict';
import test from 'node:test';
import { wingLatticeRun, wingWorkerWorld } from '../fixtures/wing-lattice-workers.mjs';

const workKeys = [
  'matrixInteractions',
  'matrixPairs',
  'wakeInteractions',
  'wakePairs',
  'eliminationUpdates',
  'eliminationPairs',
];

for (const panels of [
  [3, 17],
  [5, 19],
]) {
  test(`native wing lattice matches scalar loads and signed replay at ${panels.join('×')} panels`, async () => {
    const n = panels[0] * panels[1];
    const reference = await wingLatticeRun(panels, 0);
    const attached = reference.accepted.circulation.filter((value) => value !== 0).length;
    assert.ok(attached > 0 && attached < n, 'the coupled wing contains attached and separated rows');
    assert.ok(reference.accepted.force.every(Number.isFinite) && reference.accepted.force.some((value) => value !== 0));
    let serialWork;
    for (const threads of [1, 2, 4]) {
      const { start, accepted, replay, restoredCell, initialCell } = await wingLatticeRun(panels, threads);
      assert.deepEqual(start.bytes, reference.start.bytes);
      assert.deepEqual(accepted.snapshot.bytes, reference.accepted.snapshot.bytes);
      assert.deepEqual(accepted.force, reference.accepted.force);
      assert.deepEqual(accepted.torque, reference.accepted.torque);
      assert.deepEqual(accepted.circulation, reference.accepted.circulation);
      assert.deepEqual(accepted.position, reference.accepted.position);
      assert.deepEqual(replay, accepted);
      assert.deepEqual(restoredCell, initialCell);
      assert.equal(accepted.cell[1], initialCell[1] - 1);
      const work = accepted.work;
      assert.equal(work.threads, threads);
      assert.equal(work.workers.length, threads);
      assert.ok(work.solves > 1 && work.matrixInteractions > n && work.wakeInteractions > n);
      assert.ok(work.matrixPairs > 0 && work.wakePairs > 0 && work.eliminationPairs > 0);
      serialWork ??= work;
      for (const key of workKeys) {
        assert.equal(work[key], serialWork[key], key);
        assert.equal(
          work[key],
          work.workers.reduce((sum, participant) => sum + participant[key], 0),
        );
      }
      assert.ok(work.workers.every(({ matrixInteractions }) => matrixInteractions > 0));
      assert.ok(work.workers.slice(1).every(({ eliminationPairs }) => eliminationPairs === 0));
    }
  });
}

test('an invalid later panel leaves the accepted threaded wing receipt unchanged and recovers', async () => {
  const { world, physics, wing, fail, recover } = await wingWorkerWorld([3, 17], 4);
  try {
    world.advance(1);
    const checkpoint = world.takeSnapshot();
    const before = {
      force: [...wing.force],
      torque: [...wing.torque],
      circulation: wing.circulation.slice(),
      work: wing.workCounts(),
    };
    fail();
    assert.throws(
      () => world.advance(2),
      (error) => error.code === 'unsupported' && /Pass a finite/.test(error.message),
    );
    assert.deepEqual(wing.force, before.force);
    assert.deepEqual(wing.torque, before.torque);
    assert.deepEqual(wing.circulation, before.circulation);
    assert.deepEqual(wing.workCounts(), before.work);
    recover();
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(2);
    assert.notDeepEqual(wing.circulation, before.circulation);
  } finally {
    physics.dispose();
  }
});
