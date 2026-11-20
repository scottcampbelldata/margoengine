import test from 'node:test';
import assert from 'node:assert/strict';
import { engine } from '../../../tests/support/review56-engine.js';
import { Terrain } from '../dist/index.js';

// KB-RESTORE-BORROWED1 (docs/conventions.md, "Borrowed GPU objects"): TerrainTextures is never a plain option. Terrain
// takes it only from `textures(device)`, the function form of rule 2, called once per device, so after a device restore
// the terrain binds textures made on the new device and frees the ones it had. The registry exempts its fields on this.
test('a device restore calls the textures factory again with the new device and frees the old textures', async (t) => {
  const e = await engine(t),
    gpu = e.gpu;
  // The pieces of a device the shared fake leaves out, as the scene-owner tests add them.
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  Object.assign(gpu.limits, { maxTextureArrayLayers: 256, maxStorageBufferBindingSize: 2 ** 27 });
  gpu.createBindGroupLayout = () => ({});
  gpu.createPipelineLayout = () => ({});
  gpu.createComputePipeline = () => ({ getBindGroupLayout: () => ({}) });
  const layers = Array.from({ length: 4 }, () => ({ height: [-1, 1], slope: [0, 1], scale: 1 })),
    devices = [],
    made = [];
  const textures = (device) => {
    devices.push(device);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      set = {
        heightmap: device.createTexture({ size: [2, 2], format: 'r32float', usage }),
        layers: device.createTexture({ size: [1, 1, 4], format: 'rgba8unorm', usage }),
        weights: [0, 1].map(() => device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage })),
        holes: device.createTexture({ size: [2, 2], format: 'r8unorm', usage }),
      };
    for (const texture of [set.heightmap, set.layers, ...set.weights, set.holes]) {
      Object.assign(texture, { device, dimension: '2d', sampleCount: 1 });
      texture.destroy = () => (texture.destroyed = true);
      made.push(texture);
    }
    return set;
  };
  const terrain = Terrain.attach(e, { resolution: 8, levels: 1, size: [2, 2], layers, textures }),
    first = { heightmap: terrain.heightmap, weights: terrain.weights, holes: terrain.holes };
  assert.equal(devices.length, 1);
  assert.equal(devices[0], e.gpu);
  // The next device is a new object, as a real restore gives.
  const old = e.gpu;
  navigator.gpu.requestAdapter = async () => ({ features: new Set(), requestDevice: async () => ({ ...old }) });
  await e.rebootDevice();
  assert.notEqual(e.gpu, old, 'the restore gave a new device');
  assert.equal(devices.length, 2, 'the factory is called once per device');
  assert.equal(devices[1], e.gpu);
  assert.equal(terrain.heightmap.device, e.gpu);
  assert.equal(terrain.holes.device, e.gpu);
  assert.ok(terrain.weights.every((texture) => texture.device === e.gpu));
  assert.notEqual(terrain.heightmap, first.heightmap);
  for (const texture of [first.heightmap, ...first.weights, first.holes]) assert.ok(texture.destroyed, 'old texture freed');
  terrain.dispose();
});
