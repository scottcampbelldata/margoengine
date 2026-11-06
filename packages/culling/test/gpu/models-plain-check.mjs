// Real-GPU check for CulledModels on primitives without instances: engine A culls, engine B draws everything. Every step's
// frames must match to the byte, on a grid of materials meshes with a Hi-Z wall and on the real NodePerformanceTest.glb, 10,000 primitives.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/models-plain-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'culling-models-plain' });
try {
  for (const scene of ['grid', 'nodes']) {
    const context = await openBrowser({ startPath: '/packages/culling/test/gpu/models-plain.html', port: 5285 }),
      { page } = context,
      pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });
    const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
    try {
      await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
      const steps = await page.evaluate((s) => window.check.setup(s), scene),
        seen = [];
      for (let i = 0; i < steps; i++) {
        const r = await page.evaluate((n) => window.check.step(n), i),
          [a, b] = [await shot('a'), await shot('b')];
        let differing = 0,
          lit = 0;
        for (let k = 0; k < a.data.length; k += 4) {
          if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) differing++;
          if (a.data[k] + a.data[k + 1] + a.data[k + 2] > 60) lit++;
        }
        console.log(`${scene} step ${i} ${r.label}: ${differing} differ, ${lit} lit, ${r.drawn} of ${r.primitives} drawn`);
        assert.equal(differing, 0, `${r.label}: culled frame differs`);
        assert.ok(lit > 500, `${r.label}: scene not visible`);
        seen.push(r);
      }
      if (scene === 'grid') {
        assert.equal(seen[0].primitives, 146);
        assert.ok(seen[1].drawn < seen[0].drawn / 2, `close up most primitives drop (${seen[1].drawn})`);
        assert.ok(seen[3].drawn <= 2, `the wall hides the grid (${seen[3].drawn})`);
        assert.ok(seen[4].drawn > seen[3].drawn, `past the wall they draw again (${seen[4].drawn})`);
        assert.ok(seen[5].drawn >= 2, `what stands in front still draws (${seen[5].drawn})`);
        assert.ok(seen[6].drawn > seen[5].drawn + 20, `no occluder, no Hi-Z (${seen[6].drawn})`);
        assert.equal(seen.at(-1).primitives, 0, 'a removed model has no records');
      } else {
        assert.equal(seen[0].primitives, 10000);
        assert.ok(seen[1].drawn < seen[0].drawn / 2, `close up most primitives drop (${seen[1].drawn} of ${seen[0].drawn})`);
        assert.ok(seen.at(-1).drawn > seen[1].drawn, `back out they draw again (${seen.at(-1).drawn})`);
      }
      assert.deepEqual(await page.evaluate(() => window.check.errors), []);
      assert.deepEqual(pageErrors, []);
    } finally {
      // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
      await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
    }
  }
  console.log('culled plain primitives pixel check passed');
} finally {
  await release();
}
