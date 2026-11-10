// Real-GPU check for addOccluder: engine A hides parts behind a core mesh, a materials mesh and a terrain, none of them
// parts; engine B draws the same scene with no culling. Frames must match to the byte, and behind the walls few parts
// may draw. Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/occluders-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'culling-occluders' });
try {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/occluders.html', port: 5285 }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    await page.evaluate(() => window.check.setup());
    const steps = await page.evaluate(() => window.check.steps),
      drawn = [];
    let total = 0;
    for (let i = 0; i < steps; i++) {
      const r = await page.evaluate((n) => window.check.step(n), i),
        [a, b] = [await shot('a'), await shot('b')];
      let differing = 0;
      for (let k = 0; k < a.data.length; k += 4)
        if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) differing++;
      console.log(`step ${i} ${r.label}: ${differing} differ, ${r.drawn} of ${r.total} drawn`);
      assert.equal(differing, 0, `${r.label}: culled frame differs`);
      drawn.push(r.drawn);
      total = r.total;
    }
    if (compat) {
      // On the WebGL2 layer 'occlusion' culls against the frustum only (README, "Modes"): no occluder hides a part, so
      // the crowd in view behind the walls draws whole and hiding a wall changes nothing.
      assert.equal(drawn[0], total, `compat: the walls hide nothing (${drawn[0]} of ${total} drawn)`);
      assert.equal(drawn[4], drawn[3], `compat: a hidden wall changes nothing (${drawn[4]} against ${drawn[3]})`);
    } else {
      assert.ok(drawn[0] < 100, `the walls hide the parts (${drawn[0]} drawn)`);
      assert.ok(drawn[2] > 300, `over the walls the parts draw (${drawn[2]} drawn)`);
      assert.ok(drawn[4] > drawn[3] + 10, `a hidden wall stops occluding (${drawn[4]} against ${drawn[3]})`);
    }
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('occluders pixel check passed');
} finally {
  await release();
}
