import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedFogWork, fogWorkerRun } from '../fixtures/drainage-fog-workers.mjs';

test('several CFL intervals give exact signed-origin fog columns, optics, ledger and replay in Node native helpers', async () => {
  for (const [width, depth] of [
    [33, 27],
    [77, 45],
  ]) {
    const count = width * depth;
    const scalar = await fogWorkerRun(width, depth, 1, false);
    const { air, water, exportedAir, exportedWater, deposited, surfaceWater, entrainedAir, entrainedWater } =
      scalar.accepted.budget;
    assert.ok(exportedAir > 0 && exportedWater > 0 && deposited > 0 && entrainedAir > 0);
    // The global ledger covers five steps, each summing many column and face contributions face-by-face in f64 order.
    const balance = (actual, initial) =>
      assert.ok(Math.abs(actual - initial) <= 256 * count * Number.EPSILON * initial, `${actual} against ${initial}`);
    balance(air + exportedAir - entrainedAir, scalar.initialBudget.air);
    balance(water + exportedWater + deposited - surfaceWater - entrainedWater, scalar.initialBudget.water);
    assert.deepEqual(scalar.firstWind, [6, -3.75, 17]);
    assert.ok(scalar.accepted.fields[0].words.some((value, index) => index % 4 === 2 && value > 0));
    const substeps = scalar.accepted.work.resolvedRows / count;
    assert.ok(Number.isInteger(substeps) && substeps > 1);
    for (const [shared, threads] of [
      [false, 1],
      [true, 1],
      [true, 2],
      [true, 4],
    ]) {
      const run = !shared ? scalar : await fogWorkerRun(width, depth, threads, shared);
      assert.deepEqual(run.start.bytes, scalar.start.bytes);
      assert.deepEqual(run.accepted.snapshot.bytes, scalar.accepted.snapshot.bytes);
      assert.deepEqual(run.replay.snapshot.bytes, run.accepted.snapshot.bytes);
      assert.deepEqual(run.accepted.fields, scalar.accepted.fields);
      assert.deepEqual(run.replay.fields, run.accepted.fields);
      assert.deepEqual(run.accepted.budget, scalar.accepted.budget);
      assert.deepEqual(run.replay.budget, run.accepted.budget);
      assert.deepEqual(run.firstWind, scalar.firstWind);
      assert.deepEqual(run.restoredCells, [run.far, run.far]);
      assert.deepEqual(
        run.accepted.fields.map(({ cell }) => cell),
        [
          [0, 0, 0],
          [0, 0, 0],
        ],
      );
      assert.deepEqual(run.coldWork, expectedFogWork(count, 0, threads));
      assert.deepEqual(run.accepted.work, expectedFogWork(count, substeps, threads));
      assert.deepEqual(run.replay.work, run.accepted.work);
    }
    console.log('ATMO-08 native fog grid', width, depth, 'CFL intervals', substeps, scalar.accepted.snapshot.hash);
  }
});
