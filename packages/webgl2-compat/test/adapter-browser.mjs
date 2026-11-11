// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/webgl2-compat/test/adapter-browser.mjs
// Core on a device at compatibility level draws the same frame as at the full level, picks and comes back from a device
// restore at the same level. Package results are the table in docs/limits.md. Results: test-results/compat-adapter.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

// Both feature levels here are native WebGPU, independent of the caller's forced WebGL2 run.
const context = await openBrowser({
    startPath: '/packages/webgl2-compat/test/adapter.html',
    port: 'free',
    compat: false,
  }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const result = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/compat-adapter.json', JSON.stringify({ hardware, result }, null, 1));
  console.log(JSON.stringify(result, null, 1));
  assert.equal(result.fullLimits.core, true, 'the plain device has the full level');
  // WebKit and Firefox (157) have no compatibility level: a request for one gets a full device, which WebGPU allows.
  // Chromium (Edge, Chrome) must give the level. hardware.browserName is the engine the run really launched.
  const level = hardware.browserName === 'webkit' || hardware.browserName === 'firefox';
  assert.equal(result.limits.core, level, 'this device really is at compatibility level');
  assert.equal(result.different, 0, 'the frame is the same at both levels');
  assert.equal(result.pick, true, 'pick finds the mesh');
  assert.equal(result.miss, true, 'pick finds nothing off the mesh');
  assert.deepEqual(result.afterLoss.core, level, 'a restored device stays at compatibility level');
  assert.equal(result.afterLoss.replaced, true);
  assert.ok(result.afterLoss.drew > 60, 'a restored device draws');
  assert.deepEqual(result.coreErrors, []);
  assert.deepEqual(result.levels.errors, []);
  // Each of four depth samples comes through SceneTarget's copy as itself at both levels.
  assert.deepEqual(result.levels.samplesFull, [0.125, 0.25, 0.375, 0.5]);
  assert.deepEqual(result.levels.samples, [0.125, 0.25, 0.375, 0.5]);
  // Shadows draw a real shadow, and the same frame at both levels: the blocker search reads the same depths.
  assert.ok(result.levels.shadowCast.count > 0, 'the box shades the floor');
  assert.equal(result.levels.shadow.count, 0, 'the shadowed frame is the same at both levels');
  // PostStack's multisampled capture is rg11b10ufloat at the level (docs/limits.md): the frame may round apart, by this.
  assert.ok(result.levels.post.largest <= 2, `the post frame stays within 2 of 255, got ${result.levels.post.largest}`);
  // Eye-dome lighting reads each of the four samples by a masked draw per sample, its depth packed into bytes.
  console.log('levels', JSON.stringify({ edl: result.levels.edl, lit: result.levels.edlLit }));
  assert.ok(result.levels.edlLit > 0, 'points reach the frame');
  assert.equal(result.levels.edl.count, 0, 'the eye-dome lit frame is the same at both levels');
  // Sky fog reads each of the four depth samples by a masked draw per sample (no sample_index at the level) and fogs the
  // frame there as the sample_index draw does at the full level. Over PostStack's rg11b10ufloat capture the sky drew
  // as display colour and then was tonemapped again, up to 19 of 255 brighter, until every package took linear HDR
  // from linearHdr (packages/shared/hdr-format.js, bug sweep L3). What is left is the capture's own precision: 6 and 5
  // mantissa bits against rgba16float's 10, so a step of up to 1/32 of the light before the tonemap.
  console.log(
    'fog',
    JSON.stringify({
      sky: result.levels.sky,
      fog: result.levels.fog,
      full: result.levels.fogFullDrawn,
      level: result.levels.fogDrawn,
    }),
  );
  for (const name of ['sky', 'fog'])
    assert.ok(result.levels[name].largest <= 4, `the ${name} frame stays within the capture's rounding, got ${JSON.stringify(result.levels[name])}`);
  assert.ok(result.levels.fogFullDrawn.count > 6000, 'the fog changes the full-level frame');
  assert.ok(result.levels.fogDrawn.count > 6000, 'the fog changes the frame at the level');
  // Surfels at 4x: the level packs the front depth into rgba8unorm and adds the sums in two rg16float targets, the same
  // half floats as the full level's rgba16float, resolved by a masked draw per sample (bug sweep L3; they refused 4x
  // before). What is left is PostStack's rg11b10ufloat capture under them, as on the sky frame: measured at most 4 of
  // 255 (red 3, blue 4) on 2026-11-11, A6000 D3D12.
  console.log('surfels', JSON.stringify({ surfels: result.levels.surfels, bare: result.levels.surfelsBare }));
  assert.ok(result.levels.surfelsBare.count > 3000, 'the surfels reach the frame at the level');
  assert.ok(result.levels.surfels.largest <= 4, `the surfel frame stays within the capture's rounding, got ${JSON.stringify(result.levels.surfels)}`);
  // Each of these runs on the level.
  for (const name of [
    'core alone',
    'virtual shadows soft',
    'materials createMesh',
    'materials createInstancedMesh',
    'shadows',
    'culling',
    'post bloom and tonemap',
    'post bloom alone 4x',
    'sky fog 4x',
    'environment volumetric 4x',
    'water spray 4x',
    'points surfels 4x',
  ])
    assert.match(result.packages[name], /^ok, [1-9]/, name);
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}
