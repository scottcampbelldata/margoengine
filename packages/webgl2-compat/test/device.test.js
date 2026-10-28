// The compatibility GPU and adapter on stand-in WebGL2 contexts (the device itself renders, so its checks run in a
// browser: compat-browser-check.mjs, corpus-draw-browser.mjs). Here: an adapter only for the `full` tier, WebGPU limits
// taken from the context and never above WebGPU's defaults, features only where an extension backs them, one device
// per adapter, and requests the adapter cannot meet refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { COMPAT_VENDOR, createCompatGPU, isCompatDevice } from '../dist/device.js';

/** A stand-in context: just what webgl2Capabilities reads. */
function fakeContext({ extensions = ['EXT_color_buffer_float'], limits = {} } = {}) {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const values = new Map(COMPAT_LIMITS.map((name, i) => [0x1000 + i, limits[name] ?? 4096]));
  return {
    ...enums,
    FRAGMENT_SHADER: 0x8b30,
    HIGH_FLOAT: 0x8df2,
    HIGH_INT: 0x8df5,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    lost: false,
    getExtension(name) {
      if (name === 'WEBGL_lose_context') return { loseContext: () => (this.lost = true) };
      return extensions.includes(name) ? {} : null;
    },
    getParameter(p) {
      return p === 0x1f01 ? 'Stand-in renderer' : (values.get(p) ?? '');
    },
    getShaderPrecisionFormat(_shader, type) {
      return type === 0x8df2
        ? { precision: 23, rangeMin: 127, rangeMax: 127 }
        : { precision: 0, rangeMin: 31, rangeMax: 30 };
    },
  };
}

test('an adapter only on a full-tier context; below it, null and the context is released', async () => {
  let made;
  const below = createCompatGPU({ createContext: () => (made = fakeContext({ extensions: [] })) });
  assert.equal(await below.requestAdapter(), null);
  assert.equal(made.lost, true);
  assert.equal(await createCompatGPU({ createContext: () => null }).requestAdapter(), null);
  const gpu = createCompatGPU({ createContext: () => fakeContext() });
  assert.equal(await gpu.requestAdapter({ forceFallbackAdapter: true }), null);
  const adapter = await gpu.requestAdapter();
  assert.equal(adapter.info.vendor, COMPAT_VENDOR);
  assert.equal(adapter.info.vendor, 'margo-webgl2');
  assert.match(adapter.info.description, /Stand-in renderer/);
  assert.equal(gpu.getPreferredCanvasFormat(), 'rgba8unorm');
});

test('limits come from the context, never above WebGPU defaults; vertex strides stop at WebGL 255 bytes', async () => {
  const gpu = createCompatGPU({
    createContext: () =>
      fakeContext({
        limits: {
          MAX_TEXTURE_SIZE: 16384,
          MAX_3D_TEXTURE_SIZE: 1024,
          MAX_TEXTURE_IMAGE_UNITS: 16,
          MAX_UNIFORM_BLOCK_SIZE: 65536,
          UNIFORM_BUFFER_OFFSET_ALIGNMENT: 64,
          MAX_VARYING_COMPONENTS: 60,
          MAX_COLOR_ATTACHMENTS: 8,
          MAX_DRAW_BUFFERS: 4,
        },
      }),
  });
  const { limits } = await gpu.requestAdapter();
  assert.equal(limits.maxTextureDimension2D, 8192, 'WebGPU default, though the context has 16384');
  assert.equal(limits.maxTextureDimension3D, 1024);
  assert.equal(limits.maxSampledTexturesPerShaderStage, 16);
  assert.equal(limits.minUniformBufferOffsetAlignment, 256, 'never below WebGPU minimum alignment');
  assert.equal(limits.maxInterStageShaderVariables, 15);
  assert.equal(limits.maxColorAttachments, 4, 'the smaller of attachments and draw buffers');
  assert.equal(limits.maxVertexBufferArrayStride, 255);
  assert.equal(limits.maxStorageBufferBindingSize, 134217728, 'WebGPU default: 2,048 x 16 x 16,384 bytes is more');
  assert.ok(Object.isFrozen(limits));
  // A small context caps storage bindings at what a 2,048-texel-wide RGBA32UI data texture of its size holds.
  const small = await createCompatGPU({
    createContext: () => fakeContext({ limits: { MAX_TEXTURE_SIZE: 2048 } }),
  }).requestAdapter();
  assert.equal(small.limits.maxStorageBufferBindingSize, 2048 * 16 * 2048);
});

test('features only where an extension backs them', async () => {
  const plain = await createCompatGPU({ createContext: () => fakeContext() }).requestAdapter();
  assert.deepEqual([...plain.features].sort(), ['depth32float-stencil8', 'rg11b10ufloat-renderable']);
  const rich = await createCompatGPU({
    createContext: () =>
      fakeContext({ extensions: ['EXT_color_buffer_float', 'OES_texture_float_linear', 'EXT_depth_clamp'] }),
  }).requestAdapter();
  assert.ok(rich.features.has('float32-filterable'));
  assert.ok(rich.features.has('depth-clip-control'));
});

test('requestDevice refuses features and limits the adapter lacks; isCompatDevice tells devices apart', async () => {
  const adapter = await createCompatGPU({ createContext: () => fakeContext() }).requestAdapter();
  await assert.rejects(adapter.requestDevice({ requiredFeatures: ['timestamp-query'] }), TypeError);
  await assert.rejects(
    adapter.requestDevice({ requiredLimits: { maxTextureDimension2D: 16384 } }),
    /maxTextureDimension2D is 4096/,
  );
  await assert.rejects(adapter.requestDevice({ requiredLimits: { maxNoSuchLimit: 1 } }), /Unknown limit/);
  assert.equal(isCompatDevice({}), false);
  assert.equal(isCompatDevice(null), false);
});
