// Real-GPU proof of @margoengine/vfx/flocking: 16,384 boids on WebGPU, or the CPU twin's 1,536 on the WebGL2 layer.
//   node scripts/run-with-timeout.mjs --max=3 -- node packages/vfx/test/flocking-check.mjs
//   node scripts/run-with-timeout.mjs --max=3 -- node packages/vfx/test/flocking-check.mjs --compat
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const port = 5419;
const url = `http://127.0.0.1:${port}/packages/vfx/test/flocking-check.html`;
const context = await openBrowser({ startPath: '/packages/vfx/test/flocking-check.html', port });
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
  // Determinism: 60 steps twice from the seed, and a restore at step 30, give one hash.
  assert.equal(r.hashes[1], r.hashes[0], 'the same steps from the seed give the same state');
  assert.equal(r.hashes[2], r.hashes[0], 'a restored snapshot repeats the same steps');
  // One step against the CPU twin. On the WebGL2 layer the twin is the flock, so they are equal. On WebGPU both run
  // one model in the same order; f32 against f64 arithmetic moves a position by rounding only (|x| <= 14, so
  // a few ulps of 1e-6), and a branch a rounding flips (a neighbour at the edge of a radius) moves a boid by at most
  // 2 * 2.5 * maxForce * dt^2 = 0.0195 m.
  if (r.compat) assert.equal(r.worstPos + r.worstVel, 0);
  else {
    assert.ok(r.worstPos < 0.0195, `worst position gap ${r.worstPos}`);
    assert.ok(r.offPos <= r.count / 100, `${r.offPos} of ${r.count} boids differ by more than 1e-4 m`);
  }
  assert.equal(r.frameSteps, 10, 'each of the 10 frames steps once');
  assert.ok(r.litFrame1 > 200, `boids drawn on frame 1: ${r.litFrame1} px`);
  assert.ok(r.movedPixels > 100, `boids move across frames: ${r.movedPixels} px`);
  assert.equal(r.pausedDiff, 0, 'a paused flock draws the same frame');
  assert.ok(r.inspectDiff > 50, `the inspected boid's overlay draws: ${r.inspectDiff} px`);
  assert.ok(r.velocityDiff > 200, `the velocity lines draw: ${r.velocityDiff} px`);
  assert.equal(r.drawCalls, 1, 'one instanced draw for the whole flock');
  assert.ok(r.fishLit > 200, `fish drawn: ${r.fishLit} px`);
  assert.equal(r.afterDisposeLit, 0, `clean canvas after dispose: ${r.afterDisposeLit} px`);
  console.log(
    `ok flocking (${r.stats.backend}): ${r.count} boids, hash ${r.hashes[0]}, twin gap ${r.worstPos.toExponential(2)} m ` +
      `(${r.offPos} over 1e-4), lit ${r.litFrame1}, moved ${r.movedPixels}, inspect ${r.inspectDiff}, ` +
      `velocity ${r.velocityDiff}, fish ${r.fishLit}`,
  );
} finally {
  await context.close();
}
