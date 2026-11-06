// Real-GPU check for MeshletMesh: one mesh culled by cluster against the same mesh drawn by core.
// Frames must match to the byte, and triangles must drop.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/meshlets-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';

const release = await acquire({ owner: 'culling-meshlets' });
try {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/meshlets.html', port: 5289 }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
  const differing = (x, y) => {
    let n = 0;
    for (let k = 0; k < x.data.length; k += 4) {
      if (x.data[k] !== y.data[k] || x.data[k + 1] !== y.data[k + 1] || x.data[k + 2] !== y.data[k + 2]) n++;
    }
    return n;
  };
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    await page.evaluate(() => window.check.setup());
    const steps = await page.evaluate(() => window.check.steps);
    for (let i = 0; i < steps; i++) {
      const r = await page.evaluate((n) => window.check.step(n), i),
        [a, b] = [await shot('a'), await shot('b')],
        n = differing(a, b);
      console.log(`step ${i} ${r.label}: ${n} differ, ${r.kept} of ${r.total} triangles, ${r.clusters} clusters`);
      assert.equal(n, 0, `${r.label}: frame differs from core`);
      assert.ok(r.kept > 0 && r.kept < r.total, `${r.label}: clusters drop triangles (${r.kept})`);
    }
    for (const name of ['instances', 'occlusion', 'shadowed']) {
      const r = await page.evaluate((n) => window.check[n](), name),
        [a, b] = [await shot('a'), await shot('b')],
        n = differing(a, b);
      console.log(`${r.label}: ${n} differ, ${r.kept} of ${r.total} triangles, ${r.clusters} clusters`);
      assert.equal(n, 0, `${r.label}: frame differs from core`);
      assert.ok(r.kept > 0 && r.kept < r.total, `${r.label}: clusters drop triangles (${r.kept})`);
    }
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('meshlet pixel check passed');
} finally {
  await release();
}
