// A stand-in WebGPU device for allocation probes: every call returns an object made once, so a probe that measures the
// JavaScript heap sees only the engine's own allocations (a browser's GPU wrappers are measured by
// scripts/frame-alloc-browser.mjs). It records nothing and checks nothing.
import { GPURenderer } from '../../packages/core/dist/renderer.js';

globalThis.GPUBufferUsage ??= {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
};
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

const noop = () => {};
const view = {},
  layout = {},
  group = {},
  sampler = {},
  module = {},
  commands = {},
  pass = Object.fromEntries(
    [
      'setPipeline',
      'setBindGroup',
      'setVertexBuffer',
      'setIndexBuffer',
      'setViewport',
      'setScissorRect',
      'setStencilReference',
      'setBlendConstant',
      'draw',
      'drawIndexed',
      'drawIndirect',
      'drawIndexedIndirect',
      'dispatchWorkgroups',
      'dispatchWorkgroupsIndirect',
      'executeBundles',
      'end',
    ].map((name) => [name, noop]),
  ),
  texture = {
    createView: () => view,
    destroy: noop,
    width: 64,
    height: 64,
    depthOrArrayLayers: 1,
    format: 'depth32float',
    sampleCount: 1,
  },
  pipeline = { getBindGroupLayout: () => layout },
  encoder = {
    beginRenderPass: () => pass,
    beginComputePass: () => pass,
    copyTextureToTexture: noop,
    copyBufferToBuffer: noop,
    copyTextureToBuffer: noop,
    clearBuffer: noop,
    resolveQuerySet: noop,
    finish: () => commands,
  };

export const device = {
  createShaderModule: () => module,
  createRenderPipeline: () => pipeline,
  createComputePipeline: () => pipeline,
  createBindGroup: () => group,
  createBindGroupLayout: () => layout,
  createPipelineLayout: () => layout,
  createSampler: () => sampler,
  createTexture: () => texture,
  createBuffer: (d) => ({ ...d, destroy: noop }),
  createCommandEncoder: () => encoder,
  lost: new Promise(noop),
  addEventListener: noop,
  removeEventListener: noop,
  destroy: noop,
  features: new Set(),
  limits: {
    maxBufferSize: 1 << 30,
    maxTextureDimension2D: 8192,
    maxTextureArrayLayers: 256,
    maxStorageBufferBindingSize: 1 << 27,
  },
  queue: { writeBuffer: noop, writeTexture: noop, submit: noop, onSubmittedWorkDone: () => Promise.resolve() },
};

/** A 64 x 64 canvas stand-in (CAD controls attach to it) and core's WebGPU renderer on the stand-in device. */
export function stillRenderer() {
  const canvas = {
    width: 64,
    height: 64,
    clientWidth: 64,
    clientHeight: 64,
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    hasPointerCapture: () => false,
  };
  const renderer = new GPURenderer(
    canvas,
    device,
    { configure: noop, unconfigure: noop, getCurrentTexture: () => texture },
    'bgra8unorm',
    pipeline,
    { multisample: { count: 4 }, depthStencil: { format: 'depth24plus' }, vertex: {}, fragment: {} },
    pipeline,
  );
  return { canvas, renderer };
}

/** Stubs requestAnimationFrame; returns `run(frames)`, which calls the engine's frame callback with whole milliseconds. */
export function frameDriver() {
  let next,
    now = 0;
  globalThis.requestAnimationFrame = (callback) => {
    next = callback;
    return 1;
  };
  globalThis.cancelAnimationFrame = noop;
  // Whole milliseconds, so the probe's own timestamps are small integers and never allocate.
  return (frames) => {
    for (let f = 0; f < frames; f++) next((now += 16));
  };
}

/**
 * JavaScript heap bytes per frame of `run`: five windows of `frames` frames, each after a forced gc (node --expose-gc),
 * less the cost of reading the heap size. Each window's value is exact unless V8 collected garbage inside it.
 */
export async function bytesPerFrame(run, frames = 1000) {
  const { getHeapStatistics } = await import('node:v8');
  const heap = () => getHeapStatistics().used_heap_size;
  heap();
  const r0 = heap(),
    read = heap() - r0,
    bytes = [];
  for (let w = 0; w < 5; w++) {
    globalThis.gc();
    const before = heap();
    run(frames);
    bytes.push((heap() - before - read) / frames);
  }
  return bytes;
}
