// GPU check of @margoengine/voxel-pathtracer/from-engine on WebGPU and the WebGL2 compatibility layer: the raster
// silhouette of core meshes against the traced one, then a drawn Terrain with a hole against its traced height query.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { legDevice } from '../../../scripts/support/compat-shim.js';

const rows = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/from-engine.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const errors = [];
  context.page.on('pageerror', (e) => errors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const r = await context.page.evaluate((compat) => window.run(compat), compat);
    const device = legDevice(compat, context.hardware);
    console.log(JSON.stringify({ compat, device, r }));
    assert.deepEqual(errors, []);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(
      [r.meshes, r.instances, r.materials],
      [3, 4, 2],
      'cube x white, cube x metal, slab x white; the hidden mesh left out',
    );
    assert.ok(r.covered > 2000, `the meshes cover the view (${r.covered} px)`);
    assert.ok(r.iou > 0.99, `raster and traced silhouettes agree: IoU ${r.iou}`);
    const t = await context.page.evaluate((compat) => window.runTerrain(compat), compat);
    console.log(JSON.stringify({ compat, terrain: t }));
    assert.deepEqual(errors, []);
    assert.deepEqual(t.errors, []);
    assert.equal(t.meshes, 1, 'one terrain mesh');
    assert.ok(t.triangles < 32 * 32 * 2, `the hole's cells are left out (${t.triangles} triangles)`);
    assert.ok(t.covered > 3000, `the terrain covers the view (${t.covered} px)`);
    assert.ok(t.iou > 0.99, `drawn and traced terrain silhouettes agree: IoU ${t.iou}`);
    rows.push({ compat, device, hardware: context.hardware, r, terrain: t });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-from-engine.json', JSON.stringify(rows, null, 2));
console.log('voxel-pathtracer from-engine: native and compat passed');
