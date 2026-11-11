// Real-GPU scale check for points: a cloud at the most positions a default device binds (11,184,810, byte colours)
// and one at the float-colour bound (8,388,608), with the default pointBudget of 1,000,000 and with every point drawn,
// render with no WebGPU validation error and cover the frame. Wall time per frame is printed for the speed phase
// (diagnostic only). Takes a GPU slot itself. From the repository root after building packages, natively and with
// MARGO_COMPAT=1:
//   node packages/points/tests/scale-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'points-scale' });
try {
  const context = await openBrowser({ startPath: '/packages/points/tests/scale.html', port: 'free' }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    for (const [label, count, float, budget] of [
      ['11,184,810 points, byte colours, budget 1,000,000', 11_184_810, false, 1_000_000],
      ['11,184,810 points, byte colours, all drawn', 11_184_810, false, 11_184_810],
      ['8,388,608 points, float colours, all drawn', 8_388_608, true, 8_388_608],
    ]) {
      const r = await page.evaluate(([n, f, b]) => window.check.run(n, f, b), [count, float, budget]);
      const shot = await decodePNG(await page.locator('#a').screenshot());
      let lit = 0;
      for (let k = 0; k < shot.data.length; k += 4) if (shot.data[k] + shot.data[k + 1] + shot.data[k + 2] > 90) lit++;
      const share = lit / (shot.data.length / 4);
      console.log(`${label}${compat ? ' (compat)' : ''}: ${r.drawn ?? '?'} drawn, wall ${r.wallMs.toFixed(1)} ms (diagnostic), covers ${(share * 100).toFixed(1)}%`);
      assert.equal(r.count, count);
      assert.ok(share > 0.15, `${label}: the cloud is drawn (${share})`);
      assert.deepEqual(await page.evaluate(() => window.check.errors), [], label);
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('points scale check passed');
} finally {
  await release();
}
