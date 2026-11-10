import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const c = await openBrowser({ startPath: '/packages/sprites/tests/blend-check.html', port: 5298 }),
  errors = [];
c.page.on('pageerror', (e) => errors.push(e.message));
try {
  await c.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await c.page.evaluate(() => window.check());
  assert.equal(r.cases, 146);
  assert.ok(r.maximumError <= 1);
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(errors, []);
  console.log('ok sprite blend equations, including transparent targets', JSON.stringify(r));
} finally {
  await c.close();
}
