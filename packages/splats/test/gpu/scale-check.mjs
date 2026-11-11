// Real-GPU scale check for splats: a cloud at the per-cloud limit (3,000,000, no SH; 360 MB of storage in one bind
// group, refused by the WebGL2 layer before 2026-11-11), one at the degree-3 SH bound of a default device (699,050:
// 16 coefficients x 12 B in one 128 MiB storage binding) and the published truck at iteration 7,000 (1,692,538 of
// degree 3, 325 MB of SH, which needs the adapter's binding size: drawn natively, refused at attach on the WebGL2
// layer) draw with no WebGPU validation error and cover the frame. Wall time per frame is printed for the speed phase
// (diagnostic only).
// Takes a GPU slot itself. From the repository root after building packages, natively and with MARGO_COMPAT=1:
//   node packages/splats/test/gpu/scale-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'splats-scale' });
try {
  const context = await openBrowser({ startPath: '/packages/splats/test/gpu/scale.html', port: 'free' }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    for (const [label, count, sh] of [
      ['3,000,000 splats, no SH', 3_000_000, 0],
      ['699,050 splats, SH degree 3', 699_050, 16],
      ['1,692,538 splats, SH degree 3', 1_692_538, 16],
    ]) {
      if (compat && count * sh * 12 > 134_217_728) {
        // The WebGL2 layer holds one storage binding to 128 MiB (docs/limits.md), so the truck's 325 MB of SH is
        // refused at attach with the documented error rather than failing inside the layer.
        const refused = await page.evaluate(([n, k]) => window.check.run(n, k).then(() => '', (e) => `${e.name}: ${e.message}`), [count, sh]);
        console.log(`${label} (compat): refused at attach as documented`);
        assert.equal(refused, 'RangeError: Splat attributes exceed device storage limits; use fewer splats.', label);
        assert.deepEqual(await page.evaluate(() => window.check.errors), [], label);
        continue;
      }
      const r = await page.evaluate(([n, k]) => window.check.run(n, k), [count, sh]);
      const shot = await decodePNG(await page.locator('#a').screenshot());
      let lit = 0;
      for (let k = 0; k < shot.data.length; k += 4) if (shot.data[k] + shot.data[k + 1] + shot.data[k + 2] > 90) lit++;
      const share = lit / (shot.data.length / 4);
      console.log(`${label}${compat ? ' (compat)' : ''}: wall ${r.wallMs.toFixed(1)} ms (diagnostic), covers ${(share * 100).toFixed(1)}%`);
      assert.equal(r.count, count);
      assert.ok(share > 0.15, `${label}: the cloud is drawn (${share})`);
      assert.deepEqual(await page.evaluate(() => window.check.errors), [], label);
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('splats scale check passed');
} finally {
  await release();
}
