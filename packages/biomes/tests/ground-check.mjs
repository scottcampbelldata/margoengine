// Real-GPU proof (run from the repository root after building packages):
//   node packages/biomes/tests/ground-check.mjs        (and with --compat for the WebGL2 layer)
// What BiomeView does at the ground without being asked: stored trunks and stones press their footprints into the
// ground contact, the grass opens around them (and follows the live look), and the ridge east of the frame casts its
// shadow over it through the relief lighting. `contact: false`, `relief: false` and `groundCover: false` leave each out.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/ground-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? 'WebGL2 layer' : 'WebGPU');
    await page.waitForFunction(() => window.ready, null, { timeout: 90000 });
    const r = await page.evaluate(() => window.check.run());
    console.log(JSON.stringify(r));
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.ok(r.wired.objects > 100, `objects stored: ${r.wired.objects}`);
    assert.ok(r.wired.contact > 100, `footprints pressed: ${r.wired.contact}`);
    assert.ok(r.wired.mask && r.wired.relief, 'the mask and the relief lighting are attached');
    assert.deepEqual(r.wired.cover, { thin: 1.4, shorten: 0.6, reach: 0.25 });
    assert.ok(r.steady < 0.002, `a still scene draws steadily: ${r.steady}`);
    assert.ok(r.opened > 0.02, `clearing hard changes the grass around the feet: ${r.opened}`);
    assert.ok(r.partly > 0.003 && r.partly < r.opened, `the default opens some of it: ${r.partly}`);
    assert.ok(r.back < 0.002, `the default look draws as before: ${r.back}`);
    // The whole frame lies in the shadow (the 60 m ridge reaches 224 m at 15 degrees), where the ground shows.
    assert.ok(r.shadow.share > 0.1, `the ridge's shadow reaches the ground in view: ${r.shadow.share}`);
    assert.ok(r.shadow.ratio > 1.15, `without the relief that ground is brighter: ${r.shadow.ratio}`);
    assert.deepEqual([r.left.contact, r.left.cover, r.left.relief], [null, null, null]);
    assert.ok(r.left.objects > 100);
    assert.deepEqual([r.only.contact, r.only.cover], [true, null]);
    assert.deepEqual(pageErrors, []);
    console.log('ok biome view ground');
  },
  () => context.close(),
);
watchExit();
