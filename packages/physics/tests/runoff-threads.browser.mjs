import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { smallGrid } from './fixtures/runoff-threads-case.mjs';

const isolation = {
  name: 'runoff-thread-isolation',
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
    const { RainfallRunoff } = await import('/packages/physics/dist/runoff.js');
    const windowError = await RainfallRunoff.load({ threads: 4 }).then(
      (runoff) => {
        runoff[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/runoff-threads-worker.mjs', { type: 'module' });
    let timer;
    try {
      const receipt = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The isolated HYDRO-02 worker did not finish.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error('The HYDRO-02 worker returned an unreadable receipt.'));
      });
      return { isolated: crossOriginIsolated, windowError, ...receipt };
    } finally {
      clearTimeout(timer);
      worker.terminate();
    }
  });
  assert.equal(result.isolated, true);
  assert.equal(result.windowError?.name, 'MargoError');
  assert.equal(result.windowError?.code, 'unsupported');
  assert.match(result.windowError.message, /worker.*threads: 1/i);
  assert.equal(result.error, undefined, result.error);
  const { serial, parallel, equalSnapshots } = result;
  assert.equal(serial.helpers, 0);
  assert.equal(parallel.helpers, 3);
  assert.equal(parallel.hash, serial.hash);
  assert.ok(equalSnapshots && serial.replayed && parallel.replayed);
  assert.deepEqual(parallel.settled, serial.settled);
  assert.deepEqual(parallel.finalPort, [0, 0, 0]);
  assert.ok(
    parallel.settled.budget.rain > 0 && parallel.settled.budget.melt > 0 && parallel.settled.budget.outflow > 0,
  );
  assert.deepEqual(parallel.work, parallel.replayWork);
  const { threads, soilCells, rainMeltCells, routedCells, workers } = parallel.work;
  const count = smallGrid[0] * smallGrid[1];
  assert.equal(threads, 4);
  assert.equal(soilCells, count);
  assert.equal(rainMeltCells, count);
  assert.equal(routedCells, count);
  assert.deepEqual(
    workers,
    [22, 23, 23, 23].map((cells) => ({ soilCells: cells, rainMeltCells: cells })),
  );
  console.log(
    'HYDRO-02 isolated worker ' + parallel.hash + ':',
    count,
    'soil and forcing cells across',
    parallel.helpers,
    'helpers, exact replay.',
  );
} finally {
  await close();
}
