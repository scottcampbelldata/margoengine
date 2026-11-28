import assert from 'node:assert/strict';
import test from 'node:test';
import { MaterialAgeingSolver } from '../../dist/ageing.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { ageingCell, expectedAgeingWork, followAgeing } from '../fixtures/ageing-workers.mjs';

for (const count of [129, 173]) {
  test('BIO-04 native mixed-patch ageing retains exact scalar state on ' + count + ' patches', async () => {
    const scalar = await followAgeing(count, 0);
    const { state } = scalar.accepted;
    assert.deepEqual(scalar.replay, scalar.accepted);
    assert.ok(scalar.accepted.work.every((receipt) => receipt === undefined));
    assert.deepEqual(state.cell, ageingCell);
    assert.ok(state.readings[0].consumedThickness > state.before[0].consumedThickness);
    assert.ok(
      state.readings[2].rotActivity > 0 && state.readings[2].consumedThickness > state.before[2].consumedThickness,
    );
    assert.ok(state.readings[3].consumedThickness > state.before[3].consumedThickness);
    assert.equal(state.readings[1].exposureSeconds, 0, 'a zero multiplier leaves a patch unexposed');
    assert.ok(state.readings[5].coatingThickness > state.readings[5].innerCoatingThickness);
    assert.ok(state.readings.some(({ fouledFraction }) => fouledFraction > 0));
    assert.notDeepEqual(state.appearances[0].color, state.appearances[5].color);

    for (const [threads, shared] of [
      [1, false],
      [1, true],
      [2, true],
      [4, true],
    ]) {
      const actual = await followAgeing(count, threads, shared);
      assert.deepEqual(actual.accepted.state, state);
      assert.deepEqual(actual.replay, actual.accepted);
      for (const receipt of actual.accepted.work) assert.deepEqual(receipt, expectedAgeingWork(count, threads));
    }
  });
}

test('BIO-04 native options are coded and one physical patch keeps a single odd-tail participant', async () => {
  await assert.rejects(MaterialAgeingSolver.load({ threads: 3 }), /Choose 1, 2 or 4.*#ageing/);
  const stop = new Error('Cancel material ageing before loading.');
  await assert.rejects(
    MaterialAgeingSolver.load({ threads: 4, signal: AbortSignal.abort(stop) }),
    (cause) => cause === stop,
  );

  const baseline = await followAgeing(1, 0);
  const actual = await followAgeing(1, 4);
  assert.deepEqual(actual.accepted.state, baseline.accepted.state);
  assert.deepEqual(actual.replay, actual.accepted);
  assert.deepEqual(actual.accepted.work.at(-1), expectedAgeingWork(1, 4));
  assert.deepEqual(
    actual.accepted.work.at(-1).workers.map((worker) => worker.patches),
    [0, 0, 0, 1],
  );
});

test('BIO-04 a remote tail overflow retains accepted surface, history and worker receipt', async () => {
  using solver = await MaterialAgeingSolver.load({ threads: 4 });
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) });
  world.add(solver, {
    patches: Array.from({ length: 9 }, (_, i) => ({
      material: i % 2 ? 'wood' : 'steel',
      exposureMultiplier: i === 8 ? 1e6 : 1e-303,
    })),
  });
  world.advance(1);
  const previous = world.takeSnapshot();
  const work = solver.readNativeWork();
  assert.equal(work.patches, 9);
  const context = { tick: 1, level: 0, seed: 17, cell: [0, 0, 0], inputs: new Map() };
  assert.throws(() => solver.step(context, 1e303), /trial ageing step.*#ageing/);
  assert.deepEqual(world.takeSnapshot(), previous);
  assert.deepEqual(solver.readNativeWork(), work);
  world.advance(2);
  assert.notEqual(world.takeSnapshot().hash, previous.hash);
});
