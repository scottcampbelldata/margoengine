import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, settle, simpleScene } from './support.js';

test('denoised viewport accounts for all three guide images before binding its storage buffer', async () => {
  const limit = 1 << 20,
    device = fakeDevice({ maxStorageBufferBindingSize: limit }),
    h = fakeEngine(device);
  h.context.width = 512;
  h.context.height = 512;
  const tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), denoise: true, samplesPerFrame: 1 });
  await tracer.ready;
  h.frame();
  await settle();
  h.frame();
  assert.ok(tracer.stats.width * tracer.stats.height * 48 <= limit, 'the temporal guide must fit one storage binding');
  const oversized = device.buffers.filter(
    (buffer) => !buffer.destroyed && buffer.usage & GPUBufferUsage.STORAGE && buffer.size > limit,
  );
  assert.equal(oversized.length, 0, 'no live storage buffer exceeds the device binding limit');
  assert.ok(tracer.stats.width >= 145 && tracer.stats.height >= 145, 'retain the usable viewport resolution');
  tracer.dispose();
});

test('raw viewport retains its single-image 16-byte pixel budget', async () => {
  const limit = 1 << 20,
    device = fakeDevice({ maxStorageBufferBindingSize: limit }),
    h = fakeEngine(device);
  h.context.width = 512;
  h.context.height = 512;
  const tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), denoise: false, samplesPerFrame: 1 });
  await tracer.ready;
  h.frame();
  await settle();
  h.frame();
  assert.equal(tracer.stats.width, 256);
  assert.equal(tracer.stats.height, 256);
  tracer.dispose();
});
