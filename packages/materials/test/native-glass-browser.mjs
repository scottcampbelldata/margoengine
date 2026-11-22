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
    // KB3148b: blendSpace 'linear' mixes in linear light; the default keeps the display-domain blend.
    const centre = async (png) => {
      const picture = await decodePNG(Buffer.from(png.split(',')[1], 'base64'));
      const offset = (Math.floor(picture.height / 2) * picture.width + Math.floor(picture.width / 2)) * 4;
      return Array.from(picture.data.slice(offset, offset + 3));
    };
    const over = (layers, linear) => {
      // Each layer: out = a*src + (1-a)*dst, src red 0.5 linear, a 0.5, over black.
      let red = 0;
      for (let i = 0; i < layers; i++) red = linear ? 0.25 + 0.5 * red : 0.5 * encode(0.5) + 0.5 * red;
      return Math.round(255 * (linear ? encode(red) : red));
    };
    for (const row of await browser.page.evaluate(() => window.linearBlend())) {
      const actual = await centre(row.png),
        expected = over(row.layers, row.space === 'linear');
      console.log({ linearBlend: true, ...row, png: undefined, before: undefined, actual, expected });
      assert.ok(Math.abs(actual[0] - expected) <= 1 && actual[1] <= 1 && actual[2] <= 1, `blendSpace ${row.space}`);
      if (row.late) {
        const before = await centre(row.before);
        assert.ok(Math.abs(before[0] - over(row.layers, false)) <= 1, 'the first frame drew the display blend');
      }
    }
    // GAP-FILM-LATE: under an HDR capture the frame read is the frame just drawn.
    for (const row of await browser.page.evaluate(() => window.hdrNesting())) {
      console.log({ hdrNesting: row.effect, samples: row.samples, late: row.after === row.before });
      assert.notEqual(
        row.after,
        row.before,
        `${row.effect} ${row.samples}x: the blue frame reads blue, not the red one`,
      );
      assert.equal(row.after, row.again, `${row.effect} ${row.samples}x: one blue frame reads as two`);
    }
    assert.deepEqual(errors, []);
  },
  () => browser.close(),
);
