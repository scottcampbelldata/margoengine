// Real-GPU check for bounds: 'box': rods just under a plate, culled by oriented boxes and by spheres, against the same
// scene as core meshes. Frames must match to the byte, and boxes must drop what spheres keep.
// Under MARGO_COMPAT=1 the WebGL2 layer's route (src/compat.ts) tests bounding spheres on the CPU and has no Hi-Z, so
// 'occlusion' culls against the frustum only (README "Modes" and "Any geometry as occluder"): boxes keep exactly what
// spheres keep, every frame still matches core, the frustum still drops rods, and "the plate hides the rods by box" is
// skipped with a printed note.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/bounds-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'culling-bounds' });
try {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/bounds.html', port: 5286 }),
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
      results = [];
    for (let i = 0; i < steps; i++) {
      const r = await page.evaluate((n) => window.check.step(n), i),
        [a, b, c] = [await shot('a'), await shot('b'), await shot('c')];
      let differing = 0,
        spheres = 0;
      for (let k = 0; k < a.data.length; k += 4) {
        if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) differing++;
        if (c.data[k] !== b.data[k] || c.data[k + 1] !== b.data[k + 1] || c.data[k + 2] !== b.data[k + 2]) spheres++;
      }
      console.log(
        `step ${i} ${r.label}: ${differing} differ (spheres ${spheres}), ${r.box} rods by box, ${r.sphere} by sphere`,
      );
      assert.equal(differing, 0, `${r.label}: box-culled frame differs from core`);
      assert.equal(spheres, 0, `${r.label}: sphere-culled frame differs from core`);
      assert.ok(r.box <= r.sphere, `${r.label}: boxes only ever drop more`);
      if (compat) assert.equal(r.box, r.sphere, `${r.label}: the compat route tests spheres for box bounds too`);
      results.push(r);
    }
    if (compat) {
      console.log('compat culls against the frustum only (no Hi-Z), "the plate hides the rods by box" skipped');
      assert.ok(
        results.some((r) => r.sphere < results[0].sphere / 2),
        `the compat route still drops rods outside the frustum (${results.map((r) => r.sphere)})`,
      );
    } else assert.ok(results[0].box < 50, `the plate hides the rods by box (${results[0].box})`);
    assert.ok(results[0].sphere > 400, `spheres reach through the plate (${results[0].sphere})`);
    assert.ok(results[3].box > 400, `seen from below the rods draw (${results[3].box})`);
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('box bounds pixel check passed');
} finally {
  await release();
}
