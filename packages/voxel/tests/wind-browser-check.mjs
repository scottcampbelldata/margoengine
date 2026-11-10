import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
for (const bevel of [false, true]) {
  const c = await openBrowser({
      startPath: '/packages/voxel/tests/wind-browser-check.html' + (bevel ? '?bevel' : ''),
      port: 'free',
    }),
    errors = [];
  c.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await c.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const r = await c.page.evaluate(() => window.check.run());
    assert.ok(r.motion > 50, JSON.stringify(r));
    assert.equal(r.repeat, 0);
    assert.equal(r.zero, 0);
    if (bevel) assert.ok(r.cpuFallback > 0);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(errors, []);
    console.log('voxel wind', JSON.stringify({ bevel, ...r }));
  } catch (error) {
    console.error(await c.page.evaluate(() => window.windErrors));
    throw error;
  } finally {
    await c.close();
  }
}
