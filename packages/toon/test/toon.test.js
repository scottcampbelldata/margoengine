import test from 'node:test';
import assert from 'node:assert/strict';
import { Toon } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
test('toon adds a stepped-lighting pass and a front-culled inverted-hull replay', () => {
  const h = optionalGPU(),
    effect = new Toon();
  h.engine.use(effect);
  let options;
  h.context.draw = (value) => {
    if (value) options = value;
  };
  h.frame();
  assert.equal(options.pipeline.primitive.cullMode, 'front');
  assert.equal(options.clear, false);
  assert.equal(options.pipeline.depthStencil.depthWriteEnabled, false);
  assert.equal(options.bindings.length, 1);
  assert.throws(() => new Toon({ outline: -1 }), /outline/);
  effect.onDeviceRestored(h.engine);
  h.frame();
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('toon outlines rebuild for changed scene sampling while retaining stable-frame resources', () => {
  const h = optionalGPU(),
    effect = new Toon();
  h.engine.use(effect);
  let pipeline;
  h.context.draw = (options) => {
    if (options) pipeline = options.pipeline;
  };
  try {
    h.frame();
    const multisampled = pipeline;
    assert.equal(multisampled.multisample.count, 4);
    h.frame();
    assert.equal(pipeline, multisampled);
    h.context.descriptor = { ...h.context.descriptor, multisample: { count: 1 } };
    h.frame();
    assert.notEqual(pipeline, multisampled);
    assert.equal(pipeline.multisample.count, 1);
    const singleSample = pipeline;
    h.frame();
    assert.equal(pipeline, singleSample);
    h.context.descriptor = { ...h.context.descriptor, multisample: { count: 4 } };
    h.frame();
    assert.equal(pipeline.multisample.count, 4);
    const restoredSamples = pipeline;
    h.context.descriptor = {
      ...h.context.descriptor,
      depthStencil: { ...h.context.descriptor.depthStencil, format: 'depth24plus' },
    };
    h.frame();
    assert.notEqual(pipeline, restoredSamples);
    assert.equal(pipeline.depthStencil.format, 'depth24plus');
    const changedDepth = pipeline;
    h.frame();
    assert.equal(pipeline, changedDepth);
  } finally {
    effect.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test("toon reuses creative's ToonShading without exporting it again", async () => {
  const toon = await import('../dist/index.js');
  assert.equal('ToonShading' in toon, false);
});
