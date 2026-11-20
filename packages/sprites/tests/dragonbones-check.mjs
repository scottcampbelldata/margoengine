import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const c = await openBrowser({ startPath: '/packages/sprites/tests/dragonbones-check.html', port: 'free' }),
  errors = [];
c.page.on('pageerror', (e) => errors.push(e.message));
try {
  await c.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await c.page.evaluate(() => window.check());
  assert.deepEqual(r.mismatches, []);
  assert.ok(r.probes >= 10, `probes ${r.probes}`);
  assert.ok(r.dragonCoverage > 300, `coverage ${r.dragonCoverage}`);
  assert.ok(r.dragonChanged > 20, `changed ${r.dragonChanged}`);
  assert.equal(r.seekDifferences, 0);
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(errors, []);
  console.log(
    'ok DragonBones: images, weighted FFD mesh, nested armature, real file pose and backward seek',
    JSON.stringify(r),
  );
} finally {
  await c.close();
}
