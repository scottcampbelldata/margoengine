import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointsPlugin, PointCloud } from '../dist/index.js';
import { SurfelPlugin } from '../dist/surfels.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

// Every per-point buffer is one storage binding. Float colours take 16 B a point, more than the 12 B positions, so a
// cloud whose positions fit can still have colours over the binding: that must be a RangeError naming the real
// ceiling before any buffer is made, not a WebGPU validation error at createBuffer (the old check counted 12 B only).
const frame = (Plugin, cloud, limit) => {
  const gpu = mockGPU();
  gpu.device.limits.maxStorageBufferBindingSize = limit;
  const plugin = new Plugin(),
    engine = { backend: 'webgpu', gpu: gpu.device },
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] });
  camera.update(1, true);
  gpu.record(() => plugin.setup(engine));
  plugin.add(cloud);
  const view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView(),
    context = {
      backend: 'webgpu',
      device: gpu.device,
      encoder: gpu.encoder,
      camera,
      width: 64,
      height: 64,
      format: 'rgba8unorm',
      color: view,
      depth: view,
      descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
    };
  try {
    const log = gpu.record(() => passes(plugin)(context));
    return log.filter((e) => e[0] === 'createBuffer').map((e) => e[1]?.size ?? e[2]?.size);
  } finally {
    plugin.dispose();
  }
};
const cloud = (count, colorFormat, extra = {}) =>
  new PointCloud({
    positions: new Float32Array(count * 3).map((_, i) => (i % 3) * 0.01),
    colors: new Float32Array(count * 4).fill(0.5),
    colorFormat,
    ...extra,
  });

for (const Plugin of [PointsPlugin, SurfelPlugin])
  test(`${Plugin.name}: the widest per-point buffer bounds a cloud, before any buffer is made`, () => {
    // 120 points: positions 1,440 B fit 1,600 B; float colours 1,920 B do not.
    assert.throws(
      () => frame(Plugin, cloud(120, 'float'), 1600),
      (e) =>
        e instanceof RangeError && /storage limit of 100 points at 16 bytes a point/.test(e.message) && /rgba8/.test(e.message),
    );
    assert.doesNotThrow(() => frame(Plugin, cloud(120, 'rgba8'), 1600), '120 rgba8 points fit');
    assert.doesNotThrow(() => frame(Plugin, cloud(100, 'float'), 1600), '100 float points fit exactly');
    assert.throws(() => frame(Plugin, cloud(134, 'rgba8'), 1600), /storage limit of 133 points at 12 bytes a point/);
  });
