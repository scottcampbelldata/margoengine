// A stand-in WebGL2 context that logs every call, for CPU tests of what the layer asks GL to do.
import { COMPAT_LIMITS } from '../../dist/index.js';
import { createCompatGPU } from '../../dist/device.js';

const EXTENSIONS = [
  'EXT_color_buffer_float',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_compressed_texture_s3tc_srgb',
  'EXT_texture_compression_rgtc',
  'EXT_texture_compression_bptc',
];

/** A stand-in context that logs every call by name, with its arguments; enums are numbers of their own. */
export function loggingContext() {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const values = new Map(COMPAT_LIMITS.map((name, i) => [0x1000 + i, 4096]));
  const calls = [];
  const named = new Map();
  const context = {
    ...enums,
    FRAGMENT_SHADER: 0x8b30,
    VERTEX_SHADER: 0x8b31,
    HIGH_FLOAT: 0x8df2,
    HIGH_INT: 0x8df5,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    LINK_STATUS: 0x8b82,
    INVALID_INDEX: 0xffffffff,
    calls,
    getExtension: (name) =>
      EXTENSIONS.includes(name)
        ? new Proxy({}, { get: (_, key) => (typeof key === 'string' && /^[A-Z]/.test(key) ? 0xa000 : undefined) })
        : null,
    getParameter: (p) => (p === 0x1f01 ? 'Stand-in renderer' : (values.get(p) ?? '')),
    getShaderPrecisionFormat: (_shader, type) =>
      type === 0x8df2 ? { precision: 23, rangeMin: 127, rangeMax: 127 } : { precision: 0, rangeMin: 31, rangeMax: 30 },
    getProgramParameter: () => true,
    getUniformBlockIndex: () => 0xffffffff,
    getUniformLocation: () => null,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    isContextLost: () => false,
    getError: () => 0,
    getInternalformatParameter: () => Int32Array.of(4),
  };
  for (const kind of ['Buffer', 'Texture', 'Framebuffer', 'Renderbuffer', 'Sampler', 'Program', 'Shader', 'VertexArray', 'Query'])
    context[`create${kind}`] = () => ({ kind });
  context.fenceSync = () => ({ kind: 'Sync' });
  const proxy = new Proxy(context, {
    get(target, key) {
      if (typeof key === 'string' && /^[A-Z][A-Z0-9_]*$/.test(key) && !(key in target)) {
        if (!named.has(key)) named.set(key, 0x9000 + named.size);
        return named.get(key);
      }
      const value = key in target ? target[key] : () => ({});
      if (typeof value !== 'function' || key === 'getExtension') return value;
      return (...args) => {
        calls.push([key, ...args]);
        if (key === 'checkFramebufferStatus') return proxy.FRAMEBUFFER_COMPLETE;
        if (key === 'getSyncParameter') return proxy.SIGNALED;
        if (key === 'clientWaitSync') return proxy.CONDITION_SATISFIED;
        return value(...args);
      };
    },
  });
  return proxy;
}

export async function loggingDevice(features = []) {
  const gl = loggingContext();
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  return { gl, device: await adapter.requestDevice({ requiredFeatures: features }) };
}

