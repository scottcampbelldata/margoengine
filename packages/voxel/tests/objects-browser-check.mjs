import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/voxel/tests/objects-browser-check.html', port: 'free' }),
  errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await context.page.evaluate(() => window.check.run());
  assert.ok(r.before.red > 100, JSON.stringify(r));
  assert.equal(r.before.visible, 2);
  assert.equal(r.before.draws, 1);
  assert.equal(r.before.cells, 3);
  assert.ok(r.edited.red > 0 && r.edited.red < r.before.red);
  assert.equal(r.edited.visible, 1);
  assert.equal(r.removed.red, 0);
  assert.equal(r.removed.visible, 0);
  assert.equal(r.removed.cells, 1);
  assert.deepEqual(r.reloaded, r.before);
  assert.equal(r.disposed, 0);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(errors, []);
  console.log('voxel objects', JSON.stringify(r));
} finally {
  await context.close();
}
