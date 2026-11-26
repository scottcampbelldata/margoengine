// GPU check of @margoengine/voxel-pathtracer/from-engine on WebGPU and the WebGL2 compatibility layer: the raster
// silhouette of core meshes against the traced one, then a drawn Terrain with a hole against its
// traced height query, then a GPU Scatter on sloped ground read back by readScatter against its traced instances,
// then a windy field read back posed (FG-17-WIND) against the drawn, bent one.
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
    const s = await context.page.evaluate((compat) => window.runScatter(compat), compat);
    console.log(JSON.stringify({ compat, scatter: s }));
    assert.deepEqual(errors, []);
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.rings, [40, 0, 0], 'every instance in the near ring');
    assert.ok(s.tilt > 0.1, `instances lean with the ground (${s.tilt})`);
    assert.ok(s.fadeRings[0] > 0 && s.fadeRings[1] > 0, `the split field fills two rings (${s.fadeRings})`);
    assert.ok(s.drawn > 40, `some instances are drawn in two rings (${s.drawn} draws)`);
    assert.equal(s.fadeRings[0] + s.fadeRings[1] + s.fadeRings[2], 40, 'an instance in the fade band is read once');
    assert.ok(s.covered > 1500, `the scatter covers the view (${s.covered} px)`);
    assert.ok(s.iou > 0.99, `drawn and traced scatter silhouettes agree: IoU ${s.iou}`);
    const w = await context.page.evaluate((compat) => window.runWind(compat), compat);
    console.log(JSON.stringify({ compat, wind: w }));
    assert.deepEqual(errors, []);
    assert.deepEqual(w.errors, []);
    assert.ok(w.count > 20, `the windy field is in view (${w.count} instances)`);
    assert.equal(w.positions, w.count * w.verts * 3, 'one posed copy of the ring mesh an instance');
    assert.equal(w.indices, w.count * w.meshIndices, 'the ring mesh triangles for every instance');
    assert.ok(w.rigidPosed, 'no posed vertices without pose: true');
    assert.equal(w.posed.meshes, 1, 'a posed ring traces as one world mesh');
    assert.equal(w.posed.instances, 1, 'placed once, in world space');
    assert.ok(w.posed.covered > 800, `the bent field covers the view (${w.posed.covered} px)`);
    assert.ok(w.posed.iou > 0.99, `drawn and traced bent field agree: IoU ${w.posed.iou}`);
    assert.ok(
      w.rigid.iou < w.posed.iou - 0.03,
      `the rigid read misses the bend (IoU ${w.rigid.iou} against ${w.posed.iou})`,
    );
    assert.ok(w.open.matched > 20, `instances found again a frame later (${w.open.matched})`);
    assert.ok(w.open.moved > 0.01, `the wind moved the plants between the frames (${w.open.moved} m)`);
    assert.equal(w.open.worst, 0, 'the shutter-open pose is the frame before pose, bit for bit');
    assert.equal(w.still, 0, 'on the first frame the shutter-open pose is the pose');
    assert.ok(w.grass.count > 0 && w.grass.positions === w.grass.count * w.grass.verts * 3, 'grass blades posed');
    assert.ok(w.grass.finite, 'posed grass is finite');
    assert.ok(w.grass.unit < 1e-3, `posed grass normals are unit (${w.grass.unit})`);
    assert.ok(w.grass.top > 0.05, `posed blades stand up (${w.grass.top} m)`);
    assert.ok(
      w.trampled.count > 0 && w.trampled.positions === w.trampled.count * w.trampled.verts * 3,
      'a trampled scatter poses through its own patch',
    );
    rows.push({ compat, device, hardware: context.hardware, r, terrain: t, scatter: s, wind: w });
  } finally {
    await context.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/voxel-pathtracer-from-engine.json', JSON.stringify(rows, null, 2));
console.log('voxel-pathtracer from-engine: native and compat passed');
