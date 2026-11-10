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
} finally {
  await context.close();
}
