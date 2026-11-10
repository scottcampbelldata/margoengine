import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const c = await openBrowser({ startPath: '/packages/sprites/tests/slice-check.html', port: 5295 });
const errors = [];
c.page.on('pageerror', (e) => errors.push(e.message));
try {
  await c.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const result = await c.page.evaluate(() => window.check());
  assert.deepEqual(
    result.checks.filter((c) => c.wrong),
    [],
  );
  assert.deepEqual(result.errors, []);
  assert.equal(result.validation, null);
  assert.deepEqual(errors, []);
  console.log('ok slice pixels', JSON.stringify(result));
} finally {
  await c.close();
}
