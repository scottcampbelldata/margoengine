import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { outletVolume } from './fixtures/viscoplastic-threads-flume.mjs';

const isolation = {
  name: 'viscoplastic-thread-isolation',
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
    const { ViscoplasticSolver } = await import('/packages/physics/dist/viscoplastic.js');
    const windowError = await ViscoplasticSolver.load({ threads: 4 }).then(
      (mud) => {
        mud[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );
    const worker = new Worker('/packages/physics/tests/fixtures/viscoplastic-threads-worker.mjs', { type: 'module' });
    let timer;
    try {
      const receipt = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The isolated FLUID-06 worker did not finish.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error('The FLUID-06 worker returned an unreadable receipt.'));
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
  assert.deepEqual(
    result.results.map(({ solvent }) => solvent),
    [0, 3],
  );
  for (const { solvent, serial, parallel, equalSnapshots } of result.results) {
    assert.equal(serial.helpers, 0);
    assert.equal(parallel.helpers, 3);
    assert.equal(parallel.hash, serial.hash);
    assert.ok(equalSnapshots && serial.replayed && parallel.replayed);
    assert.deepEqual(parallel.budget, serial.budget);
    assert.equal(parallel.budget.escapedReferenceVolume, outletVolume);
    assert.deepEqual(parallel.work, parallel.replayWork);
    const { threads, substeps, particleToGridPoints, gridToParticlePoints, occupiedNodeRows, workers } = parallel.work;
    assert.equal(threads, 4);
    assert.equal(workers.length, threads);
    assert.equal(substeps, parallel.budget.substeps);
    assert.equal(substeps, serial.work.substeps);
    assert.equal(substeps, 2);
    assert.equal(particleToGridPoints, parallel.budget.activePoints * substeps);
    assert.equal(gridToParticlePoints, particleToGridPoints);
    assert.equal(gridToParticlePoints, serial.work.gridToParticlePoints);
    assert.equal(occupiedNodeRows, serial.work.occupiedNodeRows);
    assert.ok(occupiedNodeRows > parallel.budget.occupiedNodes);
    for (const key of ['gridToParticlePoints', 'occupiedNodeRows']) {
      assert.ok(workers.every((part) => part[key] > 0));
      assert.equal(
        workers.reduce((sum, part) => sum + part[key], 0),
        parallel.work[key],
      );
    }
    console.log(
      'FLUID-06 isolated solvent',
      solvent,
      'Pa s:',
      parallel.hash,
      'with',
      occupiedNodeRows,
      'grid rows and',
      parallel.helpers,
      'helpers.',
    );
  }
} finally {
  await close();
}
