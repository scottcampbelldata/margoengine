import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';
import { frameDiff } from './msaa.mjs';
for (const kind of ['core', 'static', 'models', 'dynamic']) {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/sort.html?kind=' + kind, port: 'free' }),
    errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 45000 });
    if (kind === 'core') {
      const results = await context.page.evaluate(() => window.check.raw());
      for (const r of results) {
        assert.deepEqual(r.actual, r.expected, `capacity ${r.capacity}: records/order`);
        assert.deepEqual(r.actualArgs, r.expectedArgs, 'counts unchanged');
      }
      console.log(
        'GPU sorted records',
        results.map((r) => r.capacity),
      );
    }
    for (let i = 0; i < 3; i++) {
      await context.page.evaluate((n) => window.check.step(n), i);
      const shot = async (id) => decodePNG(await context.page.locator(`#${id}`).screenshot()),
        { differing, at, mode } = await frameDiff(context.page, shot);
      assert.equal(differing, 0, `${kind} step ${i}: sorting changed visible ${mode} ${JSON.stringify(at)}`);
      console.log('sorted pixels', kind, i, mode);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
