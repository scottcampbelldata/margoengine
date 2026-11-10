import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const c = await openBrowser({ startPath: '/packages/lod/test/msft-check.html', port: 5284 });
const errors = [];
c.page.on('pageerror', (e) => errors.push(e.message));
const timer = setTimeout(() => {
  console.error('material LOD exceeded 2 minutes');
  process.exit(1);
}, 120000);
try {
  await c.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await c.page.evaluate(() => window.check.run());
  console.log(JSON.stringify(r));
  assert.deepEqual(errors, []);
  assert.deepEqual(r.errors, []);
  assert.ok(r.high.levels.every((v) => v === 0));
  assert.ok(r.low.levels.every((v) => v === 2));
  assert.ok(r.high.pixels.red > 500);
  assert.ok(r.low.pixels.blue > 500);
  assert.ok(r.retained);
  assert.ok(r.laterUV);
  assert.ok(r.restored);
} finally {
  clearTimeout(timer);
  await c.close();
}
