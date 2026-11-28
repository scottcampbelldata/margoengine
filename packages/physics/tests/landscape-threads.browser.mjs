import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { size } from './fixtures/landscape-threads-case.mjs';

const isolation = {
  name: 'landscape-thread-isolation',
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
    const { LandscapeEvolution } = await import('/packages/physics/dist/landscape.js');
    const windowError = await LandscapeEvolution.load({ threads: 4 }).then(
      (landscape) => {
        landscape[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/landscape-threads-worker.mjs', { type: 'module' });
    let timer;
    try {
      const receipt = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The isolated HYDRO-04 worker did not finish.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error('The HYDRO-04 worker returned an unreadable receipt.'));
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
  assert.ok(serial.replayed && parallel.replayed && equalSnapshots);
  assert.deepEqual(parallel.physical, serial.physical);
  assert.ok(parallel.physical.budget.exported.every((volume) => volume > 0));
  assert.deepEqual(parallel.physical.fieldCell, [0, 0, 0]);
  assert.deepEqual(parallel.work, parallel.replayWork);
  const { threads, preparedVertices, downhillLinks, routedVertices, workers } = parallel.work;
  const vertices = size[0] * size[1];
  assert.equal(threads, 4);
  assert.equal(preparedVertices, vertices);
  assert.equal(routedVertices, vertices);
  assert.equal(downhillLinks, serial.work.downhillLinks);
  assert.ok(workers.every((part) => part.downhillLinks > 0));
  assert.deepEqual(
    workers.map((part) => part.preparedVertices),
    [55, 55, 55, 56],
  );
  assert.equal(
    workers.reduce((sum, part) => sum + part.downhillLinks, 0),
    downhillLinks,
  );
  console.log(
    'HYDRO-04 Chromium',
    parallel.hash + ':',
    vertices,
    'prepared vertices and',
    downhillLinks,
    'links across',
    parallel.helpers,
    'helpers.',
  );
} finally {
  await close();
}
