// Real-adapter CPU/GPU agreement for @margoengine/shader/noise (run from the repository root after building packages, under
// the GPU lock): node scripts/gpu-lock.mjs run --owner=<id> -- node packages/shader/test/noise-check.mjs
// 4096 positions per field; the GPU computes in f32, the CPU twins in f64, so values agree to float rounding, not bits.
import assert from 'node:assert/strict';
import {openBrowser} from '../../../scripts/browser.js';
// Absolute error bounds per field (values span about [-1, 1]): the 99.9th percentile, and the maximum. Fractal sums reach
// coordinates near 640, where an f32 coordinate step is 6e-5, so they get looser bounds. The simplex kernel is seamless
// (radius^2 0.5), so a point within f32 rounding of a simplex face lands on either side with the same value; the old 0.6
// kernel of simplex-noise measured a 2.7e-3 jump at a lattice point here (warp3).
const limits = {simplex2: 1e-4, simplex3: 1e-4, perlin3: 1e-4, fbm3: 2e-3, ridged2: 2e-3, warp3: 2e-3, warpFbm2: 2e-3}, seam = 1e-3;
const context = await openBrowser({startPath: '/packages/shader/test/noise-check.html', port: 5211}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, {timeout: 30000});
  const result = await page.evaluate(() => window.run());
  assert.equal(result.error, null); assert.deepEqual(result.errors, []);
  for (const [name, c] of Object.entries(result.cases)) {
    console.log(name.padEnd(9), 'max', c.maxError.toExponential(2), 'p99.9', c.p999.toExponential(2), 'mean', c.meanError.toExponential(2), 'range', c.range.map(v => v.toFixed(3)).join('..'), 'worst at', c.worst?.join(','));
    assert.ok(c.p999 <= limits[name], `${name}: 99.9th percentile error ${c.p999}`);
    assert.ok(c.maxError <= seam, `${name}: max error ${c.maxError} at ${c.worst}`);
    assert.ok(c.range[1] - c.range[0] > 0.3, `${name}: the field is not flat`);
  }
  assert.deepEqual(pageErrors, []); console.log('noise CPU/GPU agreement passed');
} finally {await context.close();}
