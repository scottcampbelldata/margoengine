import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatCanvasContext, CompatDevice, createCompatGPU } from '../dist/device.js';
import { COMPAT_LIMITS } from '../dist/index.js';

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
      gl: { canvas: source },
      replayer: { presentTexture() {} },
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

// Bug (batch 166 job 2 hunt, 2026-11-10): presenting with a y-flipped blitFramebuffer and a colour-masked clear sent
// Chrome's ANGLE D3D11 backend through blit and clear shaders of its own, after which the fragment uniform blocks of
// a later draw sometimes read zero (every instanced box black; docs/known-bugs.md, "ANGLE D3D11 flipped blit"). The
// present is now the layer's own texel-fetch draw. This records every GL call a present makes on a real device.
async function recordingDevice() {
  const calls = [];
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const context = {
    ...enums,
    TRIANGLES: 4,
    TEXTURE_2D: 0x0de1,
    DRAW_FRAMEBUFFER: 0x8ca9,
    READ_FRAMEBUFFER: 0x8ca8,
    COLOR_BUFFER_BIT: 0x4000,
    TEXTURE0: 0x84c0,
    TEXTURE_BASE_LEVEL: 0x813c,
    TEXTURE_MAX_LEVEL: 0x813d,
    canvas: { width: 1, height: 1 },
    getExtension: (name) => (name === 'EXT_color_buffer_float' ? {} : null),
    getParameter: () => 4096,
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
  };
  let recording = false;
  const constants = new Map();
  const gl = new Proxy(context, {
    get(target, key) {
      if (key in target) return target[key];
      // Any other GL enum: a distinct stand-in value.
      if (typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key)) {
        if (!constants.has(key)) constants.set(key, 0x20000 + constants.size);
        return constants.get(key);
      }
      return (...args) => {
        if (recording) calls.push([key, ...args]);
        return {};
      };
    },
  });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  return { device, gl, calls, record: (on) => (recording = on) };
}

for (const alphaMode of ['opaque', 'premultiplied'])
  test(`${alphaMode} present: draws the frame upside down with a texel fetch, no blit and no masked clear`, async () => {
    const { device, gl, calls, record } = await recordingDevice();
    const canvas = { width: 6, height: 5 };
    const context = new CompatCanvasContext(canvas, (kind) =>
      kind === 'bitmaprenderer' ? { transferFromImageBitmap() {} } : null,
    );
    context.configure({ device, format: 'rgba8unorm', alphaMode });
    const texture = context.getCurrentTexture();
    gl.canvas.transferToImageBitmap = () => ({});
    record(true);
    context.present();
    record(false);
    const names = calls.map((c) => c[0]);
    assert.ok(!names.includes('blitFramebuffer'), `present blits: ${names.join(' ')}`);
    assert.ok(!names.includes('clear'), `present clears: ${names.join(' ')}`);
    assert.ok(!names.includes('colorMask') || calls.filter((c) => c[0] === 'colorMask').every((c) => c.slice(1).every(Boolean)));
    const draw = calls.filter((c) => c[0] === 'drawArrays');
    assert.deepEqual(draw, [['drawArrays', 4, 0, 3]]);
    assert.ok(!calls.some((c) => c[0] === 'bindFramebuffer' && c[1] === gl.DRAW_FRAMEBUFFER && c[2] !== null));
    const fragment = calls.find((c) => c[0] === 'shaderSource' && /texelFetch/.test(c[2]));
    assert.match(fragment[2], /o\.y - 1 - int\(gl_FragCoord\.y\)/, 'rows are fetched bottom-up');
    const uniform = calls.find((c) => c[0] === 'uniform4i');
    assert.deepEqual(uniform.slice(2), [alphaMode === 'opaque' ? 1 : 0, texture.height, 0, 0]);
    assert.equal(gl.canvas.width, 6);
    assert.equal(gl.canvas.height, 5);
  });
