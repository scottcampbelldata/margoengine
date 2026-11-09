import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createMaskTransition } from '../dist/mask.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Transitions } from '../dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
const original = globalThis.ImageData;
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
};
after(() => {
  if (original) globalThis.ImageData = original;
  else delete globalThis.ImageData;
});
const image = () => new ImageData(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1);
const harness = () => {
  const h = optionalGPU();
  h.engine.gpu.limits.maxTextureDimension2D = 4096;
  return h;
};

test('test-page 24: built-in and mask transitions coexist and unwind captures in either attachment order', async () => {
  for (const maskFirst of [false, true]) {
    const h = harness();
    const engine = new Engine(
      { width: 16, height: 16 },
      await TransformStore.create(4),
      { backend: 'webgpu', gpu: h.engine.gpu, dispose() {} },
      {},
      null,
    );
    try {
      let base, mask;
      if (maskFirst) {
        mask = createMaskTransition(engine, image());
        base = Transitions.attach(engine);
      } else {
        base = Transitions.attach(engine);
        mask = createMaskTransition(engine, image());
      }
      assert.equal(engine.plugins.get('transitions'), base);
      assert.equal(engine.plugins.get('transitions:mask'), mask);
      const frame = () => {
        engine.frameGraph.execute(h.context);
        assert.equal(h.context.color, h.originalColor, 'all capture targets unwind');
        assert.equal(h.context.depth, h.originalDepth);
      };
      frame();
      for (const effect of [base, mask]) {
        effect.start('wipe', 0.2);
        frame();
        frame();
        assert.equal(effect.progress, 1);
      }
      base.onDeviceRestored(engine);
      mask.onDeviceRestored(engine);
      frame();
      base.dispose();
      assert.equal(engine.plugins.get(mask.name), mask);
      frame();
      mask.dispose();
      assert.equal(engine.plugins.size, 0);
      assert.ok(h.resources.every(resource => resource.destroyed));
    } finally {
      engine.dispose();
      h.cleanup();
    }
  }
});
test('mask bytes are owned, bound, restored and disposed, with hard and soft modes', async () => {
  for (const softness of [0, 0.000001, 0.02, 1]) {
    const h = harness();
    const source = image();
    const uploads = [];
    h.engine.gpu.queue.writeTexture = (_destination, bytes) => uploads.push(bytes.slice());
    const effect = createMaskTransition(h.engine, source, { softness });
    source.data.fill(100);
    h.frame();
    assert.equal(effect.bind.entries.length, 4);
    assert.equal(uploads[0][0], 0);
    effect.start();
    h.frame();
    effect.onDeviceRestored(h.engine);
    h.frame();
    assert.equal(effect.progress, 1);
    assert.deepEqual(uploads[1], uploads[0], 'restore uses the original byte snapshot');
    effect.dispose();
    effect.dispose();
    await null;
    assert.ok(h.resources.every((resource) => resource.destroyed));
  }
});
test('invalid masks and extreme options reject before allocating GPU resources', () => {
  const h = harness();
  for (const value of [null, {}, [], 0]) assert.throws(() => createMaskTransition(h.engine, value), TypeError);
  for (const n of [0, -1, NaN, Infinity, 4097, 1e30]) {
    const bad = image();
    bad.width = n;
    assert.throws(() => createMaskTransition(h.engine, bad), RangeError);
  }
  for (const softness of [NaN, Infinity, -1, 1e-30, 2])
    assert.throws(() => createMaskTransition(h.engine, image(), { softness }), RangeError);
  assert.equal(h.resources.length, 0);
  h.engine.gpu = undefined;
  assert.throws(
    () => createMaskTransition(h.engine, image()),
    (e) => e.code === 'unsupported' && /https:/.test(e.message),
  );
});
test('a failed upload releases the mask and the base uniform during attachment rollback', async () => {
  const h = harness();
  const failure = new Error('mask upload failed');
  h.engine.gpu.queue.writeTexture = () => {
    throw failure;
  };
  assert.throws(
    () => createMaskTransition(h.engine, image()),
    (error) => error === failure,
  );
  await null;
  assert.equal(h.engine.plugins.size, 0);
  assert.ok(h.resources.length > 0 && h.resources.every((resource) => resource.destroyed));
});
test('bitmap upload has both required usages and a closed borrowed bitmap is refused on restore', async () => {
  const old = globalThis.ImageBitmap;
  globalThis.ImageBitmap = class ImageBitmap {
    width = 2;
    height = 1;
  };
  const h = harness();
  const bitmap = new ImageBitmap();
  h.engine.gpu.queue.copyExternalImageToTexture = (_source, destination) => {
    assert.equal(destination.texture.usage & GPUTextureUsage.COPY_DST, GPUTextureUsage.COPY_DST);
    assert.equal(destination.texture.usage & GPUTextureUsage.RENDER_ATTACHMENT, GPUTextureUsage.RENDER_ATTACHMENT);
  };
  let effect;
  try {
    effect = createMaskTransition(h.engine, bitmap);
    h.frame();
    bitmap.width = 0;
    assert.throws(
      () => effect.onDeviceRestored(h.engine),
      (error) => error.code === 'state' && /https:/.test(error.message),
    );
  } finally {
    effect?.dispose();
    if (old) globalThis.ImageBitmap = old;
    else delete globalThis.ImageBitmap;
  }
  await null;
  assert.ok(h.resources.every((resource) => resource.destroyed));
});
test('capture integer overflow is rejected and all partial captures remain disposable', async () => {
  const h = harness();
  const effect = createMaskTransition(h.engine, image());
  h.context.width = 65536;
  assert.throws(h.frame, /integer addressing/);
  effect.dispose();
  await null;
  assert.ok(h.resources.every((resource) => resource.destroyed));
});
