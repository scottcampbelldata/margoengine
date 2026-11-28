import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'lava-thread-isolation',
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
  const output = await page.evaluate(async () => {
    const { LavaSolver } = await import('/packages/physics/dist/lava.js');
    const windowError = await LavaSolver.load({ threads: 4 }).then(
      (lava) => {
        lava[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/lava-threads-worker.mjs', { type: 'module' });
    let timer;
    try {
      const receipt = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The isolated EARTH-10 worker did not finish.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error('The EARTH-10 worker returned an unreadable receipt.'));
      });
      return { isolated: crossOriginIsolated, windowError, ...receipt };
    } finally {
      clearTimeout(timer);
      worker.terminate();
    }
  });
  assert.equal(output.isolated, true);
  assert.equal(output.windowError?.name, 'MargoError');
  assert.equal(output.windowError?.code, 'unsupported');
  assert.match(output.windowError.message, /worker.*threads: 1/i);
  assert.equal(output.error, undefined, output.error);

  for (const { transport, serial, parallel, equalSnapshots } of output.results) {
    assert.equal(serial.helpers, 0);
    assert.equal(parallel.helpers, 3);
    assert.equal(parallel.hash, serial.hash);
    assert.ok(equalSnapshots && serial.replayed && parallel.replayed);
    assert.ok(serial.marine > 0);
    assert.equal(parallel.marine, serial.marine);
    const { microsteps, boundCells, transportFaces, localCells, workers } = parallel.work;
    assert.ok(microsteps > 0 && microsteps === serial.work.microsteps);
    assert.equal(boundCells, 117 * microsteps);
    assert.equal(localCells, 117 * microsteps);
    assert.equal(transportFaces, (transport === 'terminal' ? 212 : 256) * microsteps);
    assert.equal(transportFaces, serial.work.transportFaces);
    assert.equal(workers.length, 4);
    for (const key of ['boundCells', 'transportFaces', 'localCells']) {
      assert.ok(workers.every((part) => part[key] > 0));
      assert.equal(
        workers.reduce((total, part) => total + part[key], 0),
        parallel.work[key],
      );
    }
    console.log(
      `EARTH-10 isolated ${transport} worker ${parallel.hash}: ${transportFaces} transport faces on four threads.`,
    );
  }
} finally {
  await close();
}
