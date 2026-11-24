import { Engine, TransformStore } from '@margoengine/core/extension';

/** An engine with no GPU: a renderer that keeps its geometries and draws nothing. */
export async function headlessEngine(capacity = 64, backend = 'webgl2') {
  const store = await TransformStore.create(capacity),
    resources = new Set(),
    renderer = {
      backend,
      add: (geometry) => resources.add(geometry),
      remove: (geometry) => resources.delete(geometry),
      render() {},
      dispose: () => resources.clear(),
    };
  const engine = new Engine(
    { width: 200, height: 200, clientWidth: 200, clientHeight: 200 },
    store,
    renderer,
    undefined,
    null,
  );
  return { engine, resources };
}

/** A glTF document over one buffer holding `views` (typed arrays or bytes), one bufferView each. */
export function documentOf(views, rest = {}) {
  const parts = views.map((view) => new Uint8Array(view.buffer ?? view, view.byteOffset ?? 0, view.byteLength)),
    padded = parts.map((part) => (part.length + 3) & ~3),
    bytes = new Uint8Array(padded.reduce((a, b) => a + b, 0)),
    bufferViews = [];
  let offset = 0;
  parts.forEach((part, i) => {
    bytes.set(part, offset);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: part.length });
    offset += padded[i];
  });
  return {
    doc: { asset: { version: '2.0' }, buffers: [{ byteLength: bytes.length }], bufferViews, ...rest },
    bytes,
  };
}

/** The xyz positions and normals of a core geometry. */
export function vertexData(geometry) {
  const positions = [],
    normals = [],
    v = geometry.vertices;
  for (let i = 0; i < v.length; i += 6) {
    positions.push(v[i], v[i + 1], v[i + 2]);
    normals.push(v[i + 3], v[i + 4], v[i + 5]);
  }
  return { positions, normals };
}

/** A WebGPU device that records what it was given; enough for what the textured entry does before a frame. */
function recordingDevice() {
  const buffers = new Set(),
    textures = new Set(),
    device = {
      limits: { maxTextureDimension2D: 8192, maxStorageBufferBindingSize: 1 << 27, maxBufferSize: 1 << 28 },
      vertexUploads: [],
      uniformUploads: [],
      createBuffer(descriptor) {
        const buffer = {
          ...descriptor,
          destroy: () => buffers.delete(buffer),
        };
        buffers.add(buffer);
        return buffer;
      },
      createTexture(descriptor) {
        const texture = {
          ...descriptor,
          format: descriptor.format,
          width: descriptor.size[0],
          height: descriptor.size[1] ?? 1,
          mipLevelCount: descriptor.mipLevelCount ?? 1,
          createView: () => ({}),
          destroy: () => textures.delete(texture),
        };
        textures.add(texture);
        return texture;
      },
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createComputePipeline: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createBindGroup: () => ({}),
      createSampler: (descriptor) => descriptor,
      createCommandEncoder: () => ({
        beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        copyBufferToTexture() {},
        finish: () => ({}),
      }),
      queue: {
        submit() {},
        writeTexture() {},
        copyExternalImageToTexture() {},
        writeBuffer(buffer, _offset, data) {
          (buffer.usage & 1 ? device.vertexUploads : device.uniformUploads).push(Float32Array.from(data));
        },
      },
      liveBuffers: () => buffers.size,
      liveTextures: () => textures.size,
    };
  return device;
}

/** An engine on {@link recordingDevice}, with the WebGPU usage flags Node lacks. */
export async function gpuEngine(t, capacity = 64) {
  const flags = { GPUBufferUsage: { VERTEX: 1, UNIFORM: 2, COPY_DST: 4 }, GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 } };
  for (const [name, value] of Object.entries(flags)) {
    globalThis[name] = value;
    t.after(() => delete globalThis[name]);
  }
  const store = await TransformStore.create(capacity),
    device = recordingDevice(),
    renderer = { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Engine({ width: 200, height: 200, clientWidth: 200, clientHeight: 200 }, store, renderer, undefined, null);
  return { engine, device };
}

/** Stands in for createImageBitmap, counting what it opened and closed. */
export function withBitmaps(t, { width = 4, height = 4 } = {}) {
  const record = { opened: 0, closed: 0, bytes: [] };
  globalThis.createImageBitmap = async (blob) => {
    record.opened++;
    record.bytes.push(new Uint8Array(await blob.arrayBuffer()));
    return { width, height, close: () => record.closed++ };
  };
  t.after(() => delete globalThis.createImageBitmap);
  return record;
}
