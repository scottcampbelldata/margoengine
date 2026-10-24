import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneTarget } from '../packages/shared/msaa.js';
import { optionalGPU } from './support/optional-gpu.js';
import { DOF } from '../packages/dof/dist/index.js';
import { Tonemap } from '../packages/tonemap/dist/index.js';
import { wgsl } from '../packages/core/src/shaders.ts';

test('scene capture depth copies preserve earlier view regions on resolve and restore', () => {
  const h = optionalGPU(),
    c = h.context,
    device = h.engine.gpu,
    passes = [];
  c.view = { id: 'right', viewport: [64, 0, 64, 96], scissor: [70, 4, 50, 80], index: 1 };
  c.encoder.beginRenderPass = (descriptor) => {
    const record = { descriptor };
    passes.push(record);
    return {
      setPipeline() {},
      setBindGroup() {},
      setViewport: (...v) => {
        record.viewport = v;
      },
      setScissorRect: (...v) => {
        record.scissor = v;
      },
      draw() {},
      end() {},
    };
  };
  const make = (format) =>
    device.createTexture({
      size: [128, 96],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  const target = new SceneTarget(device, make('bgra8unorm'), make('depth32float'), 4);
  try {
    target.begin(c);
    target.resolve(c.encoder, true);
    target.restore(c);
    const copies = passes.filter((p) => p.descriptor.depthStencilAttachment && !p.descriptor.colorAttachments.length);
    assert.equal(copies.length, 2, 'resolved depth and the outer depth');
    for (const copy of copies) {
      assert.equal(copy.descriptor.depthStencilAttachment.depthLoadOp, 'load', 'earlier view depth is preserved');
      assert.deepEqual(copy.viewport, [64, 0, 64, 96, 0, 1]);
      assert.deepEqual(copy.scissor, [70, 4, 50, 80]);
    }
  } finally {
    target.dispose();
    h.cleanup();
  }
});

for (const Effect of [DOF, Tonemap])
  test(`${Effect.name} captures an offset view with consistent full-target attachment sizes and stable allocations`, async () => {
    const h = optionalGPU(),
      c = h.context,
      effect = new Effect(),
      begin = c.encoder.beginRenderPass;
    c.view = { id: 'right', viewport: [64, 0, 64, 96], index: 1 };
    c.encoder.beginRenderPass = (descriptor) => {
      const attachments = [
        ...(descriptor.colorAttachments ?? []).map((a) => a?.view?.texture),
        descriptor.depthStencilAttachment?.view?.texture,
      ].filter(Boolean);
      if (attachments.length > 1)
        for (const texture of attachments)
          assert.deepEqual(
            [texture.width, texture.height],
            [attachments[0].width, attachments[0].height],
            'render attachment dimensions must agree',
          );
      return {
        ...begin(descriptor),
        setViewport(x, y, w, h) {
          for (const texture of attachments)
            assert.ok(x + w <= texture.width && y + h <= texture.height, 'viewport fits attachment');
        },
        setScissorRect() {},
      };
    };
    const frame = () => {
      c.color = h.originalColor;
      c.depth = h.originalDepth;
      c.shader = wgsl;
      c.bindings = [];
      h.engine.frameGraph.execute(c);
    };
    try {
      h.engine.use(effect);
      frame();
      const counts = { ...h.counts };
      frame();
      assert.equal(h.counts.textures, counts.textures, 'same offset view reuses captures');
    } finally {
      effect.dispose();
      await null;
      assert.ok(h.resources.every((r) => r.destroyed));
    }
  });
