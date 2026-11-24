import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { TextureCapture, TextureViewer } from '../dist/textures.js';
function device() {
  const textures = [],
    buffers = [],
    shaders = [];
  const gpu = {
    lost: new Promise(() => {}),
    textures,
    buffers,
    shaders,
    createTexture(d) {
      const size = Array.isArray(d.size) ? d.size : [d.size.width, d.size.height ?? 1, d.size.depthOrArrayLayers ?? 1];
      const texture = {
        label: d.label ?? '',
        width: size[0],
        height: size[1] ?? 1,
        depthOrArrayLayers: size[2] ?? 1,
        dimension: d.dimension ?? '2d',
        format: d.format,
        mipLevelCount: d.mipLevelCount ?? 1,
        sampleCount: d.sampleCount ?? 1,
        usage: d.usage,
        destroyed: false,
        createView(v) {
          this.view = v;
          return { texture: this };
        },
        destroy() {
          this.destroyed = true;
        },
      };
      textures.push(texture);
      return texture;
    },
    createBuffer(d) {
      const b = {
        ...d,
        storage: new ArrayBuffer(d.size),
        mapAsync() {
          return Promise.resolve();
        },
        getMappedRange() {
          return this.storage;
        },
        unmap() {},
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(b);
      return b;
    },
    createShaderModule(d) {
      shaders.push(d.code);
      return d;
    },
    createBindGroupLayout(d) {
      return d;
    },
    createPipelineLayout(d) {
      return d;
    },
    createRenderPipelineAsync(d) {
      return Promise.resolve(d);
    },
    createBindGroup(d) {
      return d;
    },
    createCommandEncoder() {
      return {
        beginRenderPass() {
          return { setPipeline() {}, setBindGroup() {}, draw() {}, end() {} };
        },
        copyTextureToBuffer(_source, destination, size) {
          const out = new Uint8Array(destination.buffer.storage);
          for (let y = 0; y < size[1]; y++)
            for (let x = 0; x < size[0]; x++) out.set([10 + x, 20 + y, 30, 255], y * destination.bytesPerRow + x * 4);
        },
        finish() {
          return {};
        },
      };
    },
    queue: { writeBuffer() {}, submit() {} },
    destroy() {
      this.destroyed = true;
    },
  };
  return gpu;
}
test('startup capture sees all earlier textures, preserves native receivers/descriptors and unregisters destruction', async () => {
  const d = device(),
    adapter = {
      async requestDevice() {
        assert.equal(this, adapter);
        return d;
      },
    },
    gpu = {
      async requestAdapter() {
        assert.equal(this, gpu);
        return adapter;
      },
    };
  const native = gpu.requestAdapter,
    capture = TextureCapture.start({ gpu });
  const a = await gpu.requestAdapter(),
    dev = await a.requestDevice(),
    descriptor = Object.freeze({ label: '<img>', size: [8, 4, 6], format: 'rgba8unorm', mipLevelCount: 3, usage: 2 });
  const t = dev.createTexture(descriptor);
  assert.equal(descriptor.usage, 2);
  assert.equal(t.usage, 6);
  assert.deepEqual(capture.list(), [
    {
      id: 1,
      label: '<img>',
      width: 8,
      height: 4,
      depthOrArrayLayers: 6,
      dimension: '2d',
      format: 'rgba8unorm',
      mipLevelCount: 3,
      sampleCount: 1,
      usage: 6,
    },
  ]);
  assert.equal(capture.register(dev, t), 1);
  const transient = dev.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 48 });
  assert.equal(transient.usage, 48);
  t.destroy();
  assert.equal(capture.list().length, 1);
  dev.destroy();
  assert.equal(capture.list().length, 0);
  capture.dispose();
  assert.equal(gpu.requestAdapter, native);
});
test('exact mip/layer dimensions, row padding, format-specific shaders and temporary resources never enter the list', async () => {
  const d = device(),
    capture = new TextureCapture({ gpu: null });
  capture.watchDevice(d);
  for (const [format, dimension, multi] of [
    ['rgba8unorm', '2d', false],
    ['r32uint', '2d', false],
    ['rgba32sint', '3d', false],
    ['depth24plus', '2d', false],
    ['stencil8', '2d', false],
    ['rgba8unorm-srgb', '1d', false],
    ['rgba8unorm', '2d', true],
  ]) {
    const t = d.createTexture({
        size: dimension === '1d' ? [8] : [8, 4, dimension === '3d' ? 4 : 1],
        dimension,
        format,
        usage: 4,
        mipLevelCount: multi ? 1 : 3,
        sampleCount: multi ? 4 : 1,
      }),
      id = capture.list().at(-1).id;
    const out = await capture.preview(id, { mip: multi ? 0 : 1, layer: dimension === '3d' ? 1 : 0, channel: 'g' });
    assert.equal(out.width, multi ? 8 : 4);
    assert.equal(out.height, dimension === '1d' ? 1 : multi ? 4 : 2);
    assert.deepEqual([...out.data.slice(-4)], [10 + out.width - 1, 20 + out.height - 1, 30, 255]);
    assert.equal(capture.list().at(-1).id, id);
    assert.equal(t.view.baseMipLevel, multi ? 0 : 1);
    assert.ok(d.textures.at(-1).destroyed);
    assert.ok(d.buffers.slice(-2).every((b) => b.destroyed));
  }
  assert.ok(d.shaders.some((code) => code.includes('texture_3d<i32>')));
  assert.ok(d.shaders.some((code) => code.includes('texture_depth_2d')));
  assert.ok(d.shaders.some((code) => code.includes('texture_multisampled_2d<f32>')));
  capture.dispose();
});
test('older explicit resources, bounds, non-readable textures and abort/dispose fail without leaked preview allocations', async () => {
  const d = device(),
    capture = new TextureCapture({ gpu: null, inspectable: false }),
    t = d.createTexture({ size: [8, 4], format: 'rgba8unorm', usage: 2 }),
    id = capture.register(d, t);
  await assert.rejects(capture.preview(id), /TEXTURE_BINDING/);
  capture.watchDevice(d);
  const readable = d.createTexture({ size: [8, 4], format: 'rgba8unorm', usage: 4 }),
    rid = capture.register(d, readable);
  for (const options of [
    { mip: 1 },
    { layer: 1 },
    { channel: 'x' },
    { range: [1, 0] },
    { exposure: NaN },
    { aspect: 'depth-only' },
  ])
    await assert.rejects(capture.preview(rid, options), RangeError);
  d.createRenderPipelineAsync = () => new Promise(() => {});
  const abort = new AbortController(),
    pending = capture.preview(rid, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(d.buffers.at(-1).destroyed);
  assert.ok(d.textures.at(-1).destroyed);
  const disposal = capture.preview(rid);
  capture.dispose();
  await assert.rejects(disposal, /disposed/);
  assert.equal(readable.destroyed, false);
});
test('wrappers compose in either disposal order; delayed adapter creation cannot install after capture disposal', async () => {
  const d = device(),
    native = d.createTexture,
    a = new TextureCapture({ gpu: null }),
    b = new TextureCapture({ gpu: null });
  a.watchDevice(d);
  b.watchDevice(d);
  a.dispose();
  d.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 4 });
  assert.equal(b.list().length, 1);
  b.dispose();
  const t = d.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 2 });
  assert.equal(t.usage, 2);
  assert.notEqual(d.createTexture, native, 'an outer wrapper retains a pass-through until it releases its layer');
  let done;
  const gpu = { requestAdapter: () => new Promise((resolve) => (done = resolve)) },
    capture = new TextureCapture({ gpu }),
    promise = gpu.requestAdapter();
  capture.dispose();
  const adapter = {
    requestDevice() {
      return d;
    },
  };
  const original = adapter.requestDevice;
  done(adapter);
  assert.equal(await promise, adapter);
  assert.equal(adapter.requestDevice, original);
});
test('viewer includes resources made before attachment, safely labels metadata and tears down on abort', async () => {
  const dom = new JSDOM('<body></body>'),
    capture = new TextureCapture({ gpu: null }),
    d = device();
  const t = d.createTexture({
    label: '<script>alert(1)</script>',
    size: [8, 4],
    format: 'rgba8unorm',
    mipLevelCount: 3,
    usage: 4,
  });
  capture.register(d, t);
  capture.preview = async (_id, options) => ({
    width: 8 >> (options.mip ?? 0),
    height: 4 >> (options.mip ?? 0),
    data: new Uint8ClampedArray((8 >> (options.mip ?? 0)) * (4 >> (options.mip ?? 0)) * 4),
  });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
  });
  const abort = new AbortController(),
    viewer = TextureViewer.attach(capture, { parent: dom.window.document.body, signal: abort.signal });
  await viewer.select(1, { mip: 1, channel: 'r' });
  assert.equal(viewer.canvas.width, 4);
  assert.equal(viewer.canvas.height, 2);
  assert.ok(viewer.element.textContent.includes('rgba8unorm'));
  assert.equal(viewer.element.querySelector('script'), null);
  abort.abort();
  assert.equal(viewer.element.isConnected, false);
  assert.equal(capture.list().length, 1);
  capture.dispose();
  dom.window.close();
});

test('layered captures never publish another capture preview allocation', async () => {
  const d = device(), first = new TextureCapture({ gpu: null }), second = new TextureCapture({ gpu: null });
  first.watchDevice(d);
  second.watchDevice(d);
  const texture = d.createTexture({ label: 'Source', size: [2, 2], format: 'rgba8unorm', usage: 4 });
  const changes = [];
  second.onChange(() => changes.push(second.list().map((entry) => entry.label)));
  await first.preview(first.list()[0].id);
  assert.deepEqual(changes, []);
  assert.deepEqual(first.list().map((entry) => entry.label), ['Source']);
  assert.deepEqual(second.list().map((entry) => entry.label), ['Source']);
  first.dispose();
  second.dispose();
  texture.destroy();
});

// A reaction on device.lost cannot be removed: one made per capture kept every disposed capture (and its records) alive as
// long as the device (docs/known-bugs.md). The device now has one reaction over the captures still watching it.
test('a disposed capture is collected while its device lives; a live capture still forgets a lost device', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  try {
    let lose;
    const d = Object.assign(device(), { lost: new Promise((resolve) => (lose = resolve)) });
    const reference = (() => {
      const capture = new TextureCapture();
      capture.watchDevice(d);
      d.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 4 });
      capture.dispose();
      return new WeakRef(capture);
    })();
    for (let i = 0; i < 5 && reference.deref(); i++) {
      await setImmediate();
      gc();
    }
    assert.ok(reference.deref() === undefined, 'the disposed capture is still reachable from its live device');
    const live = new TextureCapture();
    live.watchDevice(d);
    d.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 4 });
    assert.equal(live.list().length, 1);
    lose({ reason: 'unknown', message: 'test' });
    await setImmediate();
    assert.equal(live.list().length, 0, 'a lost device leaves the list');
    live.dispose();
  } finally {
    setFlagsFromString('--no-expose-gc');
  }
});
