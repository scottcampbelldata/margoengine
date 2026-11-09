import test from 'node:test';
import assert from 'node:assert/strict';
import { TextureRenderTarget } from '../dist/targets.js';

globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1 };
const device = (limits = {}) => ({
  limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 2048, maxTextureArrayLayers: 256, ...limits },
  textures: [],
  createTexture(desc) {
    const texture = {
      desc,
      views: [],
      destroyed: 0,
      destroy() {
        this.destroyed++;
      },
      createView(desc) {
        const view = { desc };
        this.views.push(view);
        return view;
      },
    };
    this.textures.push(texture);
    return texture;
  },
});
const encoder = () => ({
  passes: [],
  beginRenderPass(desc) {
    this.passes.push(desc);
    return desc;
  },
});

test('targets reject hostile sizes, shapes, formats and memory before allocating', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    for (const key of ['width', 'height', 'depthOrLayers', 'mipLevelCount']) {
      const gpu = device();
      assert.throws(() => new TextureRenderTarget(gpu, { kind: 'array', width: 4, [key]: bad }), RangeError);
      assert.equal(gpu.textures.length, 0);
    }
  }
  for (const options of [
    null,
    {},
    { kind: 'bad', width: 4 },
    { kind: 'cube', width: 4, height: 2 },
    { kind: 'cube', width: 4, depthOrLayers: 5 },
    { kind: '3d', width: 2049 },
    { kind: 'array', width: 1, depthOrLayers: 257 },
    { kind: 'array', width: 4, mipLevelCount: 4 },
    { kind: 'array', width: 2, format: 'depth32float' },
    { kind: 'array', width: 8192, depthOrLayers: 2 },
  ]) {
    const gpu = device();
    assert.throws(() => new TextureRenderTarget(gpu, options), RangeError);
    assert.equal(gpu.textures.length, 0);
  }
  assert.throws(
    () => new TextureRenderTarget(undefined, { kind: 'cube', width: 4 }),
    (e) => e.code === 'unsupported' && /https:/.test(e.message),
  );
});

test('cube faces and array layers use individual 2d views, keeping layers constant at mips', () => {
  for (const kind of ['cube', 'array']) {
    const gpu = device(),
      target = new TextureRenderTarget(gpu, { kind, width: 5, mipLevelCount: 3, depthOrLayers: 6 });
    assert.equal(target.view.desc.dimension, kind === 'cube' ? 'cube' : '2d-array');
    assert.deepEqual(target.mipSize(1), [2, 2, 6]);
    const enc = encoder();
    for (let face = 0; face < 6; face++) target.begin(enc, { layer: face, mip: 2 });
    for (let face = 0; face < 6; face++) {
      const a = enc.passes[face].colorAttachments[0];
      assert.deepEqual(a.view.desc, {
        dimension: '2d',
        baseMipLevel: 2,
        mipLevelCount: 1,
        baseArrayLayer: face,
        arrayLayerCount: 1,
      });
      assert.ok(!('depthSlice' in a));
    }
    target.begin(enc, { layer: 5, mip: 2, loadOp: 'load' });
    assert.equal(enc.passes[6].colorAttachments[0].view, enc.passes[5].colorAttachments[0].view);
    assert.equal(enc.passes[6].colorAttachments[0].loadOp, 'load');
    assert.equal(gpu.textures[0].views.length, 7, 'one sampling view and six cached surfaces');
    target.dispose();
  }
});

test('3d mip depth shrinks and slices share a 3d view per mip', () => {
  const target = new TextureRenderTarget(device(), {
    kind: '3d',
    width: 3,
    height: 5,
    depthOrLayers: 7,
    mipLevelCount: 3,
  });
  assert.deepEqual(target.mipSize(1), [1, 2, 3]);
  assert.deepEqual(target.mipSize(2), [1, 1, 1]);
  const enc = encoder();
  target.begin(enc, { mip: 1, layer: 0 });
  target.begin(enc, { mip: 1, layer: 2 });
  const a = enc.passes.map((p) => p.colorAttachments[0]);
  assert.equal(a[0].view, a[1].view);
  assert.deepEqual(a[0].view.desc, { dimension: '3d', baseMipLevel: 1, mipLevelCount: 1 });
  assert.equal(a[1].depthSlice, 2);
  for (const value of [-1, 3, 0.5, NaN, Infinity])
    assert.throws(() => target.begin(enc, { mip: 1, layer: value }), RangeError);
  for (const value of [-1, 3, 0.5, NaN, Infinity]) assert.throws(() => target.mipSize(value), RangeError);
  assert.equal(enc.passes.length, 2, 'invalid calls never begin a pass');
  target.dispose();
});

test('clear color rejects sparse, empty, huge and nonfinite inputs before touching encoder', () => {
  for (const format of ['rgba8unorm', 'rgba16float']) {
    const target = new TextureRenderTarget(device(), { kind: 'array', width: 1, format }),
      enc = encoder();
    for (const color of [[], Array(4), [0, 0, NaN, 1], [Infinity, 0, 0, 1], [1e100, 0, 0, 1], [0, 0, 0, 0, 0]])
      assert.throws(() => target.begin(enc, { clearColor: color }), RangeError);
    assert.throws(() => target.begin(enc, { loadOp: 'bad' }), RangeError);
    assert.equal(enc.passes.length, 0);
    target.begin(enc, { clearColor: format === 'rgba16float' ? [-65504, 65504, 0, 1] : [0, 1, 0, 1] });
    target.dispose();
  }
});

test('restoration replaces all cached handles; disposal is idempotent and terminal', () => {
  const a = device(),
    b = device(),
    target = new TextureRenderTarget(a, { kind: 'cube', width: 4 });
  const first = target.texture;
  target.begin(encoder());
  assert.throws(() => target.restore(device({ maxTextureDimension2D: 2 })), RangeError);
  assert.equal(target.texture, first, 'failed validation preserves resource');
  const broken = device();
  broken.createTexture = function (desc) {
    const t = a.createTexture(desc);
    t.createView = () => {
      throw new Error('view failure');
    };
    return t;
  };
  assert.throws(() => target.restore(broken), /view failure/);
  assert.equal(a.textures[1].destroyed, 1, 'partial resource released');
  assert.equal(first.destroyed, 0);
  target.restore(b);
  assert.equal(first.destroyed, 1);
  const enc = encoder();
  target.begin(enc);
  assert.equal(enc.passes[0].colorAttachments[0].view, b.textures[0].views[1]);
  target[Symbol.dispose]();
  target.dispose();
  assert.equal(b.textures[0].destroyed, 1);
  for (const action of [
    () => target.texture,
    () => target.view,
    () => target.begin(enc),
    () => target.mipSize(),
    () => target.restore(a),
  ])
    assert.throws(action, (e) => e.code === 'disposed');
});
