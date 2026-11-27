import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
const page = '/packages/scatter/test/attributes.html',
  b = await openBrowser({ startPath: page, openPath: '/tools/shot/blank.html', port: 'free' }),
  errors = [];
// The race of KB-SCATTER-ATTRCOMPAT1 on demand. The shadows compatibility route (fetched on the WebGL2 layer only) is
// held until the first reference frame has been shown, as a loaded machine fetched it late: a page that draws before
// Shadows.ready shows that reference without the route and its pair with it, so the pair differs every time. A page
// that awaits ready cannot show the reference before the route, so the hold ends after 10 s.
let release;
const released = new Promise((done) => (release = done));
await b.page.route('**/packages/shadows/dist/compat-*.js', async (route) => {
  await Promise.race([released, new Promise((done) => setTimeout(done, 10000))]);
  await route.continue();
});
await b.page.goto(new URL(page, b.page.url()).href);
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
            if (reference) release();
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
