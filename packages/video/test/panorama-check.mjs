import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/video/test/panorama-check.html', port: 'free' });
try {
  await browser.page.waitForFunction(() => typeof window.check === 'function');
  const result = await browser.page.evaluate(() => window.check());
  console.log(JSON.stringify({ hardware: browser.hardware, ...result }, null, 2));
  assert.deepEqual(result.errors, []);
  assert.equal(result.results.length, 3);
  const expected = {
    front: [255, 0, 0],
    right: [0, 255, 0],
    back: [0, 0, 255],
    left: [255, 255, 0],
    up: [255, 0, 255],
    down: [0, 255, 255],
  };
  for (const r of result.results)
    for (const [axis, pixel] of Object.entries(r.pixels)) {
      const want = r.eye === 'right' && axis === 'front' ? [255, 255, 255] : expected[axis];
      pixel.slice(0, 3).forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= 2, JSON.stringify({ r, axis, want })));
    }
  assert.equal(result.fallback.code, 'unsupported');
  assert.match(result.fallback.message, /https:/);
} finally {
  await browser.close();
}
