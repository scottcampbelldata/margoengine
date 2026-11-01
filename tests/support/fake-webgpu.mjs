// A WebGPU binding with no GPU, in the shape of a Node binding (`create`, no getPreferredCanvasFormat): real engine code
// runs against it, and it records what was asked. `--gpu tests/support/fake-webgpu.mjs` in margo-convert's tests.
export const record = { adapters: 0, draws: 0, submits: 0, copies: 0, deviceDestroyed: 0, textureUploads: [] };

/** Any object nothing reads back: pipelines, layouts, views, bind groups, samplers. */
const stub = (extra = {}) =>
  new Proxy(extra, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'then' || typeof key === 'symbol') return undefined;
      return () => stub();
    },
  });

const pass = () =>
  stub({
    draw: () => record.draws++,
    drawIndexed: () => record.draws++,
    drawIndexedIndirect: () => record.draws++,
    drawIndirect: () => record.draws++,
    end() {},
  });

function device() {
  return stub({
    features: new Set(),
    limits: stub({ maxTextureArrayLayers: 256, maxBufferSize: 1 << 30, maxTextureDimension2D: 8192 }),
    lost: new Promise(() => {}),
    addEventListener() {},
    removeEventListener() {},
    pushErrorScope() {},
    popErrorScope: async () => null,
    destroy: () => record.deviceDestroyed++,
    queue: stub({
      submit: () => record.submits++,
      writeBuffer() {},
      writeTexture: (destination, data, layout, size) => record.textureUploads.push(size),
      onSubmittedWorkDone: async () => {},
    }),
    createBuffer: (d) => {
      const bytes = new ArrayBuffer(d.size);
      return stub({
        size: d.size,
        usage: d.usage,
        mapAsync: async () => {},
        getMappedRange: () => bytes,
        unmap() {},
        destroy() {},
      });
    },
    createTexture: (d) => {
      const [width, height = 1, depthOrArrayLayers = 1] = Array.isArray(d.size)
        ? d.size
        : [d.size.width, d.size.height, d.size.depthOrArrayLayers];
      const texture = stub({
        width,
        height,
        depthOrArrayLayers,
        format: d.format,
        mipLevelCount: d.mipLevelCount ?? 1,
        sampleCount: d.sampleCount ?? 1,
        usage: d.usage,
        createView: () => stub({ texture }),
        destroy() {},
      });
      return texture;
    },
    createShaderModule: () => stub({ getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipeline: () => stub(),
    createRenderPipelineAsync: async () => stub(),
    createComputePipeline: () => stub(),
    createComputePipelineAsync: async () => stub(),
    createCommandEncoder: () =>
      stub({
        beginRenderPass: pass,
        beginComputePass: () => stub(),
        copyTextureToBuffer: () => record.copies++,
        finish: () => stub(),
      }),
  });
}

export const create = () => ({
  requestAdapter: async () => {
    record.adapters++;
    return stub({
      features: new Set(),
      limits: stub({ maxTextureArrayLayers: 256 }),
      requestDevice: async () => device(),
    });
  },
});
