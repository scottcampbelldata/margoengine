import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'tsunami-thread-isolation',
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
  const result = await page.evaluate(async () => {
    const { TsunamiSolver } = await import('/packages/physics/dist/tsunami.js');
    const windowError = await TsunamiSolver.load({ threads: 4 }).then(
      (solver) => {
        solver[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const run = new Worker('/packages/physics/tests/fixtures/tsunami-threads-worker.mjs', { type: 'module' });
    let timer;
    try {
      const receipt = await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('The isolated SEA-06 worker did not finish within 30 seconds.')),
          30_000,
        );
        run.onmessage = ({ data }) => resolve(data);
        run.onerror = (event) => reject(new Error(event.message));
        run.onmessageerror = () => reject(new Error('The SEA-06 worker returned an unreadable receipt.'));
      });
      return { isolated: crossOriginIsolated, windowError, ...receipt };
    } finally {
      clearTimeout(timer);
      run.terminate();
    }
  });

  assert.equal(result.isolated, true);
  assert.equal(result.windowError?.name, 'MargoError');
  assert.equal(result.windowError?.code, 'unsupported');
  assert.match(result.windowError.message, /worker.*threads: 1/i);
  assert.equal(result.error, undefined, result.error);
  const { serial, threaded } = result;
  assert.equal(serial.nestedWorkers, 0);
  assert.equal(threaded.nestedWorkers, 3);
  assert.equal(serial.wetLandBefore, 0);
  assert.ok(threaded.wetLandAfter > 0 && threaded.dryCellsAfter > 0);
  assert.equal(threaded.hash, serial.hash);
  assert.ok(result.equalSnapshots, 'the accepted serial and threaded snapshots differ');
  assert.ok(serial.replayedSnapshot && threaded.replayedSnapshot);
  assert.equal(threaded.substeps, serial.substeps);
  assert.equal(threaded.faceFluxes, serial.faceFluxes);
  // 17 by 11 cells split into four floor-partitioned sets of rows and
  // columns, with two HLL sweeps in each of two Runge-Kutta stages.
  assert.deepEqual(
    threaded.threadFaceFluxes,
    [168, 204, 204, 228].map((n) => n * threaded.substeps),
  );
  assert.ok(threaded.substeps > 0);

  console.log(
    `Isolated browser SEA-06 threaded snapshot ${threaded.hash}; ${threaded.faceFluxes} face solves on 4 threads.`,
  );
} finally {
  await close();
}
