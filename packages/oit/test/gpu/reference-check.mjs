// KB3148a: every OIT route against the sorted pane reference of the batch 168 rival comparison (five unlit panes,
// scripts/oit-scene.mjs; docs/whitepaper/perf-vs-rivals.md has the comparison: weighted default MAE 1.568).
// Weighted blended OIT (McGuire and Bavoil, JCGT 2013) is an approximation by design: its colour is a depth-weighted
// average, not the over operator, so it is pinned as the accepted difference it is, within a band around the measured
// MAE. PeelOIT (Everitt 2001) and ExactOIT (per-pixel lists, Yang et al. 2010) composite with the over operator in depth
// order, like the depth peeling it was compared with: they are the like-for-like rows and must match the reference within the 8-bit
// rounding of the readback. The core's per-mesh sort is exact for these separate panes too.
// From the repository root, after building packages:
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/oit/test/gpu/reference-check.mjs
// With MARGO_COMPAT=1 it runs on the WebGL2 compatibility layer, where ExactOIT refuses by design (no fragment storage).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { compatRun } from '../../../../scripts/support/compat-shim.js';

const browser = await openBrowser({ startPath: '/packages/oit/test/gpu/reference.html', port: 'free' });
const { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  const rows = {},
    compat = compatRun(),
    exact = compat ? [] : ['exact'];
  for (const mode of ['sorted', 'peel', ...exact, 'weighted']) {
    const result = await page.evaluate((m) => window.check.render(m), mode);
    assert.deepEqual(result.size, [1280, 720], `${mode} reads back the scene size`);
    rows[mode] = { mae: result.error.mae, psnr: result.error.psnr, max: result.error.max, center: result.center };
    rows[mode].byLayers = result.error.byLayers.map((r) => [r.layers, +r.mae.toFixed(4)]);
  }
  console.log('oit reference', JSON.stringify(rows));
  // Exact routes: below MAE 0.133 (the compared depth peeling measured 0.048 on another run), and no pixel more than a few levels from the reference.
  for (const mode of ['sorted', 'peel', ...exact]) {
    assert.ok(rows[mode].mae < 0.133, `${mode} matches the over operator in depth order: MAE ${rows[mode].mae}`);
    assert.ok(rows[mode].max <= 4, `${mode} has no pixel over 4 levels off: ${rows[mode].max}`);
  }
  // The weighted default: the measured approximation (1.568 on 2026-11-09), pinned within 25 % either way, so a
  // change to its weights or resolve shows here; background pixels stay exact.
  assert.ok(rows.weighted.mae > 1.18 && rows.weighted.mae < 1.96, `weighted MAE ${rows.weighted.mae}`);
  assert.equal(rows.weighted.byLayers.find(([n]) => n === 0)[1], 0, 'the empty background is untouched');
  assert.deepEqual(await page.evaluate(() => window.check.errors), []);
  assert.deepEqual(errors, []);
  console.log('oit reference check passed');
} finally {
  // fixed-wait: a bounded close, so a browser that hangs while closing cannot hold the GPU slot past 15 s
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 15000).unref())]);
}
