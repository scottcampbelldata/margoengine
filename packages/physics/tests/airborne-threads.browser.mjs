import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'airborne-thread-isolation',
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
    const { AirborneParticles } = await import('/packages/physics/dist/airborne.js');
    const windowError = await AirborneParticles.load({ threads: 4 }).then(
      (solver) => {
        solver[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/airborne-threads-worker.mjs', { type: 'module' });
    let timeout;
    try {
      const result = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Airborne worker receipt timed out.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (error) => reject(new Error(error.message));
        worker.onmessageerror = () => reject(new Error('Airborne worker receipt could not be read.'));
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
  const { baseline, reports, far } = outcome;
  assert.deepEqual(
    reports.map(({ shared, threads, helpers }) => [shared, threads, helpers]),
    [
      [true, 1, 0],
      [true, 2, 1],
      [true, 4, 3],
    ],
  );
  for (const report of [baseline, ...reports]) {
    assert.ok(report.originShiftExact && report.exactReplay && report.cellsAgree && report.particlesChanged);
    assert.equal(report.hash, baseline.hash);
    assert.deepEqual(report.budget, baseline.budget);
    assert.deepEqual(report.ordered, baseline.ordered);
    assert.deepEqual(report.initialCell, far);
    assert.deepEqual(report.shiftedCell, [0, 0, 0]);
    assert.deepEqual(report.restoredCell, far);
    assert.equal(report.coldWork.parcels, 0);
    assert.ok(report.work.parcels > 13 && report.work.evaporationUpdates > 0);
    assert.deepEqual(report.work, report.expectedWork);
    assert.deepEqual(report.replayWork, report.work);
  }
  for (const report of reports) assert.ok(report.exactStart && report.exactCheckpoint && report.exactFinal);
  console.log('ATMO-06 isolated Chromium parcel work', reports.at(-1).hash, reports.at(-1).work);
} finally {
  await close();
}
