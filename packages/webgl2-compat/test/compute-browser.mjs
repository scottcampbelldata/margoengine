// Milestone M5 compute check (run by `npm run test:gpu`, part of check:merge): each case of compute.html runs on the
// browser's own WebGPU and on the WebGL2 layer in the same page, on the same GPU, and the two must return the same
// numbers: integers equal, floats within the case's tolerance (1e-6 unless it samples or stores half floats, where the
// two paths' filtering and rounding may differ in the last bits). Neither side may report a validation error, throw,
// or (the layer) a GL error, and each case must run on the tier it was written for. A refusal is checked to be coded.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const TIERS = {
  firstPipeline: 'scatter',
  fragmentStore: 'fragment',
  fragmentLayers: 'fragment',
  fragmentReadWrite: 'fragment',
  fragmentMipViews: 'fragment',
  scatterStructs: 'scatter',
  scatterTargets: 'scatter',
  cpuAtomics: 'cpu',
  cpuLoops: 'cpu',
  cpuSample: 'cpu',
  indirect: 'scatter',
  destroyAfterSubmit: 'scatter',
  cpuCube: 'cpu',
  asyncPipeline: 'scatter',
};

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/compute.html', port: 'free' });
const { page } = context;
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

/** Paths where `a` and `b` differ (floats beyond `tol`), at most 8. */
function differences(a, b, tol, path = '', out = []) {
  if (out.length >= 8) return out;
  if (typeof a === 'number' && typeof b === 'number') {
    const same = Number.isInteger(a) && Number.isInteger(b) ? a === b : Math.abs(a - b) <= tol || (a !== a && b !== b);
    if (!same) out.push(`${path}: native ${a}, compat ${b}`);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} vs ${b.length}`);
    else a.forEach((x, i) => differences(x, b[i], tol, `${path}[${i}]`, out));
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], tol, `${path}.${k}`, out);
    return out;
  }
  if (a !== b) out.push(`${path}: native ${JSON.stringify(a)}, compat ${JSON.stringify(b)}`);
  return out;
}

const lines = [];
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const names = await page.evaluate(() => window.check.names());
  assert.deepEqual(names, Object.keys(TIERS), 'every case has its expected tier');
  for (const name of names) {
    const { native, compat } = await page.evaluate((n) => window.check.run(n), name);
    for (const [side, r] of [
      ['native', native],
      ['compat', compat],
    ]) {
      assert.equal(r.thrown, null, `${name} (${side}) threw`);
      assert.deepEqual(r.errors, [], `${name} (${side}) validation errors`);
      assert.equal(r.gl, 0, `${name} (${side}) GL error`);
    }
    assert.equal(compat.result.tier, TIERS[name], `${name} runs on the ${TIERS[name]} tier`);
    const diff = differences(native.result.values, compat.result.values, compat.result.tolerance ?? 1e-6);
    assert.deepEqual(diff, [], `${name}: compat differs from native`);
    // Each case must test something: all-zero results on both sides fail.
    assert.ok(JSON.stringify(compat.result.values).match(/[1-9]/), `${name} returned only zeros`);
    lines.push(`${name} (${TIERS[name]}): same as native`);
  }
  // Bug 65: a CPU-tier dispatch cannot hold the page for good; it stops at its work budget, coded, memory unchanged.
  const budget = await page.evaluate(() => window.check.budget());
  for (const r of budget.slice(0, 2)) {
    assert.equal(r.tier, 'cpu', r.case);
    assert.equal(r.error?.name, 'GPUInternalError', `${r.case}: ${JSON.stringify(r)}`);
    assert.equal(r.error.code, 'failed', r.case);
    assert.match(
      r.error.message,
      /stopped at its work budget of 20000 invocations and loop iterations.*raise cpuWorkBudget/,
      r.case,
    );
  }
  assert.deepEqual(budget[0].after, [7, 7, 7, 7], 'the endless loop stored nothing');
  assert.deepEqual(budget[1].after, [0, 0, 0, 0], 'the oversized dispatch stored nothing');
  assert.equal(budget[2].error, null, 'a raised budget runs the dispatch');
  assert.equal(budget[2].after[0], 64000, 'every invocation ran');
  lines.push('work budget: an endless loop and 64,000 invocations stop at 20,000, coded, nothing stored');
  const refusal = await page.evaluate(() => window.check.refusal());
  assert.match(
    refusal,
    /^MargoError unsupported: WebGL2 compatibility cannot run textureSampleLevel\(\) on a cube_array texture on the CPU/,
    'a cube array on the CPU tier is refused, coded',
  );
  assert.deepEqual(pageErrors, []);
  console.log(`webgl2-compat compute (WebGL2 layer vs native WebGPU, same GPU):\n  ${lines.join('\n  ')}`);
} finally {
  await context.close();
}
