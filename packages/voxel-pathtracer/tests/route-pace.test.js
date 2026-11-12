// KB-L6b-ti (2026-11-11): on the WebGL2 layer's route the viewport added a landed batch in one frame and started the
// next batch only in the frame after, and every batch's first submissions waited for a microtask after the frame that
// started it. A frame loop that waits for the GPU after each frame (the staging TAA still check) then counted a sample
// every 3 to 4 frames on ANGLE Vulkan, where WebGPU counts one a frame. Now a batch's first submissions are made inside
// the frame that starts it, and the frame that adds a landed batch starts the next one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, settle, simpleScene } from './support.js';

// A fake device of the WebGL2 layer: the tracer takes its compatibility route there.
function harness() {
  const device = fakeDevice(),
    encoder = device.createCommandEncoder,
    record = (commands) => new Proxy({}, { get: (_, name) => (...args) => void commands.push([name, ...args]) });
  device.adapterInfo = { vendor: 'margo-webgl2', architecture: 'webgl2', device: 'test', description: 'test' };
  // The route's render passes, query resolves and texture copies, recorded only (its census reads back zeros: every
  // path finished).
  device.createCommandEncoder = (d) => {
    const e = encoder(d);
    e.beginRenderPass = () => record([]);
    e.resolveQuerySet = () => {};
    e.copyTextureToTexture = () => {};
    return e;
  };
  return fakeEngine(device);
}

test('the WebGL2 route submits a batch inside the frame that starts it, and the frame that adds it starts the next', async () => {
  const h = harness(),
    tracer = VoxelPathTracer.attach(h.engine, { scene: simpleScene(), maxSamples: 4, samplesPerFrame: 1, denoise: false });
  try {
    await tracer.ready;
    // The first frames compile the route's kernels; wait until a frame starts a batch.
    let started = false;
    for (let i = 0; i < 50 && !started; i++) {
      const before = h.device.submits;
      h.frame();
      // Counted before any promise callback runs: the batch's first window is submitted within the frame.
      started = h.device.submits > before;
      await settle();
    }
    assert.ok(started, 'a frame submitted its batch before returning');
    const samples = [];
    // Every read-back resolves at once here, so each batch has landed by the next frame: one sample a frame.
    for (let i = 0; i < 6; i++) {
      const before = h.device.submits;
      h.frame();
      samples.push({ samples: tracer.stats.samples, submitted: h.device.submits > before });
      for (let k = 0; k < 20; k++) await settle();
    }
    assert.deepEqual(
      samples.map((s) => s.samples),
      [1, 2, 3, 4, 4, 4],
      'a landed batch is added and the next started in the same frame',
    );
    assert.deepEqual(
      samples.map((s) => s.submitted),
      [true, true, true, true, false, false],
      'each frame that adds a batch below maxSamples submits the next within the frame; a converged image submits nothing',
    );
  } finally {
    tracer.dispose();
  }
});
