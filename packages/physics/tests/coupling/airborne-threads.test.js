import assert from 'node:assert/strict';
import test from 'node:test';
import { AirborneParticles } from '../../dist/airborne.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { expectedAirborneWork, far, plume, published, runPlume } from '../fixtures/airborne-threads-worker.mjs';

test('shared airborne workers preserve ordered wind, evaporation, mass and outflow across a far-origin replay', async () => {
  const baseline = await runPlume(false, 1);
  for (const [shared, threads] of [
    [false, 1],
    [true, 1],
    [true, 2],
    [true, 4],
  ]) {
    const run = shared ? await runPlume(shared, threads) : baseline;
    const report = run.report;
    assert.deepEqual(run.start, baseline.start);
    assert.deepEqual(run.checkpoint, baseline.checkpoint);
    assert.deepEqual(run.final, baseline.final);
    assert.equal(report.hash, baseline.report.hash);
    assert.deepEqual(report.initialCell, far);
    assert.deepEqual(report.shiftedCell, [0, 0, 0]);
    assert.deepEqual(report.restoredCell, far);
    assert.ok(report.originShiftExact && report.exactReplay && report.cellsAgree && report.particlesChanged);
    assert.deepEqual(report.budget, baseline.report.budget);
    assert.deepEqual(report.ordered, baseline.report.ordered);
    assert.deepEqual(
      report.ordered,
      report.ordered.toSorted((a, b) => a - b),
    );
    assert.deepEqual(report.coldWork, expectedAirborneWork([], threads));
    assert.deepEqual(report.work, report.expectedWork);
    assert.deepEqual(report.replayWork, report.work);
    const { initial, supplied, airborne, deposited, evaporated, outflow, waiting } = report.budget;
    assert.ok(supplied > 0 && airborne > 0 && evaporated > 0 && outflow > 0);
    assert.ok(
      Math.abs(initial + supplied - (airborne + deposited + evaporated + outflow + waiting)) <=
        64 * Number.EPSILON * (initial + supplied),
    );
  }
});

test('two odd airborne parcel batches retain all SIMD and evaporation work across four participants', async () => {
  for (const count of [1027, 4099]) {
    using serial = await AirborneParticles.load();
    using parallel = await AirborneParticles.load({ threads: 4 });
    const { world: plain, initial } = plume(serial, false, count);
    const { world: shared } = plume(parallel, true, count);
    try {
      plain.advance(1);
      shared.advance(1);
      const work = parallel.workCounts();
      assert.deepEqual(work, expectedAirborneWork(initial, 4));
      assert.deepEqual(serial.workCounts(), expectedAirborneWork(initial, 1));
      assert.ok(
        work.workers.every(({ simdAxisPairs, evaporationUpdates }) => simdAxisPairs > 0 && evaporationUpdates > 0),
      );
      assert.deepEqual(published(shared, parallel), published(plain, serial));
      assert.deepEqual(shared.takeSnapshot().bytes, plain.takeSnapshot().bytes);
      console.log('ATMO-06 airborne parcel work', count, work);
    } finally {
      plain.remove(serial.describe().id);
      shared.remove(parallel.describe().id);
    }
  }
});

test('airborne threads reject plain world memory with a coded remedy', async () => {
  using solver = await AirborneParticles.load({ threads: 2 });
  assert.throws(() => new PhysicsWorld({ memory: worldMemory(false) }).add(solver, { capacity: 1 }), {
    name: 'MargoError',
    code: 'unsupported',
    message: /worldMemory\(true\)|shared.*threads: 1/i,
  });
});
