import { EngineKernel } from '../../packages/core/dist/index.js';
export const calls = [],
  scissors = [];
export async function engine(t) {
  const saved = Object.fromEntries(
    ['navigator', 'GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const context = { configure() {}, unconfigure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) },
    canvas = { width: 400, height: 200, clientWidth: 400, clientHeight: 200, getContext: () => context };
  const resource = (d) => Object.assign({ destroy() {} }, d);
  const pass = (descriptor) => ({
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    setViewport(...args) {
      calls.push({ label: descriptor?.label, args });
    },
    setScissorRect(...args) {
      scissors.push({ label: descriptor?.label, args });
    },
    drawIndexed() {},
    draw() {},
    end() {},
  });
  const device = {
    features: new Set(),
    limits: { maxBufferSize: 2 ** 30, maxTextureDimension2D: 8192 },
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {},
    queue: { writeBuffer() {}, writeTexture() {}, submit() {} },
    createShaderModule: (d) => d,
    createBindGroup: () => ({}),
    createSampler: () => ({}),
    createBuffer: resource,
    createTexture: (d) =>
      Object.assign(resource(d), {
        width: d.size[0],
        height: d.size[1],
        depthOrArrayLayers: d.size[2] ?? 1,
        format: d.format,
        usage: d.usage,
        createView: () => ({}),
      }),
    async createRenderPipelineAsync() {
      return { getBindGroupLayout: () => ({}) };
    },
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createCommandEncoder: () => ({ beginRenderPass: pass, copyTextureToTexture() {}, finish: () => ({}) }),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: '',
      gpu: {
        requestAdapter: async () => ({ features: new Set(), requestDevice: async () => device }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
  });
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, VERTEX: 4, STORAGE: 8, INDEX: 16, INDIRECT: 32, COPY_SRC: 64 };
  globalThis.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    COPY_SRC: 2,
    COPY_DST: 4,
    TEXTURE_BINDING: 8,
    STORAGE_BINDING: 16,
  };
  const e = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 5], target: [0, 0, 0], near: 0.1, far: 100 },
  });
  t.after(() => {
    e.dispose();
    for (const [key, d] of Object.entries(saved))
      if (d) Object.defineProperty(globalThis, key, d);
      else delete globalThis[key];
  });
  return e;
}
