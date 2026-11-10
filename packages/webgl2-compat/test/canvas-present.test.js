import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatCanvasContext, CompatDevice } from '../dist/device.js';

test('canvas presentation keeps its context mode when devices change between XR and offscreen canvases', () => {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'),
    calls = [];
  class Offscreen {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext(kind) {
      assert.equal(kind, '2d');
      return { globalCompositeOperation: '', drawImage: (source) => calls.push(['copy', source]) };
    }
    transferToImageBitmap() {
      return { source: this };
    }
  }
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: Offscreen });
  const source = (offscreen) => (offscreen ? new Offscreen(4, 3) : { width: 4, height: 3 });
  const device = (source) =>
    Object.assign(Object.create(CompatDevice.prototype), {
      gl: { canvas: source, blitFramebuffer() {}, clearColor() {}, clear() {} },
      state: { bindReadFramebuffer() {}, bindDrawFramebuffer() {}, enable() {}, set() {} },
      replayer: {
        framebufferOf() {
          return {};
        },
      },
      shown: new Set(),
      validationError: (message) => assert.fail(message),
    });
  try {
    for (const first of [false, true]) {
      let mode;
      const shown = [],
        context2d = { clearRect() {}, drawImage: (image) => shown.push(image) };
      const bitmapContext = { transferFromImageBitmap: (bitmap) => shown.push(bitmap.source) };
      const canvas = { width: 4, height: 3 };
      const context = new CompatCanvasContext(canvas, (kind) => {
        if (mode && kind !== mode) return null;
        mode ??= kind;
        return kind === '2d' ? context2d : bitmapContext;
      });
      const sources = [source(first), source(!first), source(first)];
      for (const image of sources) {
        const gpu = device(image);
        context.configure({ device: gpu, format: 'rgba8unorm' });
        context.texture = { width: 4, height: 3, destroyed: false, destroy() {} };
        context.present();
      }
      assert.equal(mode, first ? 'bitmaprenderer' : '2d');
      assert.equal(shown.length, 3);
      if (first) {
        assert.equal(shown[0], sources[0]);
        assert.ok(shown[1] instanceof Offscreen, 'HTML source is copied before transfer to a bitmap context');
        assert.ok(calls.some(([, image]) => image === sources[1]));
        assert.equal(shown[2], sources[2]);
      } else assert.deepEqual(shown, sources, '2d owns its pixels and can draw either source directly');
    }
  } finally {
    if (own) Object.defineProperty(globalThis, 'OffscreenCanvas', own);
    else delete globalThis.OffscreenCanvas;
  }
});
