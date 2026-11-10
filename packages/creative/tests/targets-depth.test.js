import test from 'node:test';
import assert from 'node:assert/strict';
import { DepthTextureRenderTarget } from '../dist/targets-depth.js';

globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1, COPY_DST: 2 };
function device() {
  return { limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 2048, maxTextureArrayLayers: 256 }, textures: [],
    createTexture(desc) { const t = { desc, destroyed: 0, createView(d) { return { texture: t, desc: d }; }, destroy() { this.destroyed++; } }; this.textures.push(t); return t; } };
}
function encoder() {
  return { passes: [], copies: [], beginRenderPass(desc) { this.passes.push(desc); return { ended: false, end() { this.ended = true; } }; }, copyTextureToTexture(...args) { this.copies.push(args); } };
}
test('depth, MSAA and volume resolves retain distinct surfaces and honor load', () => {
  for (const kind of ['cube', 'array', '3d']) {
    const gpu = device(), target = new DepthTextureRenderTarget(gpu, { kind, width: 4, depthOrLayers: kind === 'cube' ? 6 : 2, mipLevelCount: 3, samples: 4 });
    const e = encoder(), p = target.begin(e, { layer: 1 }); p.end();
    assert.ok(e.passes[0].colorAttachments[0].resolveTarget);
    assert.equal(e.passes[0].depthStencilAttachment.depthClearValue, 0);
    const depth = target.depthTexture({ layer: 1 });
    assert.equal(depth.desc.sampleCount, 4);
    assert.notEqual(depth, target.depthTexture());
    target.begin(e, { layer: 1, loadOp: 'load', depthLoadOp: 'load' }).end();
    assert.equal(e.passes[1].colorAttachments[0].loadOp, 'load');
    assert.equal(e.passes[1].depthStencilAttachment.depthLoadOp, 'load');
    assert.equal(e.copies.length, kind === '3d' ? 2 : 0);
    target.dispose(); target.dispose();
    assert.ok(gpu.textures.every(t => t.destroyed === 1));
    assert.throws(() => target.depthTexture(), e => e.code === 'disposed');
  }
});
test('validation, depth opt out and restore preserve lifecycle', () => {
  for (const bad of [{ samples: 2 }, { depth: 1 }, { depthFormat: 'rgba8unorm' }, { width: 4096, samples: 4 }])
    assert.throws(() => new DepthTextureRenderTarget(device(), { kind: 'cube', width: 4, ...bad }), RangeError);
  const a = device(), b = device(), target = new DepthTextureRenderTarget(a, { kind: '3d', width: 4, depth: false });
  const e = encoder(); target.begin(e).end();
  assert.equal(target.depthTexture(), undefined);
  assert.equal(e.passes[0].depthStencilAttachment, undefined);
  for (const bad of [{ clearDepth: NaN }, { clearDepth: 2 }, { depthLoadOp: 'bad' }, { layer: 4 }]) assert.throws(() => target.begin(e, bad), RangeError);
  assert.equal(e.passes.length, 1);
  target.restore(b); assert.equal(a.textures[0].destroyed, 1);
  target.dispose(); assert.equal(b.textures[0].destroyed, 1);
});
