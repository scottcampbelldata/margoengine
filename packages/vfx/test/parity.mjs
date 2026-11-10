import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
if (process.argv.includes('--compat')) process.env.MARGO_COMPAT = '1';
const context = await openBrowser({ startPath: '/packages/vfx/test/parity.html', port: 'free' });
const { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const near = (a, b) => assert.ok(Math.abs(a - b) < 2e-5, `${a} != ${b}`);
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.checkSpace());
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  near(r.results.local.old[0], 2);
  near(r.results.world.old[0], 0);
  for (const mode of ['local', 'world']) {
    near(r.results[mode].born[0], 3);
    near(r.results[mode].born[4], 10);
    for (let i = 0; i < 8; i++) near(r.results[mode].distance[i * 8], (i + 1) * 0.25);
  }
  near(r.results.rotated[0], 0);
  near(r.results.rotated[1], 1);
  assert.deepEqual(pageErrors, []);
  console.log('ok space: local/world, rigid rotation, velocity inheritance, eight spaced distance births');
  if (process.argv.includes('--over-life')) {
    const r = await page.evaluate(() => window.checkOverLife());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    for (let i = 0; i < 5; i++) {
      const t = (i + 1) * 0.1,
        p = r.states[i];
      near(p[4], 4 * t);
      near(p[7], 0.1 * (1 + 2 * t));
      near(p[32 + 4], r.first[32 + 4] + 2 * (t * t - 0.01));
    }
    assert.deepEqual(r.first, r.replay);
    near(Math.hypot(...r.capped.slice(4, 7)), 2);
    near(r.rotated[4], 0);
    near(r.rotated[5], 0.8);
    console.log(
      'ok over-life: zero-speed recovery, growth, integrated spin, speed cap, reset replay and local rotation',
    );
  }
} finally {
  await context.close();
}
