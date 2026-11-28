import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { expectedSwimWork } from './fixtures/swim-threads-worker.mjs';

const isolation = {
  name: 'swimmer-thread-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/tools/shot/blank.html',
  port: 'free',
  plugins: [isolation],
  softwareAdapterOk: true,
});

try {
  const outcome = await page.evaluate(async () => {
    const { SwimSolver } = await import('/packages/physics/dist/life.js');
    const windowError = await SwimSolver.load({ threads: 4 }).then(
      (solver) => {
        solver[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/swim-threads-worker.mjs', { type: 'module' });
    let timeout;
    try {
      const result = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Swimmer worker receipt timed out.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (error) => reject(new Error(error.message));
        worker.onmessageerror = () => reject(new Error('Swimmer worker receipt could not be read.'));
      });
      return { isolated: crossOriginIsolated, windowError, ...result };
    } finally {
      clearTimeout(timeout);
      worker.terminate();
    }
  });
  assert.equal(outcome.isolated, true);
  assert.equal(outcome.windowError?.name, 'MargoError');
  assert.equal(outcome.windowError?.code, 'unsupported');
  assert.match(outcome.windowError.message, /worker.*threads: 1/i);
  assert.equal(outcome.error, undefined, outcome.error);
  const { suites, far } = outcome;
  assert.deepEqual(suites.map(({ baseline }) => baseline.passive), [false, true]);
  for (const { baseline, reports } of suites) {
    assert.deepEqual(
      reports.map(({ shared, threads, helpers }) => [shared, threads, helpers]),
      [
        [true, 1, 0],
        [true, 2, 1],
        [true, 4, 3],
      ],
    );
    for (const report of [baseline, ...reports]) {
      assert.ok(report.originShiftExact && report.hashedReplay && report.acceptedCellAgrees);
      assert.ok(report.tailAndFin && report.drag);
      assert.equal(report.hash, baseline.hash);
      assert.deepEqual(report.reading, baseline.reading);
      assert.deepEqual(report.initialCells, Array(report.passive ? 3 : 2).fill(far));
      assert.deepEqual(report.shiftedCells, Array(report.passive ? 3 : 2).fill([0, 0, 0]));
      assert.deepEqual(report.restoredCells, report.initialCells);
      assert.deepEqual(report.work, expectedSwimWork(report.bodies, report.threads, report.passive));
      assert.deepEqual(report.coldWork, expectedSwimWork(0, report.threads, report.passive));
      assert.deepEqual(report.replayWork, report.work);
    }
    for (const report of reports) assert.ok(report.exactStart && report.exactCheckpoint && report.exactFinal);
    console.log('LIFE-03 isolated Chromium swim workers', reports.at(-1).hash, reports.at(-1).work);
  }
} finally {
  await close();
}
