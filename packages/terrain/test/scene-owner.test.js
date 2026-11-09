import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { TerrainMaterials } from '../dist/layers-pbr.js';
import { TerrainDisplacement } from '../dist/displace.js';
import { TerrainVirtualTexture } from '../dist/rvt.js';
import { TerrainDeformation } from '../dist/deform.js';

for (const [label, Type] of [
  ['materials', TerrainMaterials],
  ['displacement', TerrainDisplacement],
  ['virtual texture', TerrainVirtualTexture],
  ['deformation', TerrainDeformation],
])
  for (const remove of [false, true])
    test(`Terrain ${label} ${remove ? 'owner removal' : 'direct disposal'} detaches by plugin identity`, async (t) => {
      const e = await engine(t),
        owner = e.createScene('terrain-owner'),
        gpu = e.gpu;
      Object.assign(gpu.limits, { maxTextureArrayLayers: 256, maxStorageBufferBindingSize: 2 ** 27 });
      gpu.createBindGroupLayout = () => ({});
      gpu.createPipelineLayout = () => ({});
      gpu.createComputePipeline = () => ({ getBindGroupLayout: () => ({}) });
      let providers = 0,
        primaryDisposals = 0;
      const terrain = {
        options: { layers: [{}] },
        addLighting() {
          providers++;
          return () => {
            providers--;
          };
        },
      };
      const textures = (device) => {
        const make = () =>
          device.createTexture({
            size: [1, 1, 1],
            dimension: '2d',
            format: 'rgba8unorm',
            sampleCount: 1,
            usage: GPUTextureUsage.TEXTURE_BINDING,
          });
        return { normals: make(), surface: make() };
      };
      let effect;
      // Exercise public attach factories while routing their use() into the real secondary scene.
      const use = e.use.bind(e);
      e.use = (plugin) => use(plugin, owner);
      try {
        if (Type === TerrainMaterials) effect = Type.attach(e, terrain, { textures });
        if (Type === TerrainDisplacement)
          effect = Type.attach(e, terrain, { bindings() {}, surface: {} }, { shadows: false });
        if (Type === TerrainVirtualTexture) effect = Type.attach(e, terrain, { size: 256, levels: 1 });
        if (Type === TerrainDeformation) effect = Type.attach(e, terrain, { size: 64 });
      } finally {
        e.use = use;
      }
      const primary = {
        name: effect.name,
        setup() {},
        dispose() {
          primaryDisposals++;
        },
      };
      e.use(primary);
      effect.onDeviceRestored(e);
      assert.equal(providers, 1, 'restore duplicated or removed the terrain provider');
      if (remove) owner.removePlugin(effect.name);
      else effect.dispose();
      effect.dispose();
      assert.equal(e.sceneOf(effect) === undefined, true, 'disposed plugin retains its scene');
      assert.equal(owner.plugins.size, 0);
      assert.equal(providers, 0);
      assert.equal(primaryDisposals, 0, 'disposed the default scene plugin');
      assert.equal(e.scene.plugins.get(primary.name) === primary, true);
      const replacement = { name: effect.name, setup() {}, dispose() {} };
      owner.use(replacement);
      owner.removePlugin(replacement.name);
    });
