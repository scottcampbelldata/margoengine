// Real-GPU check (run from the repository root after building packages):
//   node packages/terrain/test/anisotropy.browser.mjs
//   MARGO_COMPAT=1 node packages/terrain/test/anisotropy.browser.mjs   (the WebGL2 compatibility layer)
// KB-TERRAIN-GRAZESMEAR1. Seen from eye height, a pixel's footprint on the ground is many times longer than it is wide.
// The terrain's layer sampler filtered isotropically, so the GPU picked the mip level for the long side and the ground
// between a meadow's far tussocks smeared into flat blotches. The sampler now filters anisotropically (16 samples at
// most, the WebGPU limit), so the detail across the view survives. Flat ground with one grey value-noise texture
// (bump.html), seen 3.4 degrees down from 1.2 m, the horizon at row 117 of 256: the luma deviation along rows 118 to
// 129 (the ground past about 25 m) went from 2.36 to 4.35 and along rows 130 to 139 from 4.53 to 6.93 (RTX A6000); the
// bounds sit between.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/terrain/test/bump.html', port: 'free' }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
await runSuite(
  async () => {
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    assert.deepEqual(await page.evaluate(() => window.check.show('graze', {}, 'graze')), []);
    const bands = await page.evaluate(() =>
      [
        [118, 130],
        [130, 140],
      ].map(([a, b]) => window.check.rows('graze', a, b)),
    );
    assert.deepEqual(pageErrors, []);
    // A forced-compatibility run must really draw on the WebGL2 layer.
    const layer = await page.evaluate(() => globalThis.__margoCompat === true);
    assert.equal(layer, context.hardware?.compat === true, 'the page draws on the device the run asked for');
    assert.ok(bands[0] > 3.3, `far ground keeps its detail across the view: ${bands[0].toFixed(2)} (over 3.3)`);
    assert.ok(bands[1] > 5.7, `middle ground keeps its detail across the view: ${bands[1].toFixed(2)} (over 5.7)`);
    console.log(`ok terrain anisotropy${layer ? ' (WebGL2 layer)' : ''}: row detail ${bands.map((b) => b.toFixed(2)).join(', ')}`);
  },
  () => context.close(),
);
watchExit();
