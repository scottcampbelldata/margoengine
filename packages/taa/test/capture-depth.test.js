// KB-FILM-TAATONE1: a standalone Tonemap captures the scene after TAA does (order -50 after -70), so the scene's
// depth is written into Tonemap's capture, not TAA's. TAA threw at the first frame ("TAA needs the current sampleable
// scene depth") although packages/tonemap/README.md says TAA resolves afterward at order 40. TAA now reads the depth of
// the capture the scene drew into, resolved to one sample, when no options.depth is given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { Tonemap } from '../../tonemap/dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

function rig() {
  const h = optionalGPU(),
    c = h.context;
  h.engine.store.visible = new Uint8Array(16);
  for (const method of ['beginRenderPass', 'beginComputePass']) {
    const begin = c.encoder[method];
    c.encoder[method] = (...args) => ({ ...begin(...args), setViewport() {}, setScissorRect() {} });
  }
  return {
    h,
    frame() {
      for (const plugin of h.engine.plugins.values()) plugin.onPreUpdate?.(1 / 60);
      c.color = h.originalColor;
      c.depth = h.originalDepth;
      c.format = 'bgra8unorm';
      c.shader = wgsl;
      c.bindings = [];
      h.engine.frameGraph.execute(c);
    },
  };
}

for (const order of ['TAA first', 'Tonemap first'])
  test(`TAA beside a standalone Tonemap (${order}) resolves on the depth the scene drew`, () => {
    const r = rig(),
      taa = new TAA({ historyWeight: 0.9 }),
      tonemap = new Tonemap({ curve: 'agx', exposure: 0 });
    for (const plugin of order === 'TAA first' ? [taa, tonemap] : [tonemap, taa]) r.h.engine.use(plugin);
    for (let i = 0; i < 3; i++) r.frame();
    const depth = tonemap['depth'];
    assert.ok(depth, 'Tonemap captured the scene');
    assert.equal(taa['depthSource'], depth, "TAA's velocity and resolve read Tonemap's resolved one-sample depth");
    assert.equal(depth.sampleCount, 1);
    assert.equal(taa['valid'], true, 'the history is live after the first frame');
  });

test('an explicit options.depth still wins over the capture the scene drew into', () => {
  const r = rig(),
    tonemap = new Tonemap({ curve: 'agx' });
  let own;
  const taa = new TAA({
    depth: () =>
      (own ??= r.h.engine.gpu.createTexture({
        size: [r.h.context.width, r.h.context.height],
        format: 'depth32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      })),
  });
  r.h.engine.use(taa);
  r.h.engine.use(tonemap);
  r.frame();
  assert.equal(taa['depthSource'], own);
});

test('a multisampled options.depth is a state error, not an invalid bind group', () => {
  // With Water, `depth: () => water.depthTexture` handed TAA a 4x depth and CreateBindGroup failed on the device. The
  // scene draws into Tonemap's capture, so TAA reads the given depth rather than its own capture's.
  const r = rig(),
    tonemap = new Tonemap({ curve: 'agx' });
  const taa = new TAA({
    depth: () =>
      r.h.engine.gpu.createTexture({
        size: [r.h.context.width, r.h.context.height],
        format: 'depth32float',
        sampleCount: 4,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      }),
  });
  r.h.engine.use(taa);
  r.h.engine.use(tonemap);
  assert.throws(() => r.frame(), /single-sample scene depth/);
});
