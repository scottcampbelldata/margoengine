// KB-COMPAT-READY1: on the WebGL2 layer CulledMeshes, CulledInstances and DynamicInstances take their CPU route once
// ./compat.js has loaded by import(); frames before it ran the WebGPU kernels on the layer, and nothing told a caller
// when the frames stopped changing. Each class's ready settles once its route is in place, and at once on WebGPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { CulledInstances, CulledMeshes } from '../dist/index.js';
import { DynamicInstances } from '../dist/dynamic.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const pending = Symbol('pending');
const state = (plugin) => Promise.race([plugin.ready, Promise.resolve(pending)]);
const harness = (vendor) => {
  const h = optionalGPU();
  h.engine.gpu.adapterInfo = { vendor };
  h.engine.canvas = { clientWidth: 64, width: 64, height: 64 };
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  h.engine.retain = () => {};
  h.engine.release = () => {};
  return h;
};
const at = (x) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
const plugins = {
  CulledMeshes: () => new CulledMeshes(),
  CulledInstances: () => new CulledInstances([{ geometry: box(), material: new PbrMaterial(), transforms: at(0) }]),
  DynamicInstances: () => new DynamicInstances({ geometry: box(), material: new PbrMaterial(), capacity: 16 }),
};

for (const [name, make] of Object.entries(plugins)) {
  test(`${name}.ready is settled at once on WebGPU`, async () => {
    const h = harness('nvidia'),
      plugin = make();
    h.engine.use(plugin);
    assert.notEqual(await state(plugin), pending);
    assert.equal(plugin['route'], undefined, 'no route on WebGPU');
    plugin.dispose();
  });

  test(`on the WebGL2 layer ${name}.ready waits for the route and settles with it in place`, async () => {
    const h = harness('margo-webgl2'),
      plugin = make();
    h.engine.use(plugin);
    assert.equal(await state(plugin), pending, 'ready waits for the route');
    await plugin.ready;
    assert.ok(plugin['route'], 'the route draws from the first frame after ready');
    plugin.dispose();
  });
}

test('DynamicInstances.ready waits again for the route after a device restore on the WebGL2 layer', async () => {
  const h = harness('margo-webgl2'),
    plugin = plugins.DynamicInstances();
  h.engine.use(plugin);
  await plugin.ready;
  plugin.onDeviceRestored(h.engine);
  assert.equal(plugin['route'], undefined, 'the restore drops the old route');
  await plugin.ready;
  assert.ok(plugin['route'], 'and ready settles with the new one in place');
  plugin.dispose();
});
