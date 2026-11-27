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
  // The capsule (radius 0.07, half length 0.1) and the mesh cube (half size 0.08) against rho g V of shapes a quarter cell
  // smaller and larger; the cube's field adds up to one of its sample spacings (0.24 m / 31) round its edges.
  const capsuleV = (r) => Math.PI * r * r * ((4 / 3) * r + 0.2);
  const cubeV = (a) => (2 * a) ** 3;
  const d = 0.25 * r.stats.cellSize;
  const field = (2 * (0.08 + (2 * 0.16) / 32)) / 31;
  const rhoG = 1000 * 9.81;
  for (const [i, V, lo, hi, name] of [
    [1, capsuleV, 0.07 - d, 0.07 + d, 'capsule'],
    [2, cubeV, 0.08 - d - field, 0.08 + d + field, 'mesh cube'],
  ])
    assert.ok(
      r.lifts[i] >= rhoG * V(lo) && r.lifts[i] <= rhoG * V(hi),
      `held ${name} lift ${r.lifts[i]} N against rho g V from ${rhoG * V(lo)} to ${rhoG * V(hi)} N`,
    );
  // The linked floating box: Archimedes' draft 0.1 m, within a quarter cell (where the grid meets the box), half a particle
  // spacing (the surface estimate) and half the bob still left over the averaging window.
  const draftBound = 0.25 * r.stats.cellSize + r.spacing / 2 + r.bob / 2;
  assert.ok(Math.abs(r.draft - 0.1) <= draftBound, `floating box draft ${r.draft} m against 0.1 m (bound ${draftBound})`);
  assert.equal(r.linked, 1, 'forces holds the linked body');
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
      `twin gap ${r.worstPos.toExponential(2)} m, force ${r.gpuForceY?.toFixed(3)} N, lifts ${r.lifts.map((x) => x.toFixed(2))} N, ` +
      `draft ${r.draft.toFixed(4)} m (bob ${r.bob.toFixed(4)}), pointer ${r.pointerVz.toFixed(2)} m/s, ` +
      `lit ${r.litFrame1}, moved ${r.movedPixels}, speed ${r.speedDiff}, lines ${r.linesDiff}`,
  );
} finally {
  await context.close();
}
