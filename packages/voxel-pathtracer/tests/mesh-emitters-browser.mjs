// FG-17-EMITTERS on the GPU, native WebGPU and the WebGL2 layer, MeshPathTracer and composed: moving and deforming
// mesh emitters are sampled at the path's own time. T1 matches a float64 polygon-irradiance oracle over the shutter,
// T2 keeps shutter 0 (and equal previous fields) bit for bit equal to the still scene, T3 matches a path-only
// reference in energy at under a quarter of its variance by work count, T4 has no self-shadow 1,000 units out and stays
// finite when a face flips mid-shutter. Run from the repository root after building packages:
//   node scripts/run-with-timeout.mjs -- node packages/voxel-pathtracer/tests/mesh-emitters-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { legDevice } from '../../../scripts/support/compat-shim.js';
const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');
const report = process.argv.includes('--report');
const rows = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/mesh-emitters.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate(([c, o]) => window.run(c, o), [compat, only]);
    const device = legDevice(compat, context.hardware);
    console.log(JSON.stringify({ compat, device, result }));
    rows.push({ compat, device, result });
    if (report) continue;
    const route = compat ? ' (WebGL2)' : '';
    assert.deepEqual(errors, []);
    assert.deepEqual(result.errors, []);
    for (const r of [...result.t1, ...result.t4.filter((r) => r.name === 'far origin')]) {
      const label = `${r.name} ${r.kind}${route}`;
      assert.equal(r.finite, true, label);
      assert.ok(r.blocks >= 12, `${label}: ${r.blocks} lit blocks`);
      // The image mean within 3 standard errors of the oracle; each 4x4 block within 5, their spread about 1.
      assert.ok(Math.abs(r.zMean) < 3, `${label}: image mean ${r.mean} against ${r.want}, ${r.zMean.toFixed(2)} sigma`);
      assert.ok(r.zMax < 5, `${label}: worst block ${r.zMax.toFixed(2)} sigma`);
      assert.ok(r.zRms < 1.25, `${label}: block rms ${r.zRms.toFixed(3)} sigma`);
    }
    for (const r of result.t2) {
      const label = `${r.name} ${r.kind}${route}`;
      assert.equal(r.shutter0, true, `${label}: shutter 0 equals the still scene`);
      assert.equal(r.equalFields, true, `${label}: equal previous fields equal the still scene`);
      assert.equal(r.lit, true, `${label}: the lamp lights the floor`);
    }
    for (const r of result.t3) {
      const label = `${r.name} on ${r.floor}${route}`;
      assert.ok(
        Math.abs(r.z) < 3,
        `${label}: NEE ${r.meanNEE} against path-only ${r.meanPath}, ${r.z.toFixed(2)} sigma`,
      );
      // On a Lambert floor light sampling carries the small lamp: under a quarter of path-only's variance at half its
      // samples. A roughness-0.2 metal lobe is far narrower than the lamp, so BSDF sampling carries it and MIS keeps
      // that: still below path-only at half the samples (path hits alone would measure about 2 here).
      const bar = r.floor === 'lambert' ? 0.25 : 1;
      assert.ok(r.varianceRatio < bar, `${label}: variance ratio ${r.varianceRatio.toFixed(3)} at half the samples`);
    }
    for (const r of result.t4.filter((r) => r.name === 'flips mid-shutter'))
      assert.equal(r.finite, true, `${r.name} ${r.kind}${route}`);
    if (!only) {
      assert.equal(result.t1.length, 8);
      assert.equal(result.t2.length, 12);
      assert.equal(result.t3.length, 4);
      assert.equal(result.t4.length, 4);
    }
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-mesh-emitters.json', JSON.stringify(rows, null, 2));
console.log(report ? 'mesh emitters report written' : 'mesh emitters check passed');
