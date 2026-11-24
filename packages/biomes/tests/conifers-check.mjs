// Real-GPU proof of scenes plan M8 (run from the repository root after building packages, through
// scripts/run-with-timeout.mjs; MARGO_COMPAT=1 for the WebGL2 compatibility layer):
//   node packages/biomes/tests/conifers-check.mjs
// The rockies world draws its conifer species: trees change the near view and the far view (imposters past 400 m),
// sway with the wind, and nothing raises a validation error.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const context = await openBrowser({ startPath: '/packages/biomes/tests/conifers-check.html', port: 'free' }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
await runSuite(
  async () => {
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.ok(r.objects > 1000, `objects streamed: ${r.objects}`);
    assert.ok(r.changed[0] > 0.1, `near view: share of pixels the conifers change ${r.changed[0]}`);
    assert.ok(r.changed[1] > 0.02, `far view (imposters): share of pixels the conifers change ${r.changed[1]}`);
    assert.ok(r.wind > 0.002, `pixels the wind moves in 3 s: ${r.wind}`);
    console.log('ok conifers:', r.objects, 'objects, changed', r.changed.map((c) => c.toFixed(3)).join(' / '), 'wind', r.wind.toFixed(4));
  },
  () => context.close(),
);
watchExit();
