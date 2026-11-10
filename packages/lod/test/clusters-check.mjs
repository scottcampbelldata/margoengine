import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/lod/test/clusters-check.html', port: 5281 });
const errors = [];
context.page.on('pageerror', e => errors.push(e.message));
const timer = setTimeout(() => { console.error('cluster LOD exceeded its 2 minute limit'); process.exit(1); }, 120000);
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await context.page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.deepEqual(errors, []); assert.deepEqual(r.errors, []);
  assert.ok(r.lit > 1000); assert.ok(r.coverage > 0.85);
  assert.equal(r.rows[0].triangles, r.triangles);
  assert.ok(r.rows[2].triangles < r.triangles);
  assert.ok(r.nodes > 3);
} finally { clearTimeout(timer); await context.close(); }
