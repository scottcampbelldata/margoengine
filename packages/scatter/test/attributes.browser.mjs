import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
const b = await openBrowser({ startPath: '/packages/scatter/test/attributes.html', port: 'free' }),
  errors = [];
b.page.on('pageerror', (e) => errors.push(e.message));
b.page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await runSuite(
  async () => {
    await b.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    for (const samples of [1, 4])
      for (const [custom, multi] of [
        [false, false],
        [true, false],
        [true, true],
      ])
        for (const [edited, restore] of [
          [false, false],
          [true, false],
          [true, true],
        ]) {
          const images = [];
          for (const reference of [true, false]) {
            const r = await b.page.evaluate((o) => window.check.show(o), {
              reference,
              samples,
              edited,
              restore,
              custom,
            });
            assert.deepEqual(r.errors, []);
            images.push((await decodePNG(await b.page.locator('canvas').screenshot())).data);
          }
          assert.deepEqual(
            images[0],
            images[1],
            `colour/custom geometry/shadows samples=${samples} custom=${custom} edited=${edited} restore=${restore}`,
          );
          console.log('instance attributes', samples, custom, edited, restore);
        }
    assert.deepEqual(errors, []);
  },
  () => b.close(),
);
watchExit();
