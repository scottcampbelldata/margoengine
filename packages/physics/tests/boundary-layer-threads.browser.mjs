import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'boundary-layer-thread-isolation',
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
    const { BoundaryLayerSolver } = await import('/packages/physics/dist/boundary-layer.js');
    const windowError = await BoundaryLayerSolver.load({ threads: 4 }).then(
      (wind) => {
        wind[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/boundary-layer-threads-worker.mjs', { type: 'module' });
    let timeout;
    try {
      const result = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Boundary-layer worker receipt timed out.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (error) => reject(new Error(error.message));
        worker.onmessageerror = () => reject(new Error('Boundary-layer worker receipt could not be read.'));
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
  const { baseline, reports, expectedWork } = outcome;
  assert.deepEqual(
    reports.map(({ shared, threads, helpers }) => [shared, threads, helpers]),
    [
      [true, 1, 0],
      [true, 2, 1],
      [true, 4, 3],
    ],
  );
  for (const report of [baseline, ...reports]) {
    assert.ok(report.exactInitial && report.exactScalar && report.exactQuery && report.exactQueryState);
    assert.ok(report.exactShift && report.exactReplay);
    assert.ok(report.gustChanges && report.topAndGroundStill && report.activeUpward);
    assert.equal(report.hash, baseline.hash);
    assert.deepEqual(report.initialCell, [932_051_020, -1_254_557_030, 61_771_006]);
    assert.deepEqual(report.shiftedCell, [0, 0, 0]);
    assert.deepEqual(report.restoredCell, report.initialCell);
  }
  for (const [i, report] of reports.entries()) {
    assert.ok(report.exactStart && report.exactCheckpoint && report.exactFinal);
    assert.deepEqual(report.work, expectedWork[i]);
    assert.deepEqual(report.replayWork, report.work);
  }
  console.log('ATMO-01 isolated Chromium workers', reports.at(-1).hash, reports.at(-1).work);
} finally {
  await close();
}
