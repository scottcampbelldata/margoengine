// Real-GPU proof of @margoengine/physics/gpu-cloth: a 48 x 48 cloth in wind over every collider shape, on WebGPU or, with
// --compat, on the WebGL2 layer (its CPU twin), drawn by drawGPUCloth of @margoengine/gltf/soft-mesh.
//   node scripts/run-with-timeout.mjs --max=4 -- node packages/physics/tests/gpu-cloth-check.mjs
//   node scripts/run-with-timeout.mjs --max=4 -- node packages/physics/tests/gpu-cloth-check.mjs --compat
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const port = 5427;
const url = `http://127.0.0.1:${port}/packages/physics/tests/gpu-cloth-check.html`;
const context = await openBrowser({ startPath: '/packages/physics/tests/gpu-cloth-check.html', port });
const { page, hardware } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

try {
  console.log('adapter', JSON.stringify(hardware.webgpu), hardware.compat ? '(WebGL2 compatibility)' : '');
  await page.goto(url);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.check());
  console.log(JSON.stringify(r));
  assert.deepEqual(r.errors, [], `uncaptured GPU errors: ${JSON.stringify(r.errors)}`);
  assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
  assert.equal(r.stats.backend, hardware.compat ? 'webgl2-compat' : 'webgpu');
  assert.equal(r.compat, !!hardware.compat);
  // Determinism: no atomics, every thread writes its own particle or its edge's two, so a run repeats to the bit.
  assert.equal(r.hashes[1], r.hashes[0], 'the same 60 steps from the start give the same state');
  assert.equal(r.hashes[2], r.hashes[0], 'a snapshot restored at step 30 repeats the rest');
  assert.ok(r.finite, 'every particle finite after 60 steps');
  // One step against the CPU twin. On the WebGL2 layer the twin is the cloth, so they are equal. On WebGPU both run the
  // same passes in the same order; float32 against the twin's float64 arithmetic stored in float32 moves a particle by
  // rounding, a few ulps of 2 m (2.4e-7 each) a pass, over 30 substeps of about 20 passes.
  if (r.compat) assert.equal(r.worst, 0);
  else assert.ok(r.worst < 1e-4 && r.off === 0, `worst GPU-CPU gap ${r.worst} m, ${r.off} particles over 1e-4 m`);
  assert.equal(r.frameSteps, 10, 'each of the 10 frames steps once');
  assert.ok(r.lit > 1500, `cloth drawn: ${r.lit} px`);
  assert.ok(r.moved > 200, `the cloth moves across frames: ${r.moved} px`);
  assert.equal(r.pausedDiff, 0, 'a paused cloth draws the same frame');
  assert.ok(r.debugSegments > 48 * 47 * 2, `debug lines: ${r.debugSegments}`);
  assert.equal(r.afterDisposeLit, 0, `clean canvas after dispose: ${r.afterDisposeLit} px`);
  console.log(
    `ok gpu-cloth (${r.stats.backend}): ${r.count} particles, ${r.stats.colors} colours, hash ${r.hashes[0]}, ` +
      `twin gap ${r.worst.toExponential(2)} m, lit ${r.lit}, moved ${r.moved}`,
  );
} finally {
  await context.close();
}
