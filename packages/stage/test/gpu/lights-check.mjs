import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';

// Caller holds one shared GPU slot; compare each light kind and the mixed scene on each real backend.
for (const backend of ['native', 'compat']) {
  const browser = await openBrowser({
      startPath: `/packages/stage/test/gpu/lights.html${backend === 'compat' ? '?compat' : ''}`,
      port: 5352,
    }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await browser.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const plain = (await decodePNG(await browser.page.locator('#a').screenshot())).data;
    for (const kind of ['point', 'spot', 'area', 'directional', 'all']) {
      assert.equal(await browser.page.evaluate((kind) => window.check.install(kind), kind), true);
      const a = (await decodePNG(await browser.page.locator('#a').screenshot())).data,
        b = (await decodePNG(await browser.page.locator('#b').screenshot())).data;
      assert.equal(Buffer.compare(a, b), 0, `${backend}: ${kind} equals direct clustered setup`);
      let changed = 0;
      for (let i = 0; i < a.length; i += 4)
        if (Math.abs(a[i] - plain[i]) + Math.abs(a[i + 1] - plain[i + 1]) + Math.abs(a[i + 2] - plain[i + 2]) > 2)
          changed++;
      assert.ok(changed > 100, `${backend}: ${kind} lights the actual model`);
      await browser.page.evaluate(() => window.check.clear());
      console.log(`${backend}: ${kind}: identical pixels, ${changed} changed`);
    }
    assert.deepEqual(await browser.page.evaluate(() => window.check.close()), []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
