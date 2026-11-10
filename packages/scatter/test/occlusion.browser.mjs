import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
const b = await openBrowser({ startPath: '/packages/scatter/test/occlusion.html', port: 'free' }),
  errors = [];
b.page.on('pageerror', (e) => errors.push(e.message));
b.page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await runSuite(
  async () => {
    await b.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    for (const samples of [1, 4])
      for (const step of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
        const images = [],
          results = [];
        for (const enabled of [false, true]) {
          const r = await b.page.evaluate((o) => window.check.show(o), { enabled, samples, step });
          assert.deepEqual(r.errors, []);
          results.push(r);
          images.push((await decodePNG(await b.page.locator('canvas').screenshot())).data);
        }
        assert.deepEqual(images[1], images[0], `same colour and shadows samples=${samples} step=${step}`);
        assert.equal(results[0].shadows, results[1].shadows);
        if ([0, 4, 5, 6, 7].includes(step)) assert.ok(results[1].colour < results[1].shadows, JSON.stringify(results));
        if (step === 1) assert.equal(results[1].colour, results[1].shadows);
        console.log('scatter Hi-Z', samples, step, JSON.stringify(results));
      }
    assert.deepEqual(errors, []);
  },
  () => b.close(),
);
watchExit();
