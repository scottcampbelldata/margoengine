import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const browser = await openBrowser({ startPath: '/packages/ui/tests/world-gl.html?backend=webgl2', port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.setDefaultTimeout(60000);
try {
  for (const backend of ['webgl2', 'webgpu'])
    for (const shape of ['', 'cylinder', 'sphere']) {
      await page.goto(new URL(`/packages/ui/tests/world-gl.html?backend=${backend}&shape=${shape}`, page.url()).href);
      await page.waitForFunction(() => typeof window.runWorldTests === 'function');
      const report = await page.evaluate(() => window.runWorldTests());
      const box = await page.locator('canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 10);
      assert.equal((await page.evaluate(() => window.readWorld())).clicks, 1, 'real pointer ray reaches world button');
      await page.mouse.click(box.x + 10, box.y + 10);
      assert.equal((await page.evaluate(() => window.readWorld())).clicks, 1, 'off-panel click misses');
      assert.deepEqual(errors, []);
      await page.evaluate(() => window.finishWorld());
      console.log(backend, shape || 'plane', report.checks.length + 2, 'world panel checks passed');
    }
} finally {
  await browser.close();
}
