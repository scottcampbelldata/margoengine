// Real-GPU checks of @margoengine/materials/curve-flow (curve-flow.html draws, this judges): a mesh bent in the vertex
// shader matches the same mesh bent by CurveFlow.deform on the CPU, lit and as normals, along x and z, open and closed,
// with a live offset, fit and a swapped curve; on WebGPU and then on the WebGL2 compatibility layer. From the root:
//   node packages/materials/test/curve-flow-browser.mjs            (both backends)
//   MARGO_COMPAT=1 node packages/materials/test/curve-flow-browser.mjs   (the compatibility layer only)
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

// Edge pixels may land on either side of a rasterised silhouette (float32 on the GPU, float64 on the CPU).
const same = (r, label) => {
  assert.ok(r.covered > 1000, `${label}: the mesh covers ${r.covered} pixels`);
  assert.ok(r.differ <= r.covered * 0.01, `${label}: ${r.differ} of ${r.covered} pixels differ`);
};
for (const compat of compatRun() ? [true] : [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/materials/test/curve-flow.html', port: 'free', compat }),
    { page } = browser,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
  const check = (name, ...args) => page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
  const leg = compat ? 'compat' : 'webgpu';
  try {
    await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
    for (const [axis, kind, closed] of [
      ['x', 'pbr', false],
      ['z', 'pbr', false],
      ['x', 'normal', false],
      ['x', 'normal', true],
    ]) {
      const r = await check('bend', axis, kind, closed),
        label = `${leg} ${axis} ${kind}${closed ? ' closed' : ''}`;
      console.log(label, JSON.stringify(r));
      assert.deepEqual(r.errors, []);
      same(r.first, `${label} GPU bend matches the CPU bend`);
      same(r.live, `${label} a live offset matches the CPU bend at the new offset`);
      assert.ok(r.moved.differ > 1000, `${label}: the offset moves the mesh (${r.moved.differ} pixels changed)`);
    }
    const r = await check('fitAndSwap');
    console.log(leg, 'fit and swap', JSON.stringify(r));
    assert.deepEqual(r.errors, []);
    same(r.fit, `${leg} fit matches CurveFlow.deform fit`);
    same(r.swap, `${leg} setFlow bends along the new curve`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
}
console.log('Curve flow: GPU bend matches the CPU bend (x, z, lit, normals, closed, live offset, fit, setFlow).');
