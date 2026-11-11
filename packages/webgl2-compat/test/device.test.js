// The compatibility GPU and adapter on stand-in WebGL2 contexts (the device itself renders, so its checks run in a
// browser: compat-browser-check.mjs, corpus-draw-browser.mjs). Here: an adapter only for the `full` tier, WebGPU limits
// conservatively capped except for the negotiated hardware array-layer capacity, features only where an extension backs them, one device
// per adapter, and requests the adapter cannot meet refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS, webgl2Capabilities } from '../dist/index.js';
import {
  COMPAT_VENDOR,
  CompatCanvasContext,
  CompatDevice,
  CompatOutOfMemoryError,
  CompatQueue,
  createCompatGPU,
  isCompatDevice,
} from '../dist/device.js';

/** One task: the layer dispatches uncapturederror in a task of its own, as WebGPU does. */
const task = () => new Promise((resolve) => setTimeout(resolve, 0));

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

test('writeBuffer carries the copies-input mark @margoengine/animation trusts (known-bugs Batch 132 audit: animation)', () => {
  const mark = Symbol.for('margoengine.writeBuffer.copiesInput');
  assert.equal(CompatQueue.prototype.writeBuffer[mark], true);
  assert.equal(Object.getOwnPropertyDescriptor(CompatQueue.prototype.writeBuffer, mark).writable, false);
});

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

// Exercise the actual replay/cache with a recording GL context, without compiling or drawing on a GPU.
async function offsetDevice(withClamp) {
  const calls = [], requested = [];
  const context = fakeContext();
  const get = context.getExtension.bind(context);
  context.getExtension = (name) => {
    requested.push(name);
    if (name === 'EXT_polygon_offset_clamp')
      return withClamp ? { polygonOffsetClampEXT: (...args) => calls.push(['clamp', ...args]) } : null;
    return get(name);
  };
  const constants = ['DITHER', 'SCISSOR_TEST', 'CULL_FACE', 'DEPTH_TEST', 'STENCIL_TEST',
    'POLYGON_OFFSET_FILL', 'SAMPLE_ALPHA_TO_COVERAGE', 'ALWAYS', 'TRIANGLES', 'CW', 'FRONT', 'BACK',
    'EQUAL', 'NOTEQUAL', 'KEEP', 'REPLACE'];
  constants.forEach((name, i) => { context[name] = i + 1; });
  context.polygonOffset = (...args) => calls.push(['plain', ...args]);
  context.stencilFuncSeparate = (...args) => calls.push(['stencil', ...args]);
  const gl = new Proxy(context, { get: (target, key) => key in target ? target[key] : () => ({}) });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  const pass = { desc: { depth: { view: { texture: { info: { kind: 'depth' } } } } } };
  const apply = (bias, slope, clamp) => {
    device.replayer.applyPipeline({
      program: null, vao: null, cull: 0, frontFace: gl.CW, targets: [],
      depthStencil: { depthBias: bias, depthBiasSlopeScale: slope, depthBiasClamp: clamp },
    }, pass);
  };
  return { device, gl, calls, requested, apply };
}

test('indexed replay detaches the old element binding before selecting a replacement, and caches unchanged draws', async () => {
  const { device, gl } = await offsetDevice(false), calls = [];
  gl.ELEMENT_ARRAY_BUFFER = 0x8893;
  gl.bindBuffer = (...args) => calls.push(['bind', ...args]);
  gl.drawElementsInstanced = (...args) => calls.push(['draw', ...args]);
  const pipeline = { mode: 1, cache: { element: -1 } },
    a = { id: 1, element: {} }, b = { id: 2, element: {} },
    replay = device.replayer;
  replay.ready = () => pipeline;
  try {
    for (const buffer of [a, a, b, b, a]) {
      replay.pass = { index: { buffer, type: 0x1405, offset: 4, size: 4 } };
      replay.drawIndexed(10, 2, 1, 0, 0);
    }
    const draw = ['draw', 1, 10, 0x1405, 8, 2];
    assert.deepEqual(calls, [
      ['bind', gl.ELEMENT_ARRAY_BUFFER, null], ['bind', gl.ELEMENT_ARRAY_BUFFER, a.element], draw, draw,
      ['bind', gl.ELEMENT_ARRAY_BUFFER, null], ['bind', gl.ELEMENT_ARRAY_BUFFER, b.element], draw, draw,
      ['bind', gl.ELEMENT_ARRAY_BUFFER, null], ['bind', gl.ELEMENT_ARRAY_BUFFER, a.element], draw,
    ]);
  } finally { device.destroy(); }
});

test('stencil replay masks uint32 references before GL signed clamping and caches both faces by effective value', async () => {
  const { device, gl, calls } = await offsetDevice(false);
  const pass = { desc: { depth: { view: { texture: { info: { kind: 'depth-stencil' } } } } } };
  const pipeline = { program: null, vao: null, cull: 0, frontFace: gl.CW, targets: [],
    depthStencil: { stencilFront: { compare: 'equal', passOp: 'replace' },
      stencilBack: { compare: 'not-equal', passOp: 'replace' }, stencilReadMask: 0xf3 } };
  try {
    for (const reference of [0x1000005, 0x80000005, 0xffffffff, 0, 0x80000005]) {
      device.replayer.pass = pass;
      device.replayer.setStencilReference(reference);
      device.replayer.applyPipeline(pipeline, pass);
    }
    assert.deepEqual(calls.filter(([op]) => op === 'stencil'),
      [5, 255, 0, 5].flatMap((ref) => [
        ['stencil', gl.FRONT, device.compare('equal'), ref, 0xf3],
        ['stencil', gl.BACK, device.compare('not-equal'), ref, 0xf3],
      ]));
  } finally { device.destroy(); }
});

test('polygon offset loads its extension and caches the signed clamp, including reset to zero', async () => {
  const { device, calls, requested, apply } = await offsetDevice(true);
  try {
    assert.ok(requested.includes('EXT_polygon_offset_clamp'));
    apply(100000, 2, 1e-6);
    apply(100000, 2, 1e-6);
    apply(100000, 2, -1e-6);
    apply(100000, 2, 0);
    apply(100000, 2, 0);
    apply(0, 0, 0);
    apply(100000, 2, 1e-6);
    assert.deepEqual(calls, [
      ['clamp', 2, 100000, 1e-6], ['clamp', 2, 100000, -1e-6],
      ['clamp', 2, 100000, 0], ['clamp', 2, 100000, 1e-6],
    ]);
  } finally { device.destroy(); }
});

test('without polygon offset clamp, nonzero clamp refuses sync and async pipelines before compilation', async () => {
  const { device, calls, apply } = await offsetDevice(false);
  try {
    for (const depthBiasClamp of [1e-6, -1e-6]) {
      const descriptor = { layout: 'auto', vertex: { module: {} },
        depthStencil: { format: 'depth32float', depthBiasClamp } };
      const refusal = (e) => e.code === 'unsupported' && /EXT_polygon_offset_clamp/.test(e.message) && /https:/.test(e.message);
      assert.throws(() => device.createRenderPipeline(descriptor), refusal);
      await assert.rejects(device.createRenderPipelineAsync(descriptor), refusal);
    }
    assert.equal(device.programs.count, 0);
    apply(100000, 2, 0);
    apply(100000, 2, undefined);
    assert.deepEqual(calls, [['plain', 2, 100000]]);
  } finally { device.destroy(); }
});

test('limits come from the context, never above WebGPU defaults except storage bindings and buffers (what a data texture holds); vertex strides stop at WebGL 255 bytes', async () => {
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
  // Bug KB2604d (bug sweep L4): the layer held storage bindings and buffers at WebGPU's defaults (128 and 256 MiB),
  // though one data texture of maxTextureDimension2D squared RGBA32UI texels reads 1 GiB and the compute tier writes
  // through as many word textures as a buffer needs, so a 325 MB SH binding (the 1,692,538-splat truck) was refused.
  assert.equal(limits.maxStorageBufferBindingSize, 16 * 8192 * 8192, 'one 8,192 x 8,192 RGBA32UI data texture');
  assert.equal(limits.maxBufferSize, 16 * 8192 * 8192, 'a storage binding can span a whole buffer');
  assert.ok(Object.isFrozen(limits));
  // A small context caps storage bindings at what a 2,048-texel-wide RGBA32UI data texture of its size holds.
  const small = await createCompatGPU({
    createContext: () => fakeContext({ limits: { MAX_TEXTURE_SIZE: 2048 } }),
  }).requestAdapter();
  assert.equal(small.limits.maxStorageBufferBindingSize, 2048 * 16 * 2048);
  assert.equal(small.limits.maxBufferSize, 268435456, 'never below the WebGPU default');
});

// Bug (KB2604d follow-up, bug sweep L4): a device took every adapter limit, so once the adapter offered more than
// WebGPU's defaults, a device made without requiredLimits had 1 GiB storage bindings where a WebGPU device has 128 MiB
// (the vfx scale check sized its default-device capacity from them and passed VFX's own slot cap). As in WebGPU, a
// limit the adapter raises past the default needs requiredLimits.
test('a device has the WebGPU default storage binding and buffer sizes unless it asks for more', async () => {
  const fresh = async () => {
    const gl = new Proxy(fakeContext({ limits: { MAX_TEXTURE_SIZE: 8192 } }), {
      get: (context, key) => (key in context ? context[key] : () => ({})),
    });
    return createCompatGPU({ createContext: () => gl }).requestAdapter();
  };
  const plain = await (await fresh()).requestDevice();
  assert.equal(plain.limits.maxStorageBufferBindingSize, 134217728);
  assert.equal(plain.limits.maxBufferSize, 268435456);
  const adapter = await fresh(),
    raised = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
  assert.equal(raised.limits.maxStorageBufferBindingSize, 1 << 30);
  assert.equal(raised.limits.maxBufferSize, 1 << 30);
  // A requirement below the default still gives the default, as in WebGPU.
  const low = await (await fresh()).requestDevice({ requiredLimits: { maxBufferSize: 1024 } });
  assert.equal(low.limits.maxBufferSize, 268435456);
  plain.destroy();
  raised.destroy();
  low.destroy();
});

// Bug KBnew-compat-maxbuffer (bug sweep L3): createBuffer allocated any size, past the device's maxBufferSize, where
// WebGPU raises a validation error and hands back an invalid buffer (and a RangeError for one mapped at creation).
test('createBuffer refuses a size past the device maxBufferSize, as WebGPU does', async () => {
  const allocated = [];
  const gl = new Proxy(fakeContext({ limits: { MAX_TEXTURE_SIZE: 8192 } }), {
    get: (context, key) =>
      key === 'bufferData' ? (target, size) => allocated.push(size) : key in context ? context[key] : () => ({}),
  });
  const device = await (await createCompatGPU({ createContext: () => gl }).requestAdapter()).requestDevice();
  const most = device.limits.maxBufferSize;
  device.pushErrorScope('validation');
  const fits = device.createBuffer({ size: most, usage: 0x80 | 0x8 });
  assert.equal(await device.popErrorScope(), null, 'maxBufferSize itself is allowed');
  assert.ok(allocated.includes(most));
  allocated.length = 0;
  device.pushErrorScope('validation');
  const over = device.createBuffer({ size: most + 4, usage: 0x80 | 0x8, label: 'big' });
  assert.match((await device.popErrorScope())?.message ?? '', /createBuffer 'big': 268435460 bytes is over this device's maxBufferSize of 268435456/);
  assert.equal(over.size, most + 4, 'an invalid buffer keeps the size asked for');
  assert.deepEqual(allocated, [], 'nothing is allocated for it');
  over.destroy();
  assert.throws(() => device.createBuffer({ size: most + 4, usage: 0x1, mappedAtCreation: true }), RangeError);
  fits.destroy();
  device.destroy();
});

test('array layer capacity is advertised from GL and negotiated independently for each device', async () => {
  for (const capacity of [256, 2048, 4096]) {
    const fresh = async () => {
      const context = fakeContext({ limits: { MAX_ARRAY_TEXTURE_LAYERS: capacity } });
      const gl = new Proxy(context, { get: (target, key) => key in target ? target[key] : () => ({}) });
      return createCompatGPU({ createContext: () => gl }).requestAdapter();
    };
    const plainAdapter = await fresh();
    assert.equal(plainAdapter.limits.maxTextureArrayLayers, capacity, 'adapter advertises the backed capacity');
    const plain = await plainAdapter.requestDevice();
    assert.equal(plain.limits.maxTextureArrayLayers, 256, 'an unrequested device keeps the WebGPU default');
    assert.ok(Object.isFrozen(plain.limits));
    plain.destroy();
    const requestedAdapter = await fresh();
    const requested = await requestedAdapter.requestDevice({ requiredLimits: { maxTextureArrayLayers: capacity } });
    assert.equal(requested.limits.maxTextureArrayLayers, capacity, 'the full requested capacity reaches the device');
    assert.equal(requestedAdapter.limits.maxTextureArrayLayers, capacity, 'negotiating leaves the adapter unchanged');
    requested.destroy();
    const below = await (await fresh()).requestDevice({ requiredLimits: { maxTextureArrayLayers: 128 } });
    assert.equal(below.limits.maxTextureArrayLayers, 256, 'a lower request never reduces the default');
    below.destroy();
    const refused = await fresh();
    assert.throws(() => new CompatDevice({}, refused, new Set(), {
      requiredLimits: { maxTextureArrayLayers: capacity + 1 },
    }), { name: 'RangeError', message: /use adapter\.limits\.maxTextureArrayLayers or fewer layers/ },
    'direct construction refuses before touching GL and gives the remedy');
    await assert.rejects(refused.requestDevice({ requiredLimits: { maxTextureArrayLayers: capacity + 1 } }),
      { name: 'OperationError' });
    const recovered = await refused.requestDevice({ requiredLimits: { maxTextureArrayLayers: capacity } });
    assert.equal(recovered.limits.maxTextureArrayLayers, capacity, 'an invalid request does not consume the adapter');
    recovered.destroy();
  }
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
  // A compressed family only with every extension it needs: BC without BPTC is not BC.
  const bc = ['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'EXT_texture_compression_rgtc'];
  const some = await createCompatGPU({
    createContext: () => fakeContext({ extensions: ['EXT_color_buffer_float', ...bc, 'WEBGL_compressed_texture_etc'] }),
  }).requestAdapter();
  assert.ok(!some.features.has('texture-compression-bc'));
  assert.ok(some.features.has('texture-compression-etc2'));
  assert.ok(!some.features.has('texture-compression-astc'));
  const all = await createCompatGPU({
    createContext: () => fakeContext({ extensions: ['EXT_color_buffer_float', ...bc, 'EXT_texture_compression_bptc'] }),
  }).requestAdapter();
  assert.ok(all.features.has('texture-compression-bc'));
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

// Bug (sciviz surface on the layer: "Uniform p.time is missing"): a browser without a WebGPU adapter may still define
// the native GPUBuffer interface, so the layer's buffers failed `instanceof GPUBuffer` and the compute package encoded
// its own uniform buffer as if it were the uniform's value. install() now names the layer's classes as the interfaces.
test('install() names the layer classes as the WebGPU interfaces while installed, and uninstall() restores them', async () => {
  const { installCompat, uninstallCompat, CompatBuffer, CompatDevice, CompatTexture } = await import(
    '../dist/device.js'
  );
  const saved = ['navigator', 'OffscreenCanvas', 'GPUBuffer', 'GPUDevice'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  class NativeBuffer {}
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'GPUBuffer', { value: NativeBuffer, configurable: true, writable: true });
  delete globalThis.GPUDevice;
  globalThis.OffscreenCanvas = class {
    getContext() {
      return fakeContext();
    }
  };
  try {
    const result = await installCompat();
    assert.equal(result.installed, true);
    assert.equal(globalThis.GPUBuffer, CompatBuffer, 'the native interface is replaced while installed');
    assert.equal(globalThis.GPUTexture, CompatTexture);
    assert.ok(Object.create(CompatBuffer.prototype) instanceof GPUBuffer);
    assert.ok(Object.create(CompatDevice.prototype) instanceof GPUDevice);
    assert.equal(uninstallCompat(), true);
    assert.equal(globalThis.GPUBuffer, NativeBuffer, 'uninstall() puts the native interface back');
    assert.equal('GPUDevice' in globalThis, false, 'an interface the browser lacked is removed again');
  } finally {
    uninstallCompat();
    for (const [name, own] of saved)
      if (own) Object.defineProperty(globalThis, name, own);
      else delete globalThis[name];
  }
});

// Bug (KB-C34c, restore fault sweep on the layer): install() named the layer's GPUOutOfMemoryError but left the
// browser's GPUUncapturedErrorEvent and GPUError, so `new GPUUncapturedErrorEvent('uncapturederror', { error })` with
// the layer's error threw a TypeError ("Failed to convert value to 'GPUError'") and the error was never dispatched, and
// the layer's own events were plain Events. Both interfaces are now the layer's while it is installed.
test('install() names GPUError and GPUUncapturedErrorEvent too, and the device dispatches that event', async () => {
  const { installCompat, uninstallCompat, CompatGPUError, CompatUncapturedErrorEvent } = await import(
    '../dist/device.js'
  );
  const names = ['navigator', 'OffscreenCanvas', 'GPUError', 'GPUOutOfMemoryError', 'GPUUncapturedErrorEvent'];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  class NativeError {}
  class NativeEvent extends Event {
    constructor(type, init) {
      if (!(init?.error instanceof NativeError)) throw new TypeError("Failed to convert value to 'GPUError'");
      super(type, init);
    }
  }
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'GPUError', { value: NativeError, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'GPUUncapturedErrorEvent', {
    value: NativeEvent,
    configurable: true,
    writable: true,
  });
  globalThis.OffscreenCanvas = class {
    getContext() {
      return fakeContext();
    }
  };
  try {
    assert.equal((await installCompat()).installed, true);
    assert.equal(globalThis.GPUError, CompatGPUError);
    assert.equal(globalThis.GPUUncapturedErrorEvent, CompatUncapturedErrorEvent);
    const error = new GPUOutOfMemoryError('refused');
    assert.ok(error instanceof GPUError);
    const event = new GPUUncapturedErrorEvent('uncapturederror', { error });
    assert.equal(event.error, error);
    assert.throws(() => new GPUUncapturedErrorEvent('uncapturederror', {}), TypeError);
    // The device's own uncaptured errors arrive as that event.
    const gl = new Proxy(fakeContext(), { get: (context, key) => (key in context ? context[key] : () => ({})) });
    const device = await (await createCompatGPU({ createContext: () => gl }).requestAdapter()).requestDevice();
    let heard;
    device.addEventListener('uncapturederror', (e) => (e.preventDefault(), (heard = e)));
    device.queue.writeBuffer(device.createBuffer({ size: 4, usage: 8 }), 0, new Uint8Array(3));
    assert.equal(heard, undefined, 'dispatched in a task of its own, never inside the call');
    await task();
    assert.ok(heard instanceof GPUUncapturedErrorEvent);
    assert.ok(heard.error instanceof GPUError);
    device.destroy();
  } finally {
    uninstallCompat();
    for (const [name, own] of saved)
      if (own) Object.defineProperty(globalThis, name, own);
      else delete globalThis[name];
  }
});

// Bug (the compute lab's sort came back unsorted with nothing in the console): an uncaptured error nobody prevented
// was dropped silently; browsers show it in the console, and so does the layer now.
test('an uncaptured error shows in the console unless a listener prevents it, as in browsers', async () => {
  // A device needs a whole context: the stand-in answers every other GL call with an empty object.
  const gl = new Proxy(fakeContext(), { get: (context, key) => (key in context ? context[key] : () => ({})) });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  const warned = [],
    warn = console.warn;
  console.warn = (message) => warned.push(message);
  try {
    device.internalError('over the work budget');
    await task();
    assert.deepEqual(warned, ['WebGL2 compatibility: uncaptured GPUInternalError: over the work budget']);
    const seen = [];
    device.addEventListener('uncapturederror', (event) => {
      seen.push(event.error.message);
      event.preventDefault();
    });
    device.validationError('handled');
    await task();
    assert.deepEqual(seen, ['handled']);
    assert.equal(warned.length, 1, 'a prevented error is not shown');
  } finally {
    console.warn = warn;
  }
});

// Bug (Chrome 157 on an Apple M6, the lines suite on the layer: `Target crashed`): destroy() lost the context while the
// page canvas showed an ImageBitmap of it, and that image is invalid after the loss. The canvas takes its own copy
// first; destroy-frame-browser.mjs proves it on a real tab.
test('destroy() moves each frame on the page off the context before it loses the context', async () => {
  const gl = new Proxy(fakeContext(), { get: (context, key) => (key in context ? context[key] : () => ({})) });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  const seen = [];
  device.shown.add({ keepFrame: () => seen.push(gl.lost) });
  device.destroy();
  device.destroy();
  assert.deepEqual(seen, [false], 'once, while the context still lives');
  assert.equal(gl.lost, true);
});

test('keepFrame() replaces the shown image with a copy made outside the WebGL2 context', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'),
    calls = [];
  const bitmap = { name: 'copy' };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      calls.push(['size', width, height]);
    }
    getContext(type) {
      calls.push(['context', type]);
      const context = {
        drawImage: (source, x, y) => calls.push(['draw', source, x, y, context.globalCompositeOperation]),
      };
      return context;
    }
    transferToImageBitmap() {
      return bitmap;
    }
  };
  try {
    const canvas = { width: 3, height: 2 };
    const context = new CompatCanvasContext(canvas, () => null);
    context.keepFrame();
    assert.deepEqual(calls, [], 'nothing shown, nothing to copy');
    const shown = [];
    context.output = { transferFromImageBitmap: (b) => shown.push(b) };
    context.keepFrame();
    assert.deepEqual(calls, [
      ['size', 3, 2],
      ['context', '2d'],
      ['draw', canvas, 0, 0, 'copy'],
    ]);
    assert.deepEqual(shown, [bitmap]);
    canvas.width = 0;
    context.keepFrame();
    assert.equal(shown.length, 1, 'a canvas of no size has nothing to copy, and drawImage would throw');
    context.output = { drawImage() {} };
    canvas.width = 3;
    calls.length = 0;
    context.keepFrame();
    assert.deepEqual(calls, [], 'a 2d canvas owns its pixels');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'OffscreenCanvas', saved);
    else delete globalThis.OffscreenCanvas;
  }
});

// Bug (scripts/modern-postfx-tests.js --compat, the auto-exposure meter): a 32-byte buffer bound where the shader's
// uniform is 64 bytes reached the CPU tier, which read past the buffer's end (`RangeError: Offset is outside the bounds
// of the DataView`). As in WebGPU, createBindGroup now reports a validation error and a pass binds nothing for the group.
test('createBindGroup refuses a buffer range below the minimum binding size or past the buffer end', async () => {
  const gl = new Proxy(fakeContext(), { get: (context, key) => (key in context ? context[key] : () => ({})) });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  const layout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: 4, buffer: { type: 'uniform', minBindingSize: 64 } }],
  });
  const small = device.createBuffer({ size: 32, usage: 0x40 | 0x8 }),
    big = device.createBuffer({ size: 128, usage: 0x40 | 0x8 });
  const errorOf = (resource) => {
    device.pushErrorScope('validation');
    const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource }] });
    return device.popErrorScope().then((error) => ({ error, group }));
  };
  const tooSmall = await errorOf({ buffer: small });
  assert.match(tooSmall.error?.message ?? '', /32 bytes, below the layout's minimum binding size of 64/);
  assert.ok(tooSmall.group.invalid);
  const pastEnd = await errorOf({ buffer: big, offset: 96, size: 64 });
  assert.match(pastEnd.error?.message ?? '', /bytes 96 to 160 are outside the 128-byte buffer/);
  const fine = await errorOf({ buffer: big, offset: 64 });
  assert.equal(fine.error, null);
  assert.equal(fine.group.invalid, null);
  device.destroy();
});

// Bug (limits audit): on a 2048 context a storage binding is at most 64 MiB (2,048-wide RGBA32UI rows), but a larger
// one, or several that together pass one data texture, reached GL unchecked and failed there. As in WebGPU, createBindGroup
// now reports a validation error naming the limit, and the group binds nothing.
test('createBindGroup refuses a storage binding over maxStorageBufferBindingSize and groups past one data texture', async () => {
  const gl = new Proxy(fakeContext({ limits: { MAX_TEXTURE_SIZE: 2048 } }), {
    get: (context, key) => (key in context ? context[key] : () => ({})),
  });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  assert.equal(device.limits.maxStorageBufferBindingSize, 64 * 1024 * 1024);
  const layout = (count) =>
    device.createBindGroupLayout({
      entries: Array.from({ length: count }, (_, binding) => ({ binding, visibility: 4, buffer: { type: 'read-only-storage' } })),
    });
  const buffer = device.createBuffer({ size: 64 * 1024 * 1024 + 16, usage: 0x80 | 0x8 });
  const errorOf = (count, entries) => {
    device.pushErrorScope('validation');
    const group = device.createBindGroup({ layout: layout(count), entries });
    return device.popErrorScope().then((error) => ({ error, group }));
  };
  const over = await errorOf(1, [{ binding: 0, resource: { buffer } }]);
  assert.match(over.error?.message ?? '', /storage binding is 67108880 bytes, over this device's maxStorageBufferBindingSize of 67108864/);
  assert.ok(over.group.invalid);
  const half = 40 * 1024 * 1024,
    two = await errorOf(2, [
      { binding: 0, resource: { buffer, size: half } },
      { binding: 1, resource: { buffer: device.createBuffer({ size: half, usage: 0x80 | 0x8 }) } },
    ]);
  assert.match(two.error?.message ?? '', /storage bindings total 83886080 bytes, over the 67108864 bytes one WebGL2 data texture/);
  const fine = await errorOf(1, [{ binding: 0, resource: { buffer, size: 64 * 1024 * 1024 } }]);
  assert.equal(fine.error, null);
  assert.equal(fine.group.invalid, null);
  device.destroy();
});

// Bug (bug sweep L3, red on main since 1e5d2f94d3): a 3,000,000-splat cloud's projection group binds 360,000,016 bytes
// of storage, each binding within maxStorageBufferBindingSize, and the layer refused it because its shared data texture
// stopped at 2,048 texels wide (2,048 x 8,192 rows, 256 MiB). WebGPU sets no total per bind group; the texture now
// grows wider instead, up to maxTextureDimension2D on both sides.
test('a bind group whose storage bindings pass 2,048 x maxTextureDimension2D rows gets a wider data texture', async () => {
  const storage = [];
  const gl = new Proxy(fakeContext({ limits: { MAX_TEXTURE_SIZE: 8192 } }), {
    get: (context, key) =>
      key === 'texStorage2D' ? (...args) => storage.push(args.slice(3)) : key in context ? context[key] : () => ({}),
  });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  assert.equal(device.limits.maxTextureDimension2D, 8192);
  const size = 120_000_000,
    layout = device.createBindGroupLayout({
      entries: [0, 1, 2].map((binding) => ({ binding, visibility: 4, buffer: { type: 'read-only-storage' } })),
    });
  device.pushErrorScope('validation');
  const group = device.createBindGroup({
    layout,
    entries: [0, 1, 2].map((binding) => ({
      binding,
      resource: { buffer: device.createBuffer({ size, usage: 0x80 | 0x8 }) },
    })),
  });
  assert.equal(await device.popErrorScope(), null);
  assert.equal(group.invalid, null);
  const data = group.storageTexture();
  // 22,500,000 rows: 2,048 wide would be 10,987 high, past 8,192; 4,096 wide is 5,494 high.
  assert.equal(data.shift, 12);
  assert.deepEqual(storage.at(-1), [4096, 5494]);
  assert.deepEqual([...data.rows], [[0, 0], [1, 7_500_000], [2, 15_000_000]]);
  // Past maxTextureDimension2D squared rows (1 GiB here) a group still cannot be held.
  const big = device.createBuffer({ size: 128 * 1024 * 1024, usage: 0x80 | 0x8 }),
    nine = device.createBindGroupLayout({
      entries: Array.from({ length: 9 }, (_, binding) => ({ binding, visibility: 4, buffer: { type: 'read-only-storage' } })),
    });
  device.pushErrorScope('validation');
  device.createBindGroup({ layout: nine, entries: Array.from({ length: 9 }, (_, binding) => ({ binding, resource: { buffer: big } })) });
  assert.match((await device.popErrorScope())?.message ?? '', /storage bindings total 1207959552 bytes, over the 1073741824 bytes/);
  device.destroy();
});

// Bug KB5128a (bug sweep L3): mapAsync ignored its offset and size, and getMappedRange handed out any range, overlapping
// ones included, so a write through one range could be lost under another at unmap. Both now follow WebGPU's rules.
test('mapAsync and getMappedRange keep to the mapped range, aligned and without overlaps', async () => {
  const gl = new Proxy(fakeContext(), { get: (context, key) => (key in context ? context[key] : () => ({})) });
  const device = await (await createCompatGPU({ createContext: () => gl }).requestAdapter()).requestDevice();
  const read = device.createBuffer({ size: 64, usage: 0x1 | 0x8 });
  device.pushErrorScope('validation');
  for (const [mode, offset, size] of [[1, 4], [1, 8, 6], [1, 32, 64], [2, 0], [3, 0]])
    await assert.rejects(read.mapAsync(mode, offset, size), { name: 'OperationError' }, `${mode} ${offset} ${size}`);
  assert.match((await device.popErrorScope())?.message ?? '', /^mapAsync: /);
  assert.equal(read.mapState, 'unmapped');
  const made = device.createBuffer({ size: 64, usage: 0x8, mappedAtCreation: true });
  const first = made.getMappedRange(8, 16);
  assert.equal(first.byteLength, 16);
  for (const [offset, size] of [[4, 8], [8, 8], [16, 8], [56, 16], [8, 6]])
    assert.throws(() => made.getMappedRange(offset, size), { name: 'OperationError' }, `${offset} ${size}`);
  assert.equal(made.getMappedRange(24).byteLength, 40);
  made.unmap();
  device.destroy();
});

// Explicit installation on a native WebGPU browser must explain why the renderer did not change.
test('install keeps native WebGPU with a coded warning and forcing installs the full layer', async () => {
  const { installCompat, uninstallCompat } = await import('../dist/device.js');
  const saved = ['navigator', 'OffscreenCanvas'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  const native = { requestAdapter: async () => ({}) };
  const warnings = [];
  const warn = console.warn;
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: native }, configurable: true });
  globalThis.OffscreenCanvas = class {
    getContext() {
      return fakeContext();
    }
  };
  console.warn = (value) => warnings.push(value);
  try {
    assert.deepEqual(await installCompat(), { installed: false, reason: 'webgpu' });
    assert.equal(navigator.gpu, native);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].name, 'MargoError');
    assert.equal(warnings[0].code, 'state');
    assert.match(warnings[0].message, /WebGPU kept/);
    assert.match(warnings[0].message, /force: true/);
    assert.match(warnings[0].message, /backend 'webgpu'/);
    assert.match(warnings[0].message, /https:\/\/margoengine.com\/errors#compatibility-layer/);
    assert.equal((await installCompat({ force: true })).installed, true);
    assert.notEqual(navigator.gpu, native);
    assert.equal(warnings.length, 1, 'forced installation has no native-retained warning');
  } finally {
    uninstallCompat();
    console.warn = warn;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test('compact installer diagnostics retain unavailable APIs, missing capabilities and coded help', async () => {
  const { installCompat, uninstallCompat } = await import('../dist/device.js');
  const saved = ['navigator', 'OffscreenCanvas'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  const set = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true });
  try {
    set('navigator', undefined);
    await assert.rejects(installCompat(), (error) => error instanceof TypeError && /navigator/.test(error.message));
    set('navigator', {});
    set(
      'OffscreenCanvas',
      class {
        getContext() {
          return null;
        }
      },
    );
    await assert.rejects(installCompat(), (error) => {
      assert.equal(error.code, 'unsupported');
      assert.match(error.message, /WebGPU/);
      assert.match(error.message, /WebGL2/);
      assert.match(error.message, /https:\/\/margoengine.com\/errors#compatibility-layer/);
      return true;
    });
    const missing = webgl2Capabilities(fakeContext({ extensions: [] })).missing;
    assert.ok(missing.length > 0);
    set(
      'OffscreenCanvas',
      class {
        getContext() {
          return fakeContext({ extensions: [] });
        }
      },
    );
    await assert.rejects(installCompat(), (error) => {
      assert.equal(error.code, 'unsupported');
      for (const capability of missing) assert.ok(error.message.includes(capability), capability);
      assert.match(error.message, /https:\/\/margoengine.com\/errors#compatibility-layer/);
      return true;
    });
    assert.equal(uninstallCompat(), false, 'preflight refusals install nothing');
  } finally {
    uninstallCompat();
    for (const [name, own] of saved)
      if (own) Object.defineProperty(globalThis, name, own);
      else delete globalThis[name];
  }
});
test('texture replay selects stencil aspects, restores depth and isolates simultaneous aspects', async () => {
  const { device, gl, requested } = await offsetDevice(false);
  const modes = [], aliases = [];
  gl.TEXTURE_2D = 0x0de1;
  gl.DEPTH_COMPONENT = 0x1902;
  gl.texParameteri = (_target, pname, value) => modes.push([pname, value]);
  device.ext.stencilTexturing = { DEPTH_STENCIL_TEXTURE_MODE_WEBGL: 0x90ea, STENCIL_INDEX_WEBGL: 0x1901 };
  const stores = [0, 1].map((id) => ({ gl: { id }, target: gl.TEXTURE_2D, levels: '0:0' }));
  const texture = {
    info: { kind: 'depth-stencil' }, renderbuffer: null,
    sampled(_view, alias = 0) { aliases.push(alias); return stores[alias]; },
    read() {},
  };
  const view = (aspect) => ({ texture, aspect, baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 });
  const bind = (aspects) => {
    const pipeline = { program: {}, finish() {}, uniforms: [], storage: [], attributes: [],
      textures: aspects.map((_a, binding) => ({ group: 0, binding, unit: binding, modes: [], sizes: [], levels: [] })) };
    device.replayer.pass = { pipeline, desc: {}, groups: [{ group: {
      layout: { dynamic: [] }, entries: new Map(aspects.map((aspect, i) => [i, { kind: 'view', view: view(aspect) }])) },
      offsets: [] }] };
    device.replayer.draw(3, 1, 0, 0);
  };
  device.replayer.applyPipeline = () => {};
  try {
    assert.ok(requested.includes('WEBGL_stencil_texturing'));
    bind(['stencil-only']);
    bind(['depth-only']);
    bind(['depth-only', 'stencil-only']);
    assert.deepEqual(modes.filter(([p]) => p === 0x90ea).map(([, v]) => v), [0x1901, 0x1902, 0x1902, 0x1901]);
    assert.deepEqual(aliases, [0, 0, 0, 0, 1], 'simultaneous aspects need separate GL texture state');
    texture.info.kind = 'stencil';
    bind(['all']);
    assert.equal(modes.at(-1)[1], 0x1901, 'stencil8 uses its physical packed stencil aspect by default');
    texture.info.kind = 'depth-stencil';
    device.ext.stencilTexturing = null;
    assert.throws(() => bind(['stencil-only']), (error) => error.code === 'unsupported' && /WEBGL_stencil_texturing/.test(error.message));
  } finally { device.destroy(); }
});

test('explicit render layouts must declare every statically used resource with stage visibility', async () => {
  const { device } = await offsetDevice(false);
  try {
    const module = device.createShaderModule({
      code: `
@group(1) @binding(3) var t:texture_2d<f32>;
@vertex fn v()->@builtin(position) vec4f {return vec4f(0,0,0,1);}
@fragment fn f()->@location(0) vec4f {return textureLoad(t,vec2i(0),0);}`,
    });
    for (const entries of [[], [{ binding: 3, visibility: 1, texture: {} }]]) {
      const layout = device.createPipelineLayout({
        bindGroupLayouts: [device.createBindGroupLayout({ entries: [] }), device.createBindGroupLayout({ entries })],
      });
      device.pushErrorScope('validation');
      await assert.rejects(
        device.createRenderPipelineAsync({
          layout,
          vertex: { module, entryPoint: 'v' },
          fragment: { module, entryPoint: 'f', targets: [{ format: 'rgba8unorm' }] },
        }),
        /layout omits group 1 binding 3/,
      );
      assert.equal(await device.popErrorScope(), null, 'async validation is delivered through pipeline rejection');
      device.pushErrorScope('validation');
      device.createRenderPipeline({layout, vertex:{module,entryPoint:'v'}, fragment:{module,entryPoint:'f',targets:[{format:'rgba8unorm'}]}});
      assert.match((await device.popErrorScope()).message, /layout omits/);
    }
  } finally {
    device.destroy();
  }
});

test('pipelines whose WGSL differs only in binding numbers share a GL program but each keep their own binding table', async () => {
  // WebKit sweep: terrain modules with the holes texture at binding 6 and at binding 8 translate to the same GLSL. The
  // second pipeline took the first's cached binding table and drew with nothing bound at binding 6.
  const { device } = await offsetDevice(false);
  try {
    const code = (holes, frame) => `
@group(0) @binding(${frame}) var<uniform> frame:vec4f;
@group(0) @binding(${holes}) var holes:texture_2d<f32>;
@vertex fn v()->@builtin(position) vec4f {return frame;}
@fragment fn f()->@location(0) vec4f {return textureLoad(holes,vec2i(0),0)+frame;}`;
    const pipelines = [
      [6, 0],
      [8, 0],
      [6, 2],
    ].map(([holes, frame]) => {
      const module = device.createShaderModule({ code: code(holes, frame) });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'v' },
        fragment: { module, entryPoint: 'f', targets: [{ format: 'rgba8unorm' }] },
      });
    });
    const table = (p) => ({
      textures: p.textures.map((t) => t.binding),
      uniforms: p.uniforms.map((u) => u.binding),
    });
    assert.deepEqual(pipelines.map(table), [
      { textures: [6], uniforms: [0] },
      { textures: [8], uniforms: [0] },
      { textures: [6], uniforms: [2] },
    ]);
    // The same WGSL again still reuses its program.
    const again = device.createShaderModule({ code: code(8, 0) }),
      reused = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: again, entryPoint: 'v' },
        fragment: { module: again, entryPoint: 'f', targets: [{ format: 'rgba8unorm' }] },
      });
    assert.equal(reused.program, pipelines[1].program);
  } finally {
    device.destroy();
  }
});

// WebGL2 reports a store the driver could not make only through getError (GL_OUT_OF_MEMORY), and the buffer or texture
// then reads as empty: the layer never asked, so a failed allocation drew silently (docs/known-bugs.md, the path
// tracer's analytic lows). It is now an out-of-memory error, as WebGPU reports one, to its scope or uncapturederror.
test('an allocation the driver refuses is an out-of-memory error, to its scope or uncaptured', async () => {
  const errors = [];
  let calls = 0;
  const context = Object.assign(fakeContext(), {
    RGBA8: 0x8058,
    TEXTURE_2D: 0x0de1,
    getError: () => (calls++, errors.shift() ?? 0),
    isContextLost: () => false,
  });
  const gl = new Proxy(context, { get: (c, key) => (key in c ? c[key] : () => ({})) });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  const before = calls;
  device.pushErrorScope('out-of-memory');
  errors.push(0x0505);
  device.createBuffer({ label: 'huge', size: 1 << 20, usage: 0x80 | 0x8 });
  const error = await device.popErrorScope();
  assert.equal(error?.name, 'GPUOutOfMemoryError');
  assert.ok(error instanceof CompatOutOfMemoryError);
  assert.match(error.message, /out of memory for buffer 'huge'/);
  // A texture's storage too; with no scope open it is uncaptured.
  const uncaptured = [];
  device.addEventListener('uncapturederror', (event) => (event.preventDefault(), uncaptured.push(event.error)));
  errors.push(0x0505);
  device.createTexture({ label: 'big', size: [4096, 4096], format: 'rgba8unorm', usage: 0x4 });
  await task();
  assert.equal(uncaptured.length, 1);
  assert.equal(uncaptured[0].name, 'GPUOutOfMemoryError');
  assert.match(uncaptured[0].message, /texture 'big'/);
  // A clean allocation reports nothing, and costs one getError.
  device.pushErrorScope('out-of-memory');
  const n = calls;
  device.createBuffer({ size: 256, usage: 0x80 | 0x8 });
  assert.equal(calls - n, 1);
  assert.equal(await device.popErrorScope(), null);
  assert.ok(calls > before);
});
