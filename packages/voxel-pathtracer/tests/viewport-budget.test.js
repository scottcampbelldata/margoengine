// The viewport's traced size within the device's limits: every storage buffer holds one 16-byte-per-pixel image (the
// denoiser's history is in two textures), so a denoised viewport is traced at the size an undenoised one is; the
// history textures stay within maxTextureDimension2D; stats report the requested size and the limit that reduced it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { traceViewportSize, VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, settle, simpleScene } from './support.js';

async function viewport(limits, options, size = [512, 512]) {
  const device = fakeDevice(limits),
    h = fakeEngine(device);
  [h.context.width, h.context.height] = size;
  const tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), samplesPerFrame: 1, ...options });
  await tracer.ready;
  h.frame();
  await settle();
  h.frame();
  return { tracer, device, ...h };
}
const live = (device) => device.buffers.filter((b) => !b.destroyed && b.usage & GPUBufferUsage.STORAGE);

test('denoised viewport keeps every storage binding within the device limit, at the undenoised size', async () => {
  const limit = 1 << 20,
    { tracer, device } = await viewport({ maxStorageBufferBindingSize: limit }, { denoise: true });
  assert.equal(tracer.stats.width, 256);
  assert.equal(tracer.stats.height, 256);
  assert.equal(tracer.stats.requestedWidth, 512);
  assert.equal(tracer.stats.limitedBy, 'storage-binding');
  assert.equal(
    live(device).filter((b) => b.size > limit).length,
    0,
    'no live storage buffer exceeds the binding limit',
  );
  const history = device.textures.filter((t) => !t.destroyed && t.width === 256);
  assert.equal(history.length, 2, 'two history textures of the viewport size');
  assert.ok(history.every((t) => t.format === 'rgba32uint'));
  tracer.dispose();
  assert.ok(
    device.textures.every((t) => t.destroyed),
    'dispose frees the textures',
  );
  assert.ok(device.buffers.every((b) => b.destroyed));
});

test('raw viewport retains its single-image 16-byte pixel budget', async () => {
  const { tracer } = await viewport({ maxStorageBufferBindingSize: 1 << 20 }, { denoise: false });
  assert.equal(tracer.stats.width, 256);
  assert.equal(tracer.stats.height, 256);
  tracer.dispose();
});

test('a 3840 x 2160 viewport is traced at its native size with the default limits, denoised or not', async () => {
  for (const denoise of [false, true, 'auto']) {
    const { tracer, device } = await viewport({}, { denoise }, [3840, 2160]);
    assert.deepEqual(
      [tracer.stats.width, tracer.stats.height, tracer.stats.requestedWidth, tracer.stats.limitedBy],
      [3840, 2160, 3840, undefined],
      String(denoise),
    );
    assert.equal(live(device).filter((b) => b.size > 128 << 20).length, 0);
    tracer.dispose();
  }
});

test('the history textures stay within maxTextureDimension2D', async () => {
  const { tracer, device } = await viewport({ maxTextureDimension2D: 1024 }, { denoise: true }, [2048, 1024]);
  assert.deepEqual([tracer.stats.width, tracer.stats.height, tracer.stats.limitedBy], [1024, 512, 'texture-dimension']);
  assert.ok(device.textures.every((t) => t.width <= 1024 && t.height <= 1024));
  tracer.dispose();
});

test('traceViewportSize predicts the viewport and validates its input', () => {
  const limits = { maxStorageBufferBindingSize: 128 << 20, maxTextureDimension2D: 8192 };
  assert.deepEqual(traceViewportSize(3840, 2160, limits, { denoise: true }), {
    width: 3840,
    height: 2160,
    requestedWidth: 3840,
    requestedHeight: 2160,
  });
  assert.deepEqual(traceViewportSize(3840, 2160, limits, { resolutionScale: 2 }), {
    width: 3861,
    height: 2172,
    requestedWidth: 7680,
    requestedHeight: 4320,
    limitedBy: 'storage-binding',
  });
  const r = traceViewportSize(7680, 4320, limits, { resolutionScale: 2, denoise: 'auto' });
  assert.equal(r.limitedBy, 'storage-binding');
  assert.ok(r.width * r.height * 16 <= limits.maxStorageBufferBindingSize);
  assert.throws(() => traceViewportSize(0, 10, limits), RangeError);
  assert.throws(() => traceViewportSize(10.5, 10, limits), RangeError);
  assert.throws(() => traceViewportSize(10, 10, null), TypeError);
  assert.throws(() => traceViewportSize(10, 10, limits, { resolutionScale: 3 }), RangeError);
});
