// Real-GPU check for @margoengine/culling's CulledMeshes on regular core meshes (HANDOFF 5m.b): engine A draws through
// the GPU culler (core's CPU culling off), engine B is plain core drawing every part; every step's frames must be identical, the culler must
// actually drop parts in partial views, and engine.pick, FeatureEdges, ExplodedView and AssemblyBVH must keep working.
// Run from the repository root after building packages, holding the GPU lock:
//   node examples/package-benchmarks/cad/culled-meshes.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

// --edges also attaches FeatureEdges to both engines. Its compute pass appends visible parts with atomics, so its line
// order (and the blending of overlapping antialiased lines) varies from run to run. Lines of parts between minRadius and twice
// that fade in with alpha below 1, which makes the blend more order-dependent: with --edges channels may differ by up to 3
// (a missing or extra line would differ by about 100).
const edges = process.argv.includes('--edges');

const context = await openBrowser({
    startPath: '/examples/package-benchmarks/cad/culled-meshes.html' + (edges ? '?edges' : ''),
    port: 5221,
  }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const shot = async (id) => decodePNG(await page.locator(`#${id}`).screenshot());
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const setup = await page.evaluate(() => window.check.setup());
  console.log('setup', JSON.stringify(setup));
  assert.ok(setup.capacity > 64, 'store grew while building');
  const steps = await page.evaluate(() => window.check.steps);
  let partial = 0;
  for (let i = 0; i < steps; i++) {
    const r = await page.evaluate((n) => window.check.step(n), i),
      [a, b] = [await shot('a'), await shot('b')];
    let differing = 0,
      lit = 0,
      delta = 0;
    for (let k = 0; k < a.data.length; k += 4) {
      if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2]) differing++;
      for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(a.data[k + c] - b.data[k + c]));
      if (a.data[k] + a.data[k + 1] + a.data[k + 2] > 120) lit++;
    }
    if (differing) {
      const at = [];
      for (let k = 0; k < a.data.length && at.length < 6; k += 4)
        if (a.data[k] !== b.data[k] || a.data[k + 1] !== b.data[k + 1] || a.data[k + 2] !== b.data[k + 2])
          at.push([
            (k / 4) % a.width,
            Math.floor(k / 4 / a.width),
            [...a.data.subarray(k, k + 3)],
            [...b.data.subarray(k, k + 3)],
          ]);
      console.log('differing pixels (x, y, culled, core):', JSON.stringify(at));
    }
    console.log(
      `step ${i}: ${r.label}: ${differing} of ${a.data.length / 4} pixels differ (max channel delta ${delta}), ${lit} lit; GPU drew ${r.drawn} of ${r.submitted}, capacity ${r.capacity}`,
    );
    if (edges) assert.ok(delta <= 3, `${r.label}: culled frame differs from core by ${delta}`);
    else assert.equal(differing, 0, `${r.label}: culled frame differs from core`);
    assert.ok(lit > 1500, `${r.label}: scene not visible`);
    assert.ok(r.drawn <= r.submitted, `${r.label}: drawn count out of range`);
    if (r.drawn < r.submitted * 0.5) partial++;
  }
  assert.ok(partial > 0, 'the GPU culler dropped parts in a partial view');
  const picks = await page.evaluate(() => window.check.picks()),
    hits = picks.filter(([p]) => p !== null).length;
  assert.deepEqual(
    picks.map(([p]) => p),
    picks.map(([, q]) => q),
    'engine.pick agrees with plain core',
  );
  assert.ok(hits > 5, `engine.pick hits culled meshes (${hits})`);
  const bvh = await page.evaluate(() => window.check.bvh());
  assert.ok(bvh.hit, 'AssemblyBVH ray hits');
  console.log('picks', hits, 'of', picks.length, 'hit, identical on both engines; AssemblyBVH hit part', bvh.part);
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(pageErrors, []);
  console.log('culled core meshes pixel check passed');
} finally {
  await Promise.race([context.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
