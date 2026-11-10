// Real-GPU check for CulledModels: engine A culls a materials instanced mesh, engine B draws every row. Every step's
// frames must match to the byte, with and without shadows, and close up the plugin must draw far fewer rows.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/models-cull-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'culling-models' });
try {
  for (const shadows of [false, true]) {
    const context = await openBrowser({ startPath: '/packages/culling/test/gpu/models-cull.html', port: 5284 }),
      { page } = context,
      pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });
    const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
    try {
      await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
      await page.evaluate((s) => window.check.setup(s), shadows);
      const steps = await page.evaluate(() => window.check.steps),
        drawn = [];
      for (let i = 0; i < steps; i++) {
        const r = await page.evaluate((n) => window.check.step(n), i),
          [a, b] = [await shot('a'), await shot('b')];
        let differing = 0,
          lit = 0;
        for (let k = 0; k < a.data.length; k += 4) {
          if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) differing++;
          if (a.data[k] + a.data[k + 1] + a.data[k + 2] > 60) lit++;
        }
        console.log(`${shadows ? 'shadows' : 'plain'} step ${i} ${r.label}: ${differing} differ, ${lit} lit, ${r.drawn} of ${r.total} drawn`);
        assert.equal(differing, 0, `${r.label}: culled frame differs`);
        assert.ok(lit > 500, `${r.label}: scene not visible`);
        drawn.push(r);
      }
      // The WebGL2 layer culls nothing and every row draws (README, "Loaded models and materials meshes"); readCounts()
      // says so.
      if (compat)
        for (const r of drawn.slice(0, -1)) assert.equal(r.drawn, r.total, `${r.label}: compat: every row draws (${r.drawn})`);
      else assert.ok(drawn[1].drawn < drawn[1].total / 2, `close up most rows drop (${drawn[1].drawn})`);
      assert.equal(drawn.at(-1).primitives, 0, 'a removed model has no lists');
      assert.deepEqual(await page.evaluate(() => window.check.errors), []);
      assert.deepEqual(pageErrors, []);
    } finally {
      // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
      await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
    }
  }
  console.log('culled models pixel check passed');
} finally {
  await release();
}
