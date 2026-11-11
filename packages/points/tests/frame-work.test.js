import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointsPlugin, PointCloud, SpriteBatch } from '../dist/index.js';
import { fillFrame } from '../src/frame.ts';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

test('frame uniforms queue identical bytes only once, including alternating views and resource rebuilds', () => {
  const gpu = mockGPU(),
    plugin = new PointsPlugin();
  const camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] });
  camera.update(1, true);
  const engine = { backend: 'webgpu', gpu: gpu.device, sceneOf() {} };
  gpu.record(() => plugin.setup(engine));
  plugin.add(new PointCloud({ positions: [0, 0, 0], material: { size: 4 } }));
  plugin.add(new SpriteBatch({ sprites: [{ position: [1, 0, 0] }] }));
  const view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView();
  const context = {
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
  const run = passes(plugin),
    frame = () => gpu.record(() => run(context));
  const writes = (log) => log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 144 * 2);
  const check = () => {
    const log = frame(),
      uploaded = writes(log);
    assert.equal(uploaded.length, 1);
    const expected = new Float32Array(36);
    fillFrame(expected, new Float32Array(16), camera, context.width, context.height, context.format);
    assert.equal(uploaded[0][3], Buffer.from(expected.buffer).toString('hex'), 'uncached reference bytes');
    return log;
  };
  check();
  const repeated = frame();
  assert.equal(writes(repeated).length, 0);
  assert.equal(repeated.filter((e) => e[0] === 'pass.draw').length, 2, 'both surfaces still draw');
  // Force the old unconditional upload as a negative control; all rendering commands stay byte identical.
  plugin.frameValid = false;
  const uncached = check();
  assert.deepEqual(
    uncached.filter((e) => e[0] !== 'writeBuffer'),
    repeated,
  );
  for (let i = 0; i < 100; i++) assert.equal(writes(frame()).length, 0);
  for (const width of [32, 64, 32, 64]) {
    context.width = width;
    check();
    assert.equal(writes(frame()).length, 0);
  }
  context.format = 'rgba8unorm-srgb';
  check();
  camera.position[0] = 2;
  camera.update(1, true);
  check();
  gpu.record(() => plugin.onDeviceRestored(engine));
  check();
  assert.equal(writes(frame()).length, 0, 'restored buffer has its own uploaded snapshot');
  plugin.dispose();
});
