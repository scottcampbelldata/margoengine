// Real-GPU check for CulledMeshes' occlusion: engine A culls, engine B draws everything. Every step's frames must match
// to the byte, and behind the wall the plugin must draw far fewer instances than there are.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/meshes-occlusion-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'culling-meshes-occlusion' });
try {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/meshes-occlusion.html', port: 5283 }),
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
      assert.equal(differing, 0, `${r.label}: culled frame differs from core`);
      drawn.push(r.drawn);
      total = r.total;
    }
    if (compat) {
      // The WebGL2 layer culls by frustum and screen size only (README, "Occlusion for core meshes"): behind the wall the
      // whole crowd is in view and draws, and inside it the frustum still drops what is behind the camera.
      assert.equal(drawn[0], total, `compat: occlusion hides nothing (${drawn[0]} of ${total} drawn)`);
      assert.equal(drawn.at(-1), total, `compat: back behind the wall, all draw (${drawn.at(-1)})`);
      assert.ok(Math.min(...drawn) < total / 2, `compat: the frustum still culls (${Math.min(...drawn)} of ${total})`);
    } else {
      assert.ok(drawn[0] < 200, `the wall hides the crowd (${drawn[0]} drawn)`);
      assert.ok(drawn[2] > drawn[0] + 300, `the crowd draws from the side (${drawn[2]} drawn)`);
      assert.ok(drawn.at(-1) < 200, `hidden again (${drawn.at(-1)} drawn)`);
    }
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('culled meshes occlusion check passed');
} finally {
  await release();
}
