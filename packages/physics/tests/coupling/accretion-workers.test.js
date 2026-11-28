import assert from 'node:assert/strict';
import test from 'node:test';
import { AccretionDiskSolver } from '../../dist/accretion.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { accretionCell, expectedAccretionWork, followAccretion } from '../fixtures/accretion-workers.mjs';

for (const rings of [65, 129]) {
  test('SPACE-03 native disk publication and signed replay agree across ' + rings + ' annuli', async () => {
    const plain = await followAccretion(rings, 1);
    const { state } = plain.accepted;
    assert.deepEqual(plain.replay, plain.accepted);
    assert.ok(state.rings[0].phase !== state.before.phase);
    assert.ok(state.rings[0].density !== state.before.density);
    assert.ok(state.rings.every(({ heating, phase }) => heating > 0 && phase >= 0 && phase <= 2 * Math.PI));
    const { initialMass, suppliedMass, accretedMass, escapedMass, remainingMass, luminosity } = state.budget;
    const offered = initialMass + suppliedMass;
    assert.ok(suppliedMass > 0 && accretedMass > 0 && escapedMass > 0 && luminosity > 0);
    assert.ok(
      Math.abs(offered - (remainingMass + accretedMass + escapedMass)) <= 9 * 16 * rings * Number.EPSILON * offered,
    );
    assert.equal(Object.keys(state.ports).length, 3);
    for (const port of Object.values(state.ports)) assert.deepEqual(port.cell, accretionCell);

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const current = shared ? await followAccretion(rings, threads, shared) : plain;
      assert.deepEqual(current.accepted.state, state);
      assert.deepEqual(current.replay, current.accepted);
      for (const receipt of current.accepted.work) assert.deepEqual(receipt, expectedAccretionWork(rings, threads));
    }
  });
}

test('SPACE-03 worker counts are coded and a singleton annulus stays a scalar tail', async () => {
  await assert.rejects(AccretionDiskSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#accretion/);
  const abort = new Error('Cancel the accretion simulation before loading.');
  await assert.rejects(
    AccretionDiskSolver.load({ threads: 4, signal: AbortSignal.abort(abort) }),
    (cause) => cause === abort,
  );
  const plain = await followAccretion(1, 1);
  const four = await followAccretion(1, 4);
  assert.deepEqual(four.accepted.state, plain.accepted.state);
  assert.deepEqual(four.replay, four.accepted);
  assert.deepEqual(four.accepted.work.at(-1), expectedAccretionWork(1, 4));
  assert.deepEqual(
    four.accepted.work.at(-1).workers.map(({ annuli }) => annuli),
    [0, 0, 0, 1],
  );
});

test('SPACE-03 phase overflow during native publication preserves all accepted banks and receipt', async () => {
  using disk = await AccretionDiskSolver.load({ threads: 4 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) });
  world.add(disk, {
    centralMass: 1e200,
    edges: Array.from({ length: 10 }, (_, i) => 100 + 10 * i),
    initialDensity: 0.5,
    viscosity: 0,
  });
  world.advance(1);
  const prior = world.takeSnapshot();
  const work = disk.readNativeWork();
  const scope = { tick: 1, level: 0, seed: 17, cell: [0, 0, 0], inputs: new Map() };
  assert.throws(() => disk.step(scope, 1e220), /transport or heating exceeds the numeric range.*#accretion/);
  assert.deepEqual(world.takeSnapshot(), prior);
  assert.deepEqual(disk.readNativeWork(), work);
  world.advance(2);
  assert.notEqual(world.takeSnapshot().hash, prior.hash);
});
