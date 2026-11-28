import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const isolation = {
  name: 'lightning-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, close } = await openBrowser({
  startPath: '/packages/sky/test/lightning-bolt-check.html?samples=1',
  port: 'free',
  plugins: [isolation],
});
const assets = new Set();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('response', (response) => {
  const { pathname } = new URL(response.url());
  if (pathname.includes('lightning-kernel') && response.ok()) assets.add(pathname.split('/').at(-1));
});
try {
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20_000 });
  assert.deepEqual([...assets], []);
  const result = await page.evaluate(() => window.check.runPhysical());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  assert.equal(result.validation, null);
  assert.deepEqual(result.shared, result.plain);
  assert.deepEqual(result.replay, result.shared);
  assert.deepEqual([...assets].sort(), ['lightning-kernel-shared.wasm', 'lightning-kernel.wasm']);
  assert.equal(result.compat, process.argv.includes('--compat') || process.env.MARGO_COMPAT === '1');
  assert.equal(result.plain.groundY, 0);
  assert.deepEqual(result.plain.offset, [0, 0, -4096]);
  assert.ok(result.plain.trunk > 0 && result.plain.count > result.plain.trunk);
  assert.ok(result.plain.flash.time > result.launch);
  assert.ok(
    result.plain.flash.time > (result.strokeFrame - 1) / 60 && result.plain.flash.time <= result.strokeFrame / 60,
  );
  assert.equal(result.levels.before, 0);
  assert.ok(result.levels.leader > 0 && result.levels.stroke > result.levels.leader, JSON.stringify(result.levels));
  assert.equal(result.dark.bright, 0);
  assert.ok(result.leader.max > result.dark.max && result.lit.max > result.leader.max);
  assert.ok(result.lit.bright > 0 && result.lit.rows > 20, JSON.stringify(result.lit));
  assert.equal(result.faded.bright, 0);
  assert.deepEqual(
    { bright: result.replayLit.bright, rows: result.replayLit.rows },
    {
      bright: result.lit.bright,
      rows: result.lit.rows,
    },
  );
  console.log(
    `ATMO-07 ${result.compat ? 'WebGL2' : 'WebGPU'} registered channel ${result.plain.hash}: ${result.lit.bright} bright pixels over ${result.lit.rows} rows at frame ${result.strokeFrame}.`,
  );

  const threads = await page.evaluate(async () => {
    const worker = new Worker('/packages/physics/tests/fixtures/lightning-threads-worker.mjs', { type: 'module' });
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The isolated LightningSolver worker did not finish.')), 30_000);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessageerror = () => reject(new Error('The LightningSolver worker returned an unreadable receipt.'));
      });
    } finally {
      clearTimeout(timer);
      worker.terminate();
    }
  });
  assert.equal(threads.error, undefined, threads.error);
  const { serial, parallel } = threads;
  assert.equal(serial.helpers, 0);
  assert.equal(parallel.helpers, 3);
  assert.equal(parallel.hash, serial.hash);
  assert.ok(threads.equalSnapshots && serial.replayed && parallel.replayed);
  assert.ok(parallel.channelCount > 0 && parallel.channelCount === serial.channelCount);
  assert.ok(parallel.work.sweeps > 0 && parallel.work.sweeps === serial.work.sweeps);
  assert.equal(parallel.work.simdPairs, serial.work.simdPairs);
  assert.equal(parallel.work.haloCopies, serial.work.haloCopies);
  // 77 rows by five SIMD pairs, with the 20-row share assigned to the last part.
  assert.deepEqual(
    parallel.work.threadSimdPairs,
    [95, 95, 95, 100].map((n) => n * parallel.work.sweeps),
  );
  assert.equal(parallel.work.simdPairs, 385 * parallel.work.sweeps);
  assert.deepEqual(errors, []);
  console.log(
    `ATMO-07 isolated browser worker ${parallel.hash}: ${parallel.work.simdPairs} SIMD stencil pairs on four threads.`,
  );
} finally {
  await close();
}
