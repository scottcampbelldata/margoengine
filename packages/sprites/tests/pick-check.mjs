import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const c = await openBrowser({ startPath: '/packages/sprites/tests/pick-check.html', port: 'free' }),
  errors = [];
c.page.on('pageerror', (e) => errors.push(e.message));
try {
  await c.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await c.page.evaluate(() => window.check());
  if (r.wrong) console.error(JSON.stringify(r, null, 2));
  assert.equal(r.wrong, 0, 'every picked sprite matches its rendered pixel');
  assert.deepEqual(
    r.boundaryPixels,
    [
      [255, 0, 0],
      [255, 0, 0],
    ],
    'the exact circle boundary includes the rotated red sprite',
  );
  assert.deepEqual(r.viewBoundary, [255, 0, 0], 'a shifted viewport uses the same local mask boundary');
  assert.ok(r.picked > 100);
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(errors, []);
  console.log('ok picking pixels', JSON.stringify(r));
} finally {
  await c.close();
}
