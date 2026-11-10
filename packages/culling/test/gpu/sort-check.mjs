import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';
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
      const a = await decodePNG(await context.page.locator('#a').screenshot()),
        b = await decodePNG(await context.page.locator('#b').screenshot());
      assert.deepEqual(a.data, b.data, `${kind} step ${i}: sorting changed visible pixels`);
      console.log('sorted pixels', kind, i);
    }
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}
