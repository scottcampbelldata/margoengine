// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/scatter/test/edges.browser.mjs
// Thin blades shaded from 0 at the root to 1 at the tip (unlit and lit `Scatter` blades, and `ScatterInstances` vertex
// colour and occlusion), drawn with 4x multisampling into the linear HDR scene, write no negative radiance. Before the
// shade, colour, occlusion and ground-weight varyings were centroid-interpolated, a pixel a blade only partly covered
// was shaded at its centre outside the blade, the shade extrapolated below 0, and biome grass drew negative pixels.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/scatter/test/edges.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.check.run());
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    for (const kind of ['unlit', 'lit', 'instances']) {
      assert.ok(r[kind].drawn > 0.05, `${kind}: the blades cover the frame (${r[kind].drawn})`);
      assert.equal(r[kind].bad, 0, `${kind}: pixels with negative or non-finite radiance`);
    }
    console.log('ok scatter edges', JSON.stringify(r));
  },
  () => context.close(),
);
watchExit();
