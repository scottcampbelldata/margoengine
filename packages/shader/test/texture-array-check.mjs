import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/texture-array-check.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const pixel = async () => {
  const p = await decodePNG(await page.locator('canvas').screenshot()),
    i = (48 * p.width + 48) * 4;
  return [...p.data.slice(i, i + 3)];
};
const near = (actual, expected, tolerance = 2) =>
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= tolerance, `${actual} != ${expected}`));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const colors = await page.evaluate(() => window.check.colors);
  for (let i = 0; i < 32; i++) {
    assert.deepEqual(await page.evaluate((n) => window.check.render(n), i), []);
    near(await pixel(), colors[i].slice(0, 3));
  }
  const computed = await page.evaluate(() => window.check.compute());
  assert.deepEqual(computed.errors, []);
  assert.deepEqual(
    computed.data,
    computed.reference,
    'every array sample exactly matches an independent 2D sRGB texture',
  );
  const bounds = await page.evaluate(() => window.check.boundaries());
  assert.deepEqual(bounds.errors, []);
  near(
    bounds.data,
    [0, 31].flatMap((i) => computed.reference.slice(i * 4, i * 4 + 4)),
    0.00001,
  );
  for (const i of [1, 17, 31]) {
    assert.deepEqual(await page.evaluate((n) => window.check.post(n), i), []);
    near(
      await pixel(),
      computed.reference.slice(i * 4, i * 4 + 3).map((x) => Math.round(x * 255)),
    );
  }
  assert.deepEqual(await page.evaluate(() => window.check.placeholder()), []);
  near(await pixel(), [255, 255, 255], 0);
  await page.evaluate(() => window.check.close());
  assert.deepEqual(errors, []);
  console.log(
    'texture arrays: 32 material layers, vertex samples, live index, typed compute, post sampling and unloaded white placeholder passed',
  );
} finally {
  await context.close();
}
