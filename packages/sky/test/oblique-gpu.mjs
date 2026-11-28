// Sky layers draw the same picture under an oblique near plane (a planar reflection's capture camera) as without it.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const ctx = await openBrowser({ startPath: '/packages/sky/test/oblique-check.html', port: 'free' });
const errors = [];
ctx.page.on('pageerror', (e) => errors.push(e.message));
try {
  await ctx.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const results = await ctx.page.evaluate(() => window.check.run());
  for (const r of results) {
    console.log(JSON.stringify(r));
    assert.equal(r.error, null, r.name);
    assert.deepEqual(r.errors, [], r.name);
    assert.ok(r.peak > 0.01, `${r.name} draws`);
    assert.ok(r.diff <= 1e-3 * r.peak, `${r.name} differs under an oblique near plane by ${r.diff} of ${r.peak}`);
  }
  assert.deepEqual(errors, []);
} finally {
  await ctx.close();
}
