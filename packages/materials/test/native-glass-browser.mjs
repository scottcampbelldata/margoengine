import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
const browser = await openBrowser({ startPath: '/packages/materials/test/native-glass.html', port: 'free' });
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await runSuite(
  async () => {
    await browser.page.waitForFunction(() => window.nativeGlass, null, { timeout: 30000 });
    const rows = await browser.page.evaluate(() => window.nativeGlass());
    const decode = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    const encode = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
    for (const row of rows) {
      const picture = await decodePNG(Buffer.from(row.png.split(',')[1], 'base64'));
      const offset = (Math.floor(picture.height / 2) * picture.width + Math.floor(picture.width / 2)) * 4;
      const actual = Array.from(picture.data.slice(offset, offset + 3));
      const lit = await decodePNG(Buffer.from(row.lit.split(',')[1], 'base64'));
      const light = Array.from(lit.data.slice(offset, offset + 3));
      const expected = light.map((x) => Math.round(255 * encode(decode(128 / 255) + decode(x / 255))));
      console.log({ samples: row.samples, layers: row.layers, taa: row.taa, actual, expected });
      assert.ok(
        actual.every((x, k) => Math.abs(x - expected[k]) <= 1),
        'native glass must add light in linear values',
      );
    }
    // KB2281: a caller-owned pass through createRenderer composites the same way once it lends a snapshot hook.
    const external = await browser.page.evaluate(() => window.externalGlass());
    const lit = external.find((r) => r.grey === 0).texel;
    const linear = lit.map((x) => Math.round(255 * encode(decode(128 / 255) + decode(x / 255))));
    const withHook = external.find((r) => r.grey === 128 && r.hook).texel,
      without = external.find((r) => r.grey === 128 && !r.hook).texel;
    console.log({ external: true, withHook, without, expected: linear });
    assert.ok(
      withHook.every((x, k) => Math.abs(x - linear[k]) <= 1),
      'external native glass with a snapshot hook must add light in linear values',
    );
    assert.ok(
      without.some((x, k) => x - linear[k] > 1),
      'without the hook the encoded tint/add blend stays brighter (the documented default)',
    );
    assert.deepEqual(errors, []);
  },
  () => browser.close(),
);
