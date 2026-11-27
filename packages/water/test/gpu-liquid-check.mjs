// Real-GPU proof of GPULiquid (@margoengine/water/liquid): 65,536 MLS-MPM particles on WebGPU, or the CPU twin's 1,024
// on the WebGL2 layer.
//   node scripts/run-with-timeout.mjs --max=5 -- node packages/water/test/gpu-liquid-check.mjs
//   node scripts/run-with-timeout.mjs --max=5 -- node packages/water/test/gpu-liquid-check.mjs --compat
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const port = 5427;
const url = `http://127.0.0.1:${port}/packages/water/test/gpu-liquid-check.html`;
const context = await openBrowser({ startPath: '/packages/water/test/gpu-liquid-check.html', port });
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
  assert.equal(r.stats.backend, r.compat ? 'webgl2-compat' : 'webgpu');
  // Determinism: integer atomic sums make the GPU step independent of the order of the adds.
  assert.equal(r.hashes[1], r.hashes[0], 'the same steps from the start give the same state');
  assert.equal(r.hashes[2], r.hashes[0], 'a restored snapshot repeats the same steps');
  // One frame against the CPU twin. On the WebGL2 layer the twin is the liquid, so they are equal. On WebGPU both run
  // the same passes and the same fixed-point sums; f32 against f64 moves a sum's rounding by at most one unit
  // (1 / 65,536 of a particle's momentum), and a frame of substeps from rest moves a particle by a few cells' worth of
  // g dt^2, so the positions agree to 1e-4 m and the velocities to 1e-2 m/s.
  if (r.compat) assert.equal(r.worstPos + r.worstVel, 0);
  else {
    assert.ok(r.worstPos < 1e-4, `worst position gap ${r.worstPos}`);
    assert.ok(r.worstVel < 1e-2, `worst velocity gap ${r.worstVel}`);
  }
  assert.ok(
    Math.abs(r.gpuForceY - r.twinForceY) <= 0.02 * Math.abs(r.twinForceY) + 1e-3,
    `collider force GPU ${r.gpuForceY} N, twin ${r.twinForceY} N`,
  );
  assert.ok(Number.isFinite(r.lateForceY), 'the collider force reads back');
  // Archimedes: the grid meets the sphere within a quarter cell of its surface, so the time-averaged lift of the held
  // sphere (radius 0.1 m) lies between rho g V of spheres a quarter cell smaller and larger.
  const q = (0.25 * r.stats.cellSize) / 0.1;
  assert.ok(
    r.lift >= (1 - q) ** 3 * r.archimedes && r.lift <= (1 + q) ** 3 * r.archimedes,
    `held sphere lift ${r.lift} N against rho g V ${r.archimedes} N (cell ${r.stats.cellSize} m)`,
  );
  assert.equal(r.nonFinite, 0, 'every particle stays finite');
  assert.equal(r.outside, 0, 'every particle stays inside the container');
  assert.ok(r.pointerVz > 0.3, `liquid at the pointer takes on its velocity: ${r.pointerVz} m/s`);
  assert.ok(r.frameSteps >= 10 * r.frameSubsteps - r.frameSubsteps, `frames step: ${r.frameSteps}`);
  assert.ok(r.litFrame1 > 200, `surface drawn on frame 1: ${r.litFrame1} px`);
  assert.ok(r.movedPixels > 100, `liquid moves across frames: ${r.movedPixels} px`);
  assert.equal(r.pausedDiff, 0, 'a paused liquid draws the same frame');
  assert.ok(r.speedDiff > 200, `the speed view draws: ${r.speedDiff} px`);
  assert.ok(r.densityDiff > 50, `the density view differs from the speed view: ${r.densityDiff} px`);
  assert.ok(r.linesDiff > 50, `the grid, container and collider lines draw: ${r.linesDiff} px`);
  assert.equal(r.debugDraws, 1, 'the line view is one draw');
  assert.ok(r.surfaceBack, 'the surface comes back after the particle view');
  assert.equal(r.afterDisposeLit, 0, `clean canvas after dispose: ${r.afterDisposeLit} px`);
  console.log(
    `ok gpu liquid (${r.stats.backend}): ${r.count} particles, ${r.stats.nodes} nodes, hash ${r.hashes[0]}, ` +
      `twin gap ${r.worstPos.toExponential(2)} m, force ${r.gpuForceY?.toFixed(3)} N, pointer ${r.pointerVz.toFixed(2)} m/s, ` +
      `lit ${r.litFrame1}, moved ${r.movedPixels}, speed ${r.speedDiff}, lines ${r.linesDiff}`,
  );
} finally {
  await context.close();
}
