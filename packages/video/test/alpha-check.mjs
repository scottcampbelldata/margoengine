import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/video/test/alpha-check.html', port: 'free' });
const check = (got, want) =>
  got.slice(0, 3).forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 3, `${got} != ${want}`));
try {
  await browser.page.waitForFunction(() => typeof window.check === 'function');
  const result = await browser.page.evaluate(() => window.check());
  console.log(JSON.stringify({ hardware: browser.hardware, ...result }, null, 2));
  assert.equal(result.results.length, 11);
  for (const row of result.results) {
    if (row.layout) {
      check(row.pixel, [row.alpha, 0, 255 - row.alpha]);
    } else {
      const rgb = row.key.map((c) => c / 255),
        distance = Math.hypot(rgb[0], rgb[1] - 1, rgb[2]),
        t = Math.max(0, Math.min(1, (distance - 0.15) / 0.1)),
        a = t * t * (3 - 2 * t);
      check(
        row.pixel,
        rgb.map((c, i) => Math.round(255 * (c * a + (i === 2 ? 1 - a : 0)))),
      );
    }
  }
  // The direct material shader encodes sRGB before blending into the unorm canvas target.
  // Assert source-over in that existing output space; 3/255 covers output quantization/conversion rounding.
  check(result.cutout, [0, 0, 255]);
  assert.equal(result.refusals.length, 2);
  for (const e of result.refusals) {
    assert.equal(e.code, 'unsupported');
    assert.match(e.message, /https:/);
  }
  assert.deepEqual(result.errors, []);
} finally {
  await browser.close();
}
