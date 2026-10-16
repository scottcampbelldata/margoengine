import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneFade } from '../packages/post/dist/scene-fade.js';
import { optionalGPU } from './support/optional-gpu.js';

test('SceneFade preserves borrowed output, completes normal and reduced-motion fades, and releases owned resources', async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  try {
    for (const [userAgent, duration, samples] of [
      ['Desktop', 180, 4],
      ['Android Mobile', 0, 1],
    ]) {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { userAgent },
      });
      const h = optionalGPU(),
        device = h.engine.gpu,
        copies = [],
        submissions = [],
        passes = [],
        configurations = [];
      const output = device.createTexture({
        size: [128, 96],
        format: 'bgra8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      h.engine.canvas = {
        getContext: (kind) =>
          kind === 'webgpu'
            ? {
                getConfiguration: () => ({ device, format: output.format, alphaMode: 'premultiplied', colorSpace: 'display-p3', usage: GPUTextureUsage.RENDER_ATTACHMENT }),
                configure: (options) => configurations.push(options), getCurrentTexture: () => output,
              }
            : null,
      };
      device.createRenderPipelineAsync = async (options) => device.createRenderPipeline(options);
      device.createCommandEncoder = () => ({
        copyTextureToTexture: (source, target, size) => copies.push({ source, target, size }),
        finish: () => ({}),
      });
      device.queue.submit = (commands) => submissions.push(commands);
      const begin = h.context.encoder.beginRenderPass;
      h.context.encoder.beginRenderPass = (descriptor) => {
        passes.push(descriptor);
        return begin(descriptor);
      };
      h.context.descriptor.multisample.count = samples;
      const firstOwned = h.resources.length,
        fade = SceneFade.attach(h.engine, duration);
      try {
        assert.equal(configurations.length, 1);
        assert.equal(configurations[0].device, device);
        assert.equal(configurations[0].format, output.format);
        assert.equal(configurations[0].alphaMode, 'premultiplied');
        assert.equal(configurations[0].colorSpace, 'display-p3');
        assert.ok(configurations[0].usage & GPUTextureUsage.COPY_SRC);
        h.frame();
        assert.equal(passes.length, 0, 'Unwarmed fade changed the scene');
        fade.capture();
        assert.equal(copies.length, 1);
        assert.equal(submissions.length, 1);
        const snapshot = copies[0].target.texture;
        assert.equal(copies[0].source.texture, output);
        assert.notEqual(snapshot, output);
        assert.deepEqual(copies[0].size, [output.width, output.height]);
        assert.equal(snapshot.format, output.format);
        await fade.warm();
        assert.equal(h.pipelines.length, 1);
        assert.equal(h.pipelines[0].multisample.count, samples);
        assert.equal(h.pipelines[0].fragment.targets[0].format, output.format);
        const uniform = h.resources.find((resource) => resource.label === 'scene-fade:uniform'),
          allocated = { ...h.counts };
        let finished = false;
        fade.finished.then(() => {
          finished = true;
        });
        h.frame();
        assert.deepEqual(Array.from(new Float32Array(uniform.data)), [128, 96, 1, 0]);
        assert.equal(passes.at(-1).colorAttachments[0].view, h.originalColor);
        assert.equal(passes.at(-1).colorAttachments[0].loadOp, 'load');
        assert.equal(h.context.color, h.originalColor);
        assert.equal(h.context.depth, h.originalDepth);
        fade.start();
        if (duration) {
          now += duration / 2;
          h.context.width = 192;
          h.context.height = 120;
          h.frame();
          assert.deepEqual(Array.from(new Float32Array(uniform.data)), [192, 120, 0.5, 0]);
          await Promise.resolve();
          assert.equal(finished, false, 'Fade completed before its duration');
          fade.start();
          now += duration / 2;
        }
        const drawn = passes.length;
        h.frame();
        await fade.finished;
        assert.equal(finished, true);
        assert.equal(passes.length, drawn, 'Completed fade drew over the upgraded scene');
        assert.equal(new Float32Array(uniform.data)[2], 0);
        for (const key of ['buffers', 'textures', 'views', 'groups']) assert.equal(h.counts[key], allocated[key]);
        fade.dispose();
        fade.dispose();
        assert.equal(h.engine.hasPlugin(fade.name), false);
        assert.ok(h.resources.slice(firstOwned).every((resource) => resource.destroyed));
        assert.equal(output.destroyed, false);
        h.frame();
        assert.equal(passes.length, drawn);
        const restored = SceneFade.attach(h.engine, duration),
          firstRestored = h.resources.length - 1;
        restored.capture();
        await restored.warm();
        restored.start();
        restored.onDeviceRestored();
        await restored.finished;
        assert.equal(h.engine.hasPlugin(restored.name), false);
        assert.ok(h.resources.slice(firstRestored).every((resource) => resource.destroyed));
        assert.equal(output.destroyed, false);
        assert.throws(() => restored.start(), /Warm/);
        restored.dispose();
      } finally {
        fade.dispose();
        h.cleanup();
      }
    }
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
});
