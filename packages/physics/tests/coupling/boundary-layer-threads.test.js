import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundaryLayerSolver } from '../../dist/boundary-layer.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { BoundaryLayerWind } from '../../../weather/dist/boundary-layer.js';
import {
  expectedWindWork,
  far,
  grid,
  publishedWind,
  runWind,
  scalarWind,
} from '../fixtures/boundary-layer-threads-worker.mjs';

test('boundary-layer workers preserve Weather and native wind through the finite gust layer and a far-origin replay', async () => {
  for (const length of [Infinity, 24, -14]) {
    const scalar = scalarWind(length);
    const baseline = await runWind(false, 1, scalar);
    for (const [shared, threads] of [
      [false, 1],
      [true, 1],
      [true, 2],
      [true, 4],
    ]) {
      const run = shared ? await runWind(shared, threads, scalar) : baseline;
      const report = run.report;
      assert.deepEqual(run.start, baseline.start);
      assert.deepEqual(run.checkpoint, baseline.checkpoint);
      assert.deepEqual(run.final, baseline.final);
      assert.deepEqual(report.initialCell, far);
      assert.deepEqual(report.shiftedCell, [0, 0, 0]);
      assert.deepEqual(report.restoredCell, far);
      assert.equal(report.time, 17 * (1 / 60));
      assert.deepEqual(report.coldWork, expectedWindWork(grid, scalar.profile, threads, false));
      assert.deepEqual(report.work, expectedWindWork(grid, scalar.profile, threads));
      assert.deepEqual(report.replayWork, report.work);
      assert.ok(report.exactInitial && report.exactScalar && report.exactReplay && report.exactShift);
      assert.ok(report.exactQuery && report.exactQueryState);
      assert.ok(report.gustChanges && report.topAndGroundStill && report.activeUpward);
    }
  }
});

test('boundary-layer SIMD workers split two odd gust grids with deterministic measured work', async () => {
  const scalar = scalarWind(-14);
  for (const cells of [
    [129, 9, 23],
    [257, 9, 31],
  ]) {
    using serial = await BoundaryLayerSolver.load();
    using parallel = await BoundaryLayerSolver.load({ threads: 4 });
    const larger = { ...grid, cells };
    const plain = new PhysicsWorld({ memory: worldMemory(false), rate: { num: 60, den: 1 } });
    const shared = new PhysicsWorld({ memory: worldMemory(true), rate: { num: 60, den: 1 } });
    plain.add(serial, { grid: larger, profile: scalar.profile }, far);
    shared.add(parallel, { grid: larger, profile: scalar.profile }, far);
    try {
      plain.advance(1);
      shared.advance(1);
      const work = parallel.workCounts();
      assert.deepEqual(serial.workCounts(), expectedWindWork(larger, scalar.profile, 1));
      assert.deepEqual(work, expectedWindWork(larger, scalar.profile, 4));
      assert.ok(work.workers.every(({ pairedRows, turbulentRows }) => pairedRows > 0 && turbulentRows > 0));
      assert.deepEqual(publishedWind(shared, parallel), publishedWind(plain, serial));
      assert.deepEqual(shared.takeSnapshot().bytes, plain.takeSnapshot().bytes);
      console.log('ATMO-01 accepted grid and worker counts', cells, work);
    } finally {
      plain.remove(serial.describe().id);
      shared.remove(parallel.describe().id);
    }
  }
});

test('boundary-layer native calm accepts the same extreme finite height as Weather', async () => {
  const scalar = new BoundaryLayerWind({ speed: 0, obukhovLength: 1, turbulence: false });
  const expected = scalar.sample(0, Number.MAX_VALUE, 0, -1);
  assert.deepEqual(expected.velocity, [0, 0, 0]);
  assert.equal(expected.density, 0);
  for (const shared of [false, true]) {
    using wind = await BoundaryLayerSolver.load({ threads: shared ? 2 : 1 });
    const world = new PhysicsWorld({ memory: worldMemory(shared) });
    const extreme = { cells: [1, 1, 1], origin: [0, Number.MAX_VALUE, 0], spacing: [1, 1, 1] };
    world.add(wind, { grid: extreme, profile: scalar.profile });
    try {
      world.advance(1);
      assert.deepEqual(wind.sample(0, Number.MAX_VALUE, 0, -1), expected);
      assert.deepEqual(publishedWind(world, wind).values, new Float64Array([0, 0, 0, 0, expected.temperature]));
      assert.deepEqual(wind.workCounts(), expectedWindWork(extreme, scalar.profile, shared ? 2 : 1));
    } finally {
      world.remove(wind.describe().id);
    }
  }
});
