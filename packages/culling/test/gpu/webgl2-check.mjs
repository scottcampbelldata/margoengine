import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/culling/test/gpu/webgl2.html', port: 'free' });
const errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 45000 });
  for (let i = 0; i < 6; i++) {
    const result = await context.page.evaluate((n) => window.check.step(n), i);
    const a = await decodePNG(await context.page.locator('#a').screenshot()),
      b = await decodePNG(await context.page.locator('#b').screenshot());
    assert.deepEqual(a.data, b.data, `frame ${i}: culling changes pixels`);
    if (i === 0 || i === 2) assert.ok(result.drawn < 50, JSON.stringify(result));
    if (i === 1 || i === 5) assert.equal(result.drawn, 81, 'moving wall or disabling culling reveals all immediately');
    console.log('software occlusion', i, result);
  }
  await context.page.evaluate(() => window.check.dispose());
  assert.deepEqual(errors, []);
} finally {
  await context.close();
}
