// Real-GPU check of BatchedMesh item sorting (GPU bitonic sort of item distances, index scatter) and shared geometry
// (addGeometry once, addInstance per item). batched-sort-check.html draws; this judges. From the repository root:
//   node packages/materials/test/batched-sort-browser.mjs
//   MARGO_COMPAT=1 node packages/materials/test/batched-sort-browser.mjs   (the WebGL2 compatibility layer)
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

const compat = compatRun(),
  browser = await openBrowser({ startPath: '/packages/materials/test/batched-sort-check.html', port: 'free', compat }),
  pageErrors = [];
browser.page.on('pageerror', (e) => pageErrors.push(e.message));
const call = async (name, ...args) => {
  const r = await browser.page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
  assert.equal(r.validation, null);
  assert.deepEqual(r.errors, []);
  return r;
};
const near = (a, b, label, tolerance = 2) =>
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= tolerance), `${label}: ${a} vs ${b}`);
try {
  await browser.page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  for (const z of [6, -6]) {
    const sorted = await call('sorted', z),
      reference = await call('reference', z),
      manual = await call('manual', z);
    console.log(z, JSON.stringify({ sorted, reference, manual }));
    assert.equal(sorted.mode, 'back-to-front', 'a transparent material sorts back to front by default');
    assert.deepEqual(sorted.geometries, { geometries: 1, vertices: 4 }, 'three items store one geometry');
    // Items 0, 1, 2 sit at z = 1, 0, -1: from +z the farthest (2) draws first, from -z item 0 does.
    assert.deepEqual(sorted.order, z > 0 ? [2, 1, 0] : [0, 1, 2], 'the sorted index buffer draws far to near');
    near(sorted.rgb, reference.rgb, `view from z = ${z}: the batch blends as three sorted meshes`);
    // Item order (nearest first from +z) is wrong from the front and already back to front from behind.
    if (z > 0)
      assert.ok(
        manual.rgb.some((v, i) => Math.abs(v - reference.rgb[i]) > 20),
        `manual order blends differently from z = ${z}: ${manual.rgb} vs ${reference.rgb}`,
      );
    else near(manual.rgb, reference.rgb, 'item order from behind is back to front');
  }
  const front = await call('opaqueFrontToBack');
  assert.deepEqual(front.order, [0, 1, 2], 'the engine sort mode is followed live: front to back');
  const removed = await call('removeGeometry');
  assert.equal(removed.count, 0, 'removing the geometry removes its items');
  near(removed.rgb, [0, 0, 0], 'and they draw nothing');
  assert.deepEqual(pageErrors, []);
  console.log(`batched-sort (${compat ? 'webgl2-layer' : 'webgpu'}): back-to-front from both sides, manual, front-to-back, shared geometry passed`);
} finally {
  await browser.close();
}
