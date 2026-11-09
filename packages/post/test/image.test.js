import test from 'node:test';
import assert from 'node:assert/strict';
import * as post from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('ImagePost refuses preview setup and unattached capture with linked unsupported', async () => {
  const effect = new post.ImagePost();
  const refused = (error) =>
    error.code === 'unsupported' && error.message.includes('https://margoengine.com/errors#webgpu');
  assert.throws(() => effect.setup({ backend: 'webgl2', gpu: null }), refused);
  await assert.rejects(effect.renderImage({ width: 1, height: 1, color: new Float32Array(3) }), refused);
  effect.dispose();
});

test('isolated Bloom encodes the existing HDR kernel without attaching or removing a viewport plugin', () => {
  const h = optionalGPU(),
    effect = new post.Bloom({ strength: 1.2, radius: 0.7 });
  assert.equal(typeof effect.encodeImage, 'function');
  const input = h.engine.gpu.createTexture({
      size: [128, 96],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    }),
    output = h.engine.gpu.createTexture({
      size: [128, 96],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  const plugins = h.engine.plugins?.size;
  effect.encodeImage(
    { device: h.engine.gpu, encoder: h.context.encoder, width: 128, height: 96 },
    input.createView(),
    output.createView(),
  );
  assert.equal(h.counts.compute, 1);
  assert.equal(h.counts.render, 1);
  assert.equal(h.engine.plugins?.size, plugins);
  input.destroy();
  output.destroy();
  effect.dispose();
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('ImagePost agx draws with the shared AgX shader and no extra resources', async () => {
  const h = optionalGPU(),
    effect = post.ImagePost.attach(h.engine, { toneMapping: 'agx' });
  assert.equal(effect.options.toneMapping, 'agx');
  h.frame();
  const display = h.pipelines.findLast((p) => p.fragment?.module?.code?.includes('fn agx('));
  assert.ok(display, 'the display shader carries the shared agx()');
  assert.equal(h.groups.at(-1).entries.length, 2, 'image and options only');
  assert.equal(h.resources.filter((r) => r.dimension === '3d').length, 0);
  effect.dispose();
  await null;
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('ImagePost rejects invalid image and display options before touching an engine', async () => {
  assert.equal(typeof post.ImagePost, 'function');
  for (const options of [
    { toneMapping: 'unknown' },
    { gamma: 0.5 },
    { exposure: Infinity },
    { vignette: -1 },
    { bloom: { radius: 2 } },
    { bloom: { strength: 5 } },
    { bloom: { threshold: -1 } },
  ])
    assert.throws(() => post.ImagePost.attach({}, options), /tone|gamma|exposure|vignette|bloom/i);
  const h = optionalGPU(),
    effect = post.ImagePost.attach(h.engine, { bloom: { strength: 1 }, toneMapping: 'neutral' });
  const before = h.resources.length;
  await assert.rejects(effect.renderImage({ width: 2, height: 2, color: new Float32Array(3) }), /RGB|length|buffer/i);
  await assert.rejects(
    effect.renderImage({ width: 1, height: 1, color: new Float32Array([NaN, 0, 0]) }),
    /radiance|finite/i,
  );
  const cancelled = new AbortController();
  cancelled.abort(new Error('Cancel before allocation'));
  await assert.rejects(
    effect.renderImage({ width: 1, height: 1, color: new Float32Array(3) }, { signal: cancelled.signal }),
    /Cancel before allocation/,
  );
  assert.equal(h.resources.length, before);
  effect.dispose();
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('ImagePost options own their nested bloom settings and invalid updates retain the active preset', () => {
  assert.equal(typeof post.ImagePost, 'function');
  const h = optionalGPU(),
    options = {
      bloom: { strength: 0.8, threshold: 1, radius: 0.5 },
      toneMapping: 'aces-narkowicz',
      exposure: 2,
      gamma: 2.2,
      vignette: 0.4,
    },
    effect = post.ImagePost.attach(h.engine, options);
  options.bloom.strength = 4;
  assert.equal(effect.options.bloom.strength, 0.8);
  const before = effect.options;
  assert.throws(() => effect.setOptions({ ...before, gamma: 0 }), /gamma/i);
  assert.deepEqual(effect.options, before);
  effect.setOptions({ ...before, bloom: { ...before.bloom, strength: 1.5 }, gamma: undefined });
  assert.equal(effect.options.bloom.strength, 1.5);
  assert.equal(effect.options.gamma, undefined);
  effect.dispose();
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('a lost validation scope still releases all offscreen resources and the capture guard', async () => {
  const h = optionalGPU(),
    device = h.engine.gpu,
    effect = post.ImagePost.attach(h.engine, { bloom: { strength: 1 } }),
    before = h.resources.length;
  device.pushErrorScope = () => {};
  device.popErrorScope = async () => {
    throw new Error('Device lost while reading validation scope');
  };
  device.createCommandEncoder = () => ({
    ...h.context.encoder,
    copyTextureToBuffer() {},
    finish() {
      return {};
    },
  });
  device.queue.submit = () => {};
  await assert.rejects(
    effect.renderImage({ width: 1, height: 1, color: new Float32Array([2, 1, 0.5]) }),
    /Device lost/,
  );
  assert.ok(
    h.resources.slice(before).every((resource) => resource.destroyed),
    'failed exports release their buffers and textures',
  );
  assert.doesNotThrow(
    () => effect.setOptions({ bloom: { strength: 0.5 } }),
    'failed exports release the capture guard',
  );
  effect.dispose();
  assert.ok(h.resources.every((resource) => resource.destroyed));
});
