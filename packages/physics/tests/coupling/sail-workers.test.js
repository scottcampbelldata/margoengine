import assert from 'node:assert/strict';
import test from 'node:test';
import { followSail, readSailPhysical, sailCell, sailWorkerWorld } from '../fixtures/sail-workers.mjs';

function verifyWork(work, circulation, threads) {
  const n = circulation.length;
  const attached = Array.from(circulation, (value) => value !== 0);
  const sources = attached.filter(Boolean).length;
  assert.ok(sources > 0 && sources < n);
  assert.equal(work.threads, threads);
  assert.equal(work.solves, 1);
  assert.equal(work.matrixInteractions, sources * sources);
  assert.equal(work.wakeInteractions, work.matrixInteractions);
  assert.ok(work.eliminationUpdates > 0 && work.eliminationPairs > 0);
  assert.equal(work.workers.length, threads);
  for (const [part, participant] of work.workers.entries()) {
    const pairs = Math.floor(n / 2);
    const lo = 2 * Math.floor((part * pairs) / threads);
    const hi = part + 1 === threads ? n : 2 * Math.floor(((part + 1) * pairs) / threads);
    const targets = attached.slice(lo, hi).filter(Boolean).length;
    let pairedTargets = 0;
    for (let i = lo; i + 1 < hi; i += 2) pairedTargets += Number(attached[i] && attached[i + 1]);
    assert.equal(participant.matrixInteractions, sources * targets);
    assert.equal(participant.wakeInteractions, participant.matrixInteractions);
    assert.equal(participant.matrixPairs, sources * pairedTargets);
    assert.equal(participant.wakePairs, participant.matrixPairs);
    assert.equal(participant.eliminationUpdates, part === 0 ? work.eliminationUpdates : 0);
    assert.equal(participant.eliminationPairs, part === 0 ? work.eliminationPairs : 0);
  }
}

for (const [panels, chord] of [
  [[3, 9], 'u'],
  [[5, 11], 'v'],
]) {
  test(`AERO-02 native ${panels.join('×')} membrane loads match legacy and rewind after a signed rebase`, async () => {
    const legacy = await followSail(panels, 0, chord);
    assert.deepEqual(legacy.accepted, legacy.replay);
    const { physical } = legacy.accepted;
    assert.ok(physical.force[0] > 0 && physical.force[1] !== 0);
    assert.notEqual(physical.hullVelocity[0], Math.fround(0.24), 'the loaded luff acts on the rigid hull');
    assert.ok(physical.velocities.some((velocity) => velocity !== 0));
    for (const threads of [1, 2, 4]) {
      const run = await followSail(panels, threads, chord);
      assert.deepEqual(run.accepted, run.replay);
      assert.deepEqual(run.accepted.cell, sailCell);
      assert.deepEqual(run.accepted.physical, physical);
      verifyWork(run.accepted.work, run.accepted.physical.circulation, threads);
    }
  });
}

test('AERO-02 rejects invalid wind before accepting new impulses or operation counts', async () => {
  const fixture = await sailWorkerWorld([3, 9], 4);
  const { world, physics, sail, setInvalid } = fixture;
  try {
    world.advance(1);
    const prior = readSailPhysical(fixture);
    const work = sail.readNativeWork();
    const checkpoint = world.takeSnapshot();
    setInvalid(true);
    assert.throws(() => sail.beforeStep(1 / 60), /finite.*#physics-sail/i);
    assert.deepEqual(readSailPhysical(fixture), prior);
    assert.deepEqual(sail.readNativeWork(), work);
    assert.deepEqual(world.takeSnapshot(), checkpoint);
    setInvalid(false);
    world.advance(2);
    assert.notDeepEqual(readSailPhysical(fixture), prior);
  } finally {
    physics.dispose();
  }
});

test('AERO-02 native sail translates a different signed wind cell before and after rewind', async () => {
  const expected = await followSail([3, 9], 4);
  const crossCell = await followSail([3, 9], 4, 'u', true);
  assert.deepEqual(crossCell.accepted, expected.accepted);
  assert.deepEqual(crossCell.replay, crossCell.accepted);
});
