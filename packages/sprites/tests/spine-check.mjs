import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const c = await openBrowser({ startPath: '/packages/sprites/tests/spine-check.html', port: 'free' }),
  errors = [];
c.page.on('pageerror', (e) => errors.push(e.message));
try {
  await c.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await c.page.evaluate(() => window.check());
  assert.ok(r.cases >= 48);
  assert.ok(r.maximumError <= 1);
  assert.ok(r.treeCoverage > 100);
  assert.ok(r.treeChanged > 20);
  assert.equal(r.seekDifferences, 0);
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(errors, []);
  console.log(
    'ok skeletal JSON: weighted meshes, clips, slot colors/blends, licensed animated tree and backward seek',
    JSON.stringify(r),
  );
} finally {
  await c.close();
}
