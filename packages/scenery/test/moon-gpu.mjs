import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const ctx = await openBrowser({ startPath: '/packages/scenery/test/moon-check.html', port: 'free' });
const errors = [];
ctx.page.on('pageerror', (e) => errors.push(e.message));
try {
  const origin = new URL(ctx.page.url()).origin;
  for (const samples of [4, 1]) {
    await ctx.page.goto(`${origin}/packages/scenery/test/moon-check.html?samples=${samples}`);
    await ctx.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    assert.equal(await ctx.page.evaluate(() => window.check.samples()), samples);
    const r = await ctx.page.evaluate(() => window.check.run());
    console.log(JSON.stringify({ samples, ...r }));
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(errors, []);
    assert.ok(r.full > 10);
    assert.ok(r.quarter > 0.1 * r.full && r.quarter < 0.5 * r.full);
    assert.equal(r.dark, 0);
    assert.ok(r.earth > 0 && r.earth < r.full * 0.1);
    assert.equal(r.same, 0);
    assert.notEqual(...r.textureRange);
    assert.equal(r.hidden, 0);
    assert.equal(r.outside, 0);
    const o = r.orientation;
    assert.ok(
      o.west > 0.5 && o.east === 0 && o.north > 0.5 && o.south === 0 && o.rotatedEast > 0.5 && o.rotatedSouth > 0.5,
    );
  }
} finally {
  await ctx.close();
}
