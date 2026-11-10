import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/packages/scatter/test/textured.html', port: 'free' }),
  errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
browser.page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await runSuite(
  async () => {
    const page = browser.page;
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    for (const samples of [1, 4]) {
      const images = [];
      for (const reference of [true, false]) {
        const r = await page.evaluate((o) => window.check.show(o), { surface: true, reference, samples });
        assert.deepEqual(r.errors, []);
        const png = await page.locator('canvas').screenshot();
        if (!reference) await writeFile(`test-results/batch231-surface-${samples}.png`, png);
        images.push(await decodePNG(png));
      }
      let error = 0,
        colored = 0;
      const [a, b] = images;
      for (let i = 0; i < a.data.length; i += 4) {
        for (let k = 0; k < 3; k++) error += Math.abs(a.data[i + k] - b.data[i + k]);
        if (Math.max(...b.data.subarray(i, i + 3)) - Math.min(...b.data.subarray(i, i + 3)) > 12) colored++;
      }
      assert.ok(colored > 100, `real textured plants are visible (${colored})`);
      const mean = error / (a.width * a.height * 3);
      assert.ok(mean < 0.15, `surface placements match independent root transforms (${mean})`);
      console.log('surface scatter', JSON.stringify({ samples, mean, colored }));
    }
    assert.deepEqual(errors, []);
  },
  () => browser.close(),
);
watchExit();
