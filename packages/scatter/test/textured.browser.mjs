import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/packages/scatter/test/textured.html', port: 'free' });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
browser.page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const difference = (a, b) => {
  let sum = 0,
    changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs(a.data[i + k] - b.data[i + k]);
    sum += d;
    if (d > 6) changed++;
  }
  return { mean: sum / (a.width * a.height * 3), changed };
};
await runSuite(
  async () => {
    const { page } = browser;
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const draw = async (options) => {
      const info = await page.evaluate((o) => window.check.show(o), options);
      assert.deepEqual(info.errors, []);
      assert.ok(info.masks > 0 && info.normals > 0, 'real plant carries MASK and normal maps');
      if (!options.reference)
        assert.ok(
          info.instances.every((n) => n === 2),
          'all plant nodes draw twice',
        );
      return decodePNG(await page.locator('canvas').screenshot());
    };
    for (const samples of [1, 4]) {
      const reference = await draw({ reference: true, samples }),
        scattered = await draw({ samples });
      const equivalent = difference(reference, scattered);
      assert.ok(equivalent.mean < 0.15, `whole glTF copies match independent models: ${JSON.stringify(equivalent)}`);
      const solid = await draw({ samples, mask: false }),
        flat = await draw({ samples, normal: false }),
        uncast = await draw({ samples, cast: false });
      assert.ok(difference(scattered, solid).changed > 100, 'alpha texture cuts leaf cards and their shadows');
      assert.ok(difference(scattered, flat).changed > 100, 'normal maps change plant shading');
      assert.ok(difference(scattered, uncast).changed > 100, 'textured instances cast shadows');
      console.log(
        'textured scatter',
        JSON.stringify({
          samples,
          equivalent,
          mask: difference(scattered, solid),
          normal: difference(scattered, flat),
          shadow: difference(scattered, uncast),
        }),
      );
    }
    const before = await draw({}),
      restored = await draw({ restore: true });
    assert.ok(difference(before, restored).mean < 0.15, 'device restoration retains textured copies');
    assert.deepEqual(errors, []);
  },
  () => browser.close(),
);
watchExit();
