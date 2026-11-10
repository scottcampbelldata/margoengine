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
      console.log({ samples: row.samples, layers: row.layers, actual, expected });
      assert.ok(
        actual.every((x, k) => Math.abs(x - expected[k]) <= 1),
        'native glass must add light in linear values',
      );
    }
    assert.deepEqual(errors, []);
  },
  () => browser.close(),
);
