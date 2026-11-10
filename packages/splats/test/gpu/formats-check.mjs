import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { decodePNG } from '../../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/splats/test/gpu/splats.html', port: 'free' });
try {
  const errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  await context.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  for (const options of [{ ksplat: 0 }, { ksplat: 1 }, { ksplat: 2 }, { plyExport: true }]) {
    const url = await context.page.evaluate(async (opts) => {
      await window.check.build({ ...opts, capture: true, samples: 1 });
      return window.check.pixels();
    }, options);
    const image = await decodePNG(Buffer.from(url.split(',')[1], 'base64'));
    let covered = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if (image.data[i] + image.data[i + 1] + image.data[i + 2] > 60) covered++;
    assert.ok(covered > 1000, `${JSON.stringify(options)} draws the real capture, ${covered} covered pixels`);
    console.log(JSON.stringify({ options, covered }));
  }
  assert.deepEqual(errors.concat(await context.page.evaluate(() => window.check.errors)), []);
} finally {
  await context.close();
}
