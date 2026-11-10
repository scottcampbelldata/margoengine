import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const c = await openBrowser({ startPath: '/packages/sprites/tests/rigging-check.html', port: 5296 }),
  errors = [];
c.page.on('pageerror', (e) => errors.push(e.message));
try {
  await c.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await c.page.evaluate(() => window.check());
  assert.deepEqual(r.pixels, [
    [0, 255, 0],
    [0, 0, 255],
    [0, 255, 0],
    [0, 255, 0],
    [0, 0, 255],
  ]);
  assert.ok(r.ik.converged);
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(errors, []);
  console.log('ok rigging slots, swaps, draw keys, backwards seek and IK pixels', JSON.stringify(r));
} finally {
  await c.close();
}
