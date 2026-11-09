// gpu-timing: none (same cameras and shadows checked for GPU errors; speed sampling lives in objects-frame-speed.mjs)
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';

const release = await acquire({ owner: 'biomes-objects-frame-correctness', mode: 'shared', max: 10 });
const context = await openBrowser({ startPath: '/packages/biomes/tests/objects-frame-check.html', port: 'free' });
const { page } = context,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await runSuite(
  async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    for (const name of ['01', '02', 'far'])
      for (const shadows of [false, true]) {
        const r = await page.evaluate(([n, s]) => window.check.frame(n, s, {}, false), [name, shadows]);
        assert.deepEqual(r.errors, []);
      }
    const off = await page.evaluate(() => window.check.frame('far', false, { far: false }, false));
    assert.deepEqual(off.errors, []);
    assert.deepEqual(errors, []);
    console.log(
      'ok biomes objects: cameras, shadows and far toggle draw without errors; speed samples deferred to speed suite',
    );
  },
  async () => {
    try {
      await context.close();
    } finally {
      release();
    }
  },
);
watchExit();
