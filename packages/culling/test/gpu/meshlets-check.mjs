// Real-GPU check for MeshletMesh: one mesh culled by cluster against the same mesh drawn by core.
// Frames must match to the byte, and triangles must drop. Redrawing an unchanged frame must give the same bytes (batch 132:
// an atomic cluster reservation changed the draw order, and with it depth ties, from frame to frame).
//
// The core comparison runs without MSAA (Scott, 2026-11-10): A and B use `exactSize`. On the M6 (Chromium WebGPU on Metal)
// core's own 4x MSAA frame changes with the primitive stream: a probe drew the ball with core alone and got 75 pixels
// apart for the same 36,864 triangles in cluster order instead of index order, and 14 for only the 25,447 cone-kept
// triangles (every dropped one back facing), against 0 for both with `exactSize`. So no cluster cull can match core to the
// byte under MSAA there (this check read 69 pixels at step 0). The frame-repeat check still runs under MSAA too: engine R
// is A again with the default 4x MSAA, and each step redraws both A and R and compares each to its last frame.
//
// Under MARGO_COMPAT=1 the WebGL2 layer draws the whole mesh by design (no cluster cull), so the check asserts the frame
// matches core and skips "clusters drop triangles" with a printed note.
// Takes a GPU slot itself. Run from the repository root after building packages:
//   node packages/culling/test/gpu/meshlets-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../../tests/support/png.js';

const compat = compatRun(),
  release = await acquire({ owner: 'culling-meshlets' });
try {
  const context = await openBrowser({ startPath: '/packages/culling/test/gpu/meshlets.html', port: 5289 }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
  // Redraws every engine with nothing changed; A's (no MSAA) and R's (MSAA) new frames must equal their last to the byte.
  const repeats = async (label) => {
    const before = [await shot('a'), await shot('r')];
    await page.evaluate(() => window.check.redraw());
    const after = [await shot('a'), await shot('r')];
    for (const k of [0, 1])
      assert.ok(
        Buffer.from(after[k].data).equals(Buffer.from(before[k].data)),
        `${label}: a redraw of ${'ar'[k]} differs (${differing(before[k], after[k])} pixels)`,
      );
  };
  // The WebGL2 layer draws every triangle by design, so under compat only the picture and the repeat are checked.
  const drops = (r) => {
    if (compat) console.log(`${r.label}: compat draws the whole mesh, "clusters drop triangles" skipped`);
    else assert.ok(r.kept > 0 && r.kept < r.total, `${r.label}: clusters drop triangles (${r.kept})`);
  };
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
      await repeats(r.label);
      assert.equal(n, 0, `${r.label}: frame differs from core`);
      drops(r);
    }
    for (const name of ['instances', 'occlusion', 'shadowed']) {
      const r = await page.evaluate((n) => window.check[n](), name),
        [a, b] = [await shot('a'), await shot('b')],
        n = differing(a, b);
      console.log(`${r.label}: ${n} differ, ${r.kept} of ${r.total} triangles, ${r.clusters} clusters`);
      await repeats(r.label);
      assert.equal(n, 0, `${r.label}: frame differs from core`);
      drops(r);
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
