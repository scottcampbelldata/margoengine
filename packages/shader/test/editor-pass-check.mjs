import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/editor-pass-check.html', port: 'free' }),
  { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const pixel = async () => {
  const p = await decodePNG(await page.locator('#host canvas').screenshot()),
    i = (64 * p.width + 64) * 4;
  return [...p.data.slice(i, i + 3)];
};
const near = (got, want) => got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 2, `${got} != ${want}`));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  let result = await page.evaluate(() => window.check.render());
  assert.deepEqual(result.errors, []);
  near(await pixel(), [128, 94, 69]);
  const builds = result.builds;
  await page.locator('#editor [data-node=scale] input').fill('1');
  await page.locator('#editor [data-node=scale] input').press('Enter');
  result = await page.evaluate(() => window.check.render());
  assert.deepEqual(result.errors, []);
  assert.equal(result.builds, builds + 1);
  near(await pixel(), [255, 188, 137]);
  const saved = await page.evaluate(() => window.check.save());
  await page.evaluate(() => window.check.move());
  result = await page.evaluate(() => window.check.render());
  assert.equal(result.builds, builds + 1);
  await page.evaluate(() => window.check.value(0.25));
  await page.evaluate(() => window.check.render());
  near(await pixel(), [64, 47, 34]);
  await page.evaluate((json) => window.check.load(json), saved);
  await page.evaluate(() => window.check.render());
  near(await pixel(), [255, 188, 137]);
  await page.evaluate(() => window.check.compute());
  for (const value of [0.5, 0.25]) {
    await page.evaluate((v) => window.check.value(v), value);
    const r = await page.evaluate(() => window.check.read());
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.data, Array.from({ length: 24 }, (_, i) => [i * value, 2 * value, 4 * value, 0.5]).flat());
  }
  await page.evaluate(() => window.check.close());
  assert.deepEqual(errors, []);
  console.log(
    'post/compute editor: real field edit, pixels, save/load, layout without rebuild, typed 3d dispatch and hot reload passed',
  );
} finally {
  await context.close();
}
