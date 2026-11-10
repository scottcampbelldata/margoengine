// ./gpu without a GPU: argument checks run before any device work. The bake itself runs in tests/gpu.browser.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bakeMeshLightmapGPU, GPULightmapBaker } from '../dist/gpu.js';

const floor = {
  positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, -4, 0, 0, -4]),
  uv1: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const device = { createComputePipeline() {} };

test('the GPU baker names what it needs before touching the device', async () => {
  await assert.rejects(GPULightmapBaker.create(null, floor), /needs a GPUDevice/);
  await assert.rejects(GPULightmapBaker.create({ gpu: null }, floor), TypeError);
  await assert.rejects(GPULightmapBaker.create(device, floor, { bounces: 1 }), /radiometry 'physical'/);
  await assert.rejects(GPULightmapBaker.create(device, floor, { bounces: 9, radiometry: 'physical' }), RangeError);
  await assert.rejects(GPULightmapBaker.create(device, floor, { albedo: [2, 0, 0] }), /0 to 1/);
  await assert.rejects(GPULightmapBaker.create(device, { ...floor, uv1: new Float32Array(8).fill(2) }), /0 to 1/);
  await assert.rejects(
    GPULightmapBaker.create(device, floor, { lights: [{ type: 'spot', position: [0, 1, 0], direction: [0, -1, 0] }] }),
    /spot light needs an angle/,
  );
  await assert.rejects(bakeMeshLightmapGPU(device, floor, { passes: 0 }), RangeError);
});
