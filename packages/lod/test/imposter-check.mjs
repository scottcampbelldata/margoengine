// Real-adapter check (from the repository root after building packages; hold the GPU lock): node packages/lod/test/imposter-check.mjs [label]
// 1. Imposter picking: GPU Picking and the bvh Raycaster hit imposter-level objects through their bounding sphere.
// 2. Atlas seams: rotate around an imposter in 0.5 degree steps and compare per-step change with a full-detail reference.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { expectedContextLosses, watchConsole } from '../../../scripts/support/browser-advisories.mjs';
const label = process.argv[2] ?? 'current',
  context = await openBrowser({ startPath: '/packages/lod/test/imposter-check.html', port: 5221 }),
  { page, hardware } = context,
  // Every warning fails but Firefox's final-row advisory (KBL3c, exact line, versions seen); Firefox's report of the
  // layer probe's deliberate context loss is counted instead (scripts/support/browser-advisories.mjs).
  watch = watchConsole(page, hardware),
  pageErrors = watch.problems;
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const results = { label, adapter: hardware.webgpu, browser: hardware.browserVersion, sweeps: [] };
  console.log('adapter', JSON.stringify(hardware.webgpu));
  const picking = await page.evaluate(() => window.check.picking());
  results.picking = picking;
  console.log('picking', JSON.stringify(picking));
  assert.deepEqual(picking.levels, [0, 0, 0, 1, 1, 1], 'near anchors full detail, far anchors imposters');
  assert.ok(
    picking.imposterPixels > 100 &&
      picking.imposterGpu === picking.imposterPixels &&
      picking.imposterCpu === picking.imposterPixels,
    'every imposter pixel picks its anchor, approximate',
  );
  assert.ok(
    picking.fullPixels > 100 && picking.fullCpu === picking.fullPixels && picking.fullGpu === picking.fullPixels,
    'full-detail pixels stay exact',
  );
  assert.ok(picking.agree / picking.grid > 0.99 && picking.background > picking.grid / 2, 'GPU and CPU picking agree');
  results.bleed = [];
  for (const shape of ['knot', 'disc']) {
    const rows = await page.evaluate((s) => window.check.bleed({ shape: s }), shape);
    results.bleed.push(...rows);
    for (const r of rows) console.log('bleed', JSON.stringify(r));
  }
  assert.ok(
    results.bleed.filter((r) => r.rule === 'new').every((r) => r.maxBleed === 0),
    'the clamp keeps every mip level inside its view',
  );
  // Large card (mip 0) at three elevations, including the folded lower hemisphere; then smaller cards that sample coarse mips.
  const runs = [
    { distance: 12, pitch: 20 },
    { distance: 12, pitch: -25 },
    { distance: 12, pitch: 60 },
    { shape: 'disc', distance: 12, pitch: 20 },
    { distance: 40, pitch: 20, step: 1 },
    { distance: 80, pitch: 20, step: 1 },
    { shape: 'disc', distance: 40, pitch: 20, step: 1 },
    { shape: 'disc', distance: 80, pitch: 20, step: 1 },
  ];
  for (const run of runs) {
    const { summary, series } = await page.evaluate((r) => window.check.sweep(r), run);
    results.sweeps.push({ summary, series });
    console.log('sweep', JSON.stringify(summary));
    // Before the fix (hard 0.5 coverage cut, no parallax step) the knot's largest step was 7.8-10x its median and the disc's 48/255.
    if (summary.shape === 'knot')
      assert.ok(
        summary.snapRatio < 4 && summary.errMean < 21,
        'knot rotates without snapping: ' + JSON.stringify(summary),
      );
    else assert.ok(summary.impStep.max < 20, 'disc rotates without snapping: ' + JSON.stringify(summary));
  }
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  assert.deepEqual(pageErrors, []);
  assert.equal(watch.lost, expectedContextLosses(hardware), 'deliberate WebGL context losses');
  await writeFile(`test-results/imposter-check-${label}.json`, JSON.stringify(results));
  console.log('imposter check finished');
} finally {
  await context.close();
}
