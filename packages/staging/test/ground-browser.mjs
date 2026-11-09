// Existing ground projection composed with existing contact shadows; no new rendering implementation.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const studio = process.argv.includes('--studio');
const context = await openBrowser({ startPath: `/packages/staging/test/ground-browser.html${studio?'?studio':''}`, port: 'free' });
const { page } = context;
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const shot = async opacity => {
    assert.deepEqual(await page.evaluate(v => window.check.render(v), opacity), []);
    return decodePNG(await page.locator('canvas').screenshot());
  };
  const off = await shot(0), on = await shot(0.8);
  const points = await page.evaluate(() => window.check.points());
  const pixel = (image, [x,y]) => [...image.data.subarray((y*image.width+x)*4, (y*image.width+x)*4+3)];
  const luma = rgb => rgb.reduce((sum, v, k) => sum + v*[0.2126,0.7152,0.0722][k], 0);
  const unshadowed = pixel(off, points.contact), shadowed = pixel(on, points.contact);
  assert(luma(unshadowed) > 20, 'the contact sample sees a nonblack HDR floor');
  assert(luma(shadowed) < luma(unshadowed)*0.9, 'the contact shadow survives background composition');
  for (const key of ['product','outside']) assert.deepEqual(pixel(on, points[key]), pixel(off, points[key]), key);
  assert(await page.evaluate(() => window.check.restore()), 'a real replacement device');
  await page.waitForFunction(() => window.check.restored(), null, { timeout: 30000 });
  const restored = await shot(0.8);
  assert.deepEqual(pixel(restored, points.contact), shadowed, 'the restored shadow matches');
  await page.evaluate(() => window.check.remove());
  const removed = await shot(0.8);
  assert.deepEqual(pixel(removed, points.contact), unshadowed, 'removing the caster clears its shadow');
  assert.deepEqual(await page.evaluate(() => window.check.dispose()), []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({contact: {off: unshadowed, on: shadowed}, checks: 7, fixture: studio?'generated studio':'OpenEXR BrightRings', product: 'stand-in'}));
  console.log('staging ground composition passed');
} finally {
  await context.close();
}
