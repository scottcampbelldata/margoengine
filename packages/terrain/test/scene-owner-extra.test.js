import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { Terrain, TerrainHeightmap, TerrainColors } from '../dist/index.js';
import { TerrainBlend } from '../dist/blend.js';
import { TerrainStream } from '../dist/stream.js';
import { TerrainSculpt } from '../dist/sculpt.js';
import { PlanetTerrain } from '../dist/planet.js';
import { TerrainVirtualTexture } from '../dist/rvt.js';

const layers = Array.from({ length: 4 }, () => ({ height: [-1, 1], slope: [0, 1], scale: 1 }));
const textures = (device) => ({
  heightmap: device.createTexture({
    size: [2, 2],
    format: 'r32float',
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST,
  }),
  layers: device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING }),
});
const ground = (e) => Terrain.attach(e, { resolution: 8, levels: 1, size: [2, 2], layers, textures });
const factories = {
  terrain: ground,
  heightmap: (e) => TerrainHeightmap.attach(e, () => 0, { size: [2, 2], resolution: 2 }),
  colors: (e) =>
    TerrainColors.attach(e, e.createMesh(), {
      sand: [1, 1, 1],
      meadow: [
        [0, 1, 0],
        [0, 0.5, 0],
      ],
      stone: [0.5, 0.5, 0.5],
      shore: [0, 1],
      meadowHeight: [1, 2],
      stoneHeight: [2, 3],
      stoneNormal: [0, 1],
      wetHeight: [0, 1],
      wetDarkening: 0.5,
    }),
  blend: (e) => {
    const terrain = ground(e);
    const rvt = TerrainVirtualTexture.attach(e, terrain, { size: 256, levels: 1 });
    return TerrainBlend.attach(e, terrain, rvt);
  },
  stream: (e) =>
    TerrainStream.attach(e, {
      resolution: 8,
      levels: 1,
      layers,
      tileSize: 2,
      tileTexels: 2,
      window: 2,
      load: async () => null,
      colors: (device) => textures(device).layers,
    }),
  sculpt: (e) => TerrainSculpt.attach(e, ground(e)),
  planet: (e) => PlanetTerrain.attach(e, { resolution: 8, maxPatches: 6 }),
};

for (const [label, make] of Object.entries(factories))
  for (const remove of [false, true])
    test(`Terrain ${label} ${remove ? 'owner removal' : 'direct disposal'} preserves scene identities`, async (t) => {
      const e = await engine(t),
        owner = e.createScene('terrain-owner'),
        gpu = e.gpu;
      Object.assign(gpu.limits, { maxTextureArrayLayers: 256, maxStorageBufferBindingSize: 2 ** 27 });
      globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
      const mapMode = Object.getOwnPropertyDescriptor(globalThis, 'GPUMapMode');
      globalThis.GPUMapMode = { READ: 1 };
      t.after(() =>
        mapMode ? Object.defineProperty(globalThis, 'GPUMapMode', mapMode) : delete globalThis.GPUMapMode,
      );
      gpu.createBindGroupLayout = () => ({});
      gpu.createPipelineLayout = () => ({});
      gpu.createComputePipeline = () => ({ getBindGroupLayout: () => ({}) });
      const createTexture = gpu.createTexture;
      gpu.createTexture = (d) => createTexture({ dimension: '2d', sampleCount: 1, ...d });
      const createBuffer = gpu.createBuffer;
      gpu.createBuffer = (d) =>
        Object.assign(createBuffer(d), {
          async mapAsync() {},
          getMappedRange: () => new ArrayBuffer(d.size),
        });
      const createEncoder = gpu.createCommandEncoder;
      gpu.createCommandEncoder = () => ({ ...createEncoder(), copyTextureToBuffer() {} });
      const use = e.use.bind(e);
      e.use = (plugin) => use(plugin, owner);
      let effect;
      try {
        effect = await make(e);
      } finally {
        e.use = use;
      }
      const registered = [...owner.plugins.values()];
      let primaryDisposals = 0;
      const sentinels = registered.map(({ name }) => ({
        name,
        setup() {},
        dispose() {
          primaryDisposals++;
        },
      }));
      sentinels.forEach((plugin) => e.use(plugin));
      for (const plugin of registered) plugin.onDeviceRestored?.(e);
      assert.equal(e.sceneOf(effect) === owner, true, 'restore lost registration');
      const owned = effect.terrain && label === 'stream' ? [effect, effect.terrain] : [effect];
      const borrowed = registered.filter((plugin) => !owned.includes(plugin));
      if (remove) owner.removePlugin(effect.name);
      else effect.dispose();
      effect.dispose();
      for (const plugin of owned) {
        assert.equal(e.sceneOf(plugin) === undefined, true, `${plugin.name} retains scene ownership`);
        assert.equal(owner.plugins.has(plugin.name), false);
      }
      assert.equal(primaryDisposals, 0, 'disposed a default scene plugin');
      for (const plugin of sentinels) assert.equal(e.scene.plugins.get(plugin.name) === plugin, true);
      for (const plugin of borrowed)
        assert.equal(owner.plugins.get(plugin.name) === plugin, true, 'disposed a borrowed plugin');
      const replacement = { name: effect.name, setup() {}, dispose() {} };
      owner.use(replacement);
      effect.dispose();
      assert.equal(owner.plugins.get(effect.name) === replacement, true, 'stale disposal removed replacement');
      owner.removePlugin(replacement.name);
    });
