// Real-GPU check that createMeshes draws a 7,997,584-vertex mesh (the parsers' default maxVertices) split into
// core-sized parts: every part at most 1,000,000 vertices, every triangle kept, the field covers the frame, and WebGPU
// reports no validation error. Wall time per frame is printed for the speed phase (diagnostic only).
// Takes a GPU slot itself. Run from the repository root after building packages, natively and with MARGO_COMPAT=1:
//   node packages/loaders/tests/split-scale-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { decodePNG } from '../../../tests/support/png.js';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const compat = compatRun(),
  release = await acquire({ owner: 'loaders-split-scale' });
try {
  const context = await openBrowser({ startPath: '/packages/loaders/tests/split-scale.html', port: 5289 }),
    { page } = context,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    const s = await page.evaluate(() => window.check.setup());
    console.log(
      `${s.sourceTriangles} triangles in ${s.parts} parts (largest ${s.largest} vertices, ${s.vertices} stored), built in ${Math.round(s.buildMs)} ms`,
    );
    assert.ok(s.parts >= 8, `${s.parts} parts`);
    assert.ok(s.largest <= 1_000_000, `largest part ${s.largest}`);
    assert.equal(s.triangles, s.sourceTriangles);
    assert.equal(s.materials, 1);
    const f = await page.evaluate(() => window.check.frames());
    console.log(`frame${compat ? ' (compat)' : ''}: ${s.parts} draws, wall ${f.wallMs.toFixed(1)} ms (diagnostic)`);
    const shot = await decodePNG(await page.locator('#a').screenshot());
    let lit = 0;
    for (let k = 0; k < shot.data.length; k += 4) if (shot.data[k] > 60 && shot.data[k] > shot.data[k + 2] + 20) lit++;
    const share = lit / (shot.data.length / 4);
    console.log(`field covers ${(share * 100).toFixed(1)}% of the frame`);
    assert.ok(share > 0.3, `the field is drawn (${share})`);
    assert.deepEqual(await page.evaluate(() => window.check.errors), []);
    assert.deepEqual(pageErrors, []);
  } finally {
    // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
    await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
  }
  console.log('loader split scale check passed');
} finally {
  await release();
}
