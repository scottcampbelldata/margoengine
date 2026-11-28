import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'sediment-thread-isolation',
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

function proposedWork(threads, cells, faces) {
  const perPart = (total, part) => Math.floor(((part + 1) * total) / threads) - Math.floor((part * total) / threads);
  return {
    threads,
    cellProposals: cells,
    faceProposals: faces,
    workers: Array.from({ length: threads }, (_, part) => ({
      cellProposals: perPart(cells, part),
      faceProposals: perPart(faces, part),
    })),
  };
}

try {
  const result = await page.evaluate(async () => {
    const { SedimentTransport } = await import('/packages/physics/dist/sediment.js');
    const windowError = await SedimentTransport.load({ threads: 4 }).then(
      (sediment) => {
        sediment[Symbol.dispose]();
        return null;
      },
      (error) => ({ name: error.name, code: error.code, message: error.message }),
    );

    const worker = new Worker('/packages/physics/tests/fixtures/sediment-threads-worker.mjs', { type: 'module' });
    let timer;
    try {
      const receipt = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The isolated sediment worker did not finish.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error('The sediment worker returned an unreadable receipt.'));
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
  const { far, columns, cells, faces, receipts } = result;
  assert.deepEqual(
    receipts.map(({ shared, threads }) => [shared, threads]),
    [
      [false, 1],
      [true, 1],
      [true, 2],
      [true, 4],
    ],
  );
  const [baseline] = receipts;
  for (const run of receipts) {
    assert.equal(run.helpers, run.threads - 1);
    assert.equal(run.hash, baseline.hash);
    assert.equal(run.exactReplay, true);
    if (run.shared) assert.ok(run.exactStart && run.exactCheckpoint && run.exactFinal);
    assert.deepEqual(run.initialCell, far);
    assert.deepEqual(run.shiftedCell, [0, 0, 0]);
    assert.deepEqual(run.restoredCell, far);
    assert.deepEqual(run.fields, baseline.fields);
    assert.deepEqual(run.budget, baseline.budget);
    assert.deepEqual(run.coldWork, proposedWork(run.threads, 0, 0));
    assert.deepEqual(run.work, proposedWork(run.threads, cells, faces));
    assert.deepEqual(run.replayWork, run.work);
  }

  assert.equal(baseline.bedMoved, true);
  assert.ok(baseline.budget.bankTransfer > 0 && baseline.budget.bedloadOut > 0 && baseline.budget.suspendedOut > 0);
  for (const field of baseline.fields) {
    assert.ok(field.every(Number.isFinite));
    assert.ok(field.slice(0, columns).every((value) => value === 0));
    assert.ok(field.slice(-columns).every((value) => value === 0));
    assert.ok(field.slice(columns, -columns).some((value) => value > 0));
  }
  const parallel = receipts.at(-1);
  console.log('HYDRO-03 Chromium', parallel.hash, parallel.work, 'with', parallel.helpers, 'helpers.');
} finally {
  await close();
}
