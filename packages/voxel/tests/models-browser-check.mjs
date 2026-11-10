import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/voxel/tests/models-browser-check.html', port: 'free' }),
  errors = [];
context.page.on('pageerror', (e) => errors.push(e.message));
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const result = await context.page.evaluate(() => window.check.run());
  assert.ok(result.before > 100, JSON.stringify(result));
  assert.ok(result.rotated > 10, JSON.stringify(result));
  assert.notEqual(result.rotated, result.before);
  assert.equal(result.removed, 0);
  assert.equal(result.reloaded, result.before);
  assert.equal(result.disposed, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  console.log('voxel models', JSON.stringify(result));
} finally {
  await context.close();
}
