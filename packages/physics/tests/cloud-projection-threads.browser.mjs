import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { expectedCloudWork } from './fixtures/cloud-projection-threads-worker.mjs';

const isolation = {
  name: 'cloud-projection-thread-isolation',
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
    const { CloudSolver } = await import('/packages/physics/dist/clouds.js');
    const windowError = await CloudSolver.load({ threads: 4 }).then(
      (cloud) => {
        cloud[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/cloud-projection-threads-worker.mjs', {
      type: 'module',
    });
    let timeout;
    try {
      const result = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Cloud projection worker receipt timed out.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (error) => reject(new Error(error.message));
        worker.onmessageerror = () => reject(new Error('Cloud projection worker receipt could not be read.'));
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
  const { baseline, reports, far, grid } = outcome;
  assert.deepEqual(
    reports.map(({ shared, threads, helpers }) => [shared, threads, helpers]),
    [
      [false, 1, 0],
      [true, 1, 0],
      [true, 2, 1],
      [true, 4, 3],
    ],
  );
  assert.ok(baseline.diagnostics.divergenceBefore > 0);
  assert.ok(baseline.diagnostics.divergenceAfter < baseline.diagnostics.divergenceBefore);
  for (const report of reports) {
    assert.ok(report.originShiftExact && report.exactReplay && report.publicationAgrees);
    assert.ok(report.cloudPresent && report.fieldsChanged);
    assert.ok(report.exactStart && report.exactCheckpoint && report.exactFinal);
    assert.equal(report.hash, baseline.hash);
    assert.deepEqual(report.initialCell, far);
    assert.deepEqual(report.shiftedCell, [0, 0, 0]);
    assert.deepEqual(report.restoredCell, far);
    assert.deepEqual(report.diagnostics, baseline.diagnostics);
    assert.deepEqual(report.sample, baseline.sample);
    assert.deepEqual(report.coldWork, expectedCloudWork(grid, report.threads, 0));
    assert.ok(report.work.applications > 1);
    assert.equal(report.work.applications, report.diagnostics.iterations + 1);
    assert.deepEqual(report.work, expectedCloudWork(grid, report.threads, report.work.applications));
    assert.deepEqual(report.replayWork, report.work);
  }
  console.log('ATMO-03 isolated Chromium pressure products', reports.at(-1).hash, reports.at(-1).work);
} finally {
  await close();
}
