import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudSolver } from '../../dist/clouds.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { cloudPort, expectedCloudWork, far, grid, makeCloud, runCloud } from '../fixtures/cloud-projection-threads-worker.mjs';

test('closed MAC cloud pressure matches scalar with real 1/2/4-thread execution through far-origin replay', async () => {
  const baseline = await runCloud(false, 0);
  assert.ok(baseline.report.cloudPresent);
  assert.ok(baseline.report.diagnostics.divergenceBefore > 0);
  assert.ok(baseline.report.diagnostics.divergenceAfter < baseline.report.diagnostics.divergenceBefore);
  assert.equal(baseline.report.work.cells, 0);
  for (const [shared, threads] of [
    [false, 1],
    [true, 1],
    [true, 2],
    [true, 4],
  ]) {
    const run = await runCloud(shared, threads);
    const report = run.report;
    assert.deepEqual(run.start, baseline.start);
    assert.deepEqual(run.checkpoint, baseline.checkpoint);
    assert.deepEqual(run.final, baseline.final);
    assert.equal(report.hash, baseline.report.hash);
    assert.deepEqual(report.initialCell, far);
    assert.deepEqual(report.shiftedCell, [0, 0, 0]);
    assert.deepEqual(report.restoredCell, far);
    assert.ok(report.originShiftExact && report.exactReplay && report.publicationAgrees);
    assert.ok(report.cloudPresent && report.fieldsChanged && report.sample.velocity[1] > 0);
    assert.deepEqual(report.diagnostics, baseline.report.diagnostics);
    assert.deepEqual(report.sample, baseline.report.sample);
    assert.deepEqual(report.coldWork, expectedCloudWork(grid, threads, 0));
    assert.ok(report.work.applications > 1);
    assert.equal(report.work.applications, report.diagnostics.iterations + 1);
    assert.deepEqual(report.work, expectedCloudWork(grid, threads, report.work.applications));
    assert.deepEqual(report.replayWork, report.work);
  }
});

test('odd cloud volumes exercise measured SIMD pressure work on every participant', async () => {
  for (const cells of [
    [25, 13, 17],
    [49, 17, 23],
  ]) {
    using serial = await CloudSolver.load();
    using parallel = await CloudSolver.load({ threads: 4 });
    const plain = makeCloud(serial, false, cells);
    const shared = makeCloud(parallel, true, cells);
    try {
      plain.advance(1);
      shared.advance(1);
      const work = parallel.workCounts();
      assert.ok(work.applications > 1);
      assert.deepEqual(parallel.projectionDiagnostics, serial.projectionDiagnostics);
      assert.equal(work.applications, parallel.projectionDiagnostics.iterations + 1);
      assert.deepEqual(work, expectedCloudWork(cells, 4, work.applications));
      assert.deepEqual(serial.workCounts(), expectedCloudWork(cells, 1, work.applications));
      assert.ok(work.workers.every(({ pairedCells }) => pairedCells > 0));
      assert.deepEqual(cloudPort(shared), cloudPort(plain));
      assert.deepEqual(shared.takeSnapshot().bytes, plain.takeSnapshot().bytes);
      console.log('ATMO-03 native pressure products', cells, work);
    } finally {
      plain.remove(serial.describe().id);
      shared.remove(parallel.describe().id);
    }
  }
});

test('cloud pressure threads give a coded remedy for a plain world', async () => {
  using cloud = await CloudSolver.load({ threads: 2 });
  assert.throws(
    () => new PhysicsWorld({ memory: worldMemory(false) }).add(cloud, { cells: [5, 3, 3] }),
    { name: 'MargoError', code: 'unsupported', message: /worldMemory\(true\)|shared.*threads: 1/i },
  );
});
