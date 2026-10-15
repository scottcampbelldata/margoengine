// Stand-in WebGPU device for CPU-side proofs: silent by default (for timing), and inside record() it logs every
// GPU call with resource identities, deep-copied descriptors and the exact bytes of each buffer write.
Object.assign(globalThis, {
  GPUBufferUsage: {
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
  },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUMapMode: { READ: 1, WRITE: 2 },
});

export function mockGPU() {
  let log = null,
    next = 0;
  const ids = new WeakMap(),
    made = (kind, value = {}) => {
      ids.set(value, kind + '#' + next++);
      return value;
    };
  // Descriptors are copied when the call happens, so a caller may reuse one object across calls. Key order is ignored;
  // a member that is absent and one set to undefined count as different.
  const snap = (value) => {
    if (value === null || typeof value !== 'object') return typeof value === 'function' ? 'function' : value;
    if (ids.has(value)) return ids.get(value);
    if (ArrayBuffer.isView(value))
      return (
        value.constructor.name + ':' + Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')
      );
    if (value instanceof ArrayBuffer) return 'ArrayBuffer:' + Buffer.from(value).toString('hex');
    if (Array.isArray(value)) return value.map(snap);
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, snap(value[key])]),
    );
  };
  const call = (name) => (a, b, c, d, e) => {
    if (log) log.push([name, snap(a), snap(b), snap(c), snap(d), snap(e)]);
  };
  const create =
    (name, build = () => ({})) =>
    (descriptor) => {
      const value = made(name, build(descriptor));
      if (log) log.push([name, ids.get(value), snap(descriptor)]);
      return value;
    };
  const destroy = function () {
    this.destroyed = true;
    if (log) log.push(['destroy', ids.get(this)]);
  };
  const pass = Object.fromEntries(
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
      'end',
    ].map((name) => [name, call('pass.' + name)]),
  );
  const begin = (name) => {
    const record = call(name);
    return (descriptor) => {
      record(descriptor);
      return pass;
    };
  };
  const pipeline = () => ({
    getBindGroupLayout(index) {
      const layout = made('layout');
      if (log) log.push(['getBindGroupLayout', ids.get(this), index, ids.get(layout)]);
      return layout;
    },
  });
  const size = (value) =>
    Array.isArray(value)
      ? { width: value[0], height: value[1] ?? 1, depthOrArrayLayers: value[2] ?? 1 }
      : { width: value.width, height: value.height ?? 1, depthOrArrayLayers: value.depthOrArrayLayers ?? 1 };
  const view = create('view');
  const device = made('device', {
    limits: {
      maxBufferSize: 2 ** 32,
      maxStorageBufferBindingSize: 2 ** 31,
      maxTextureDimension2D: 8192,
      maxTextureArrayLayers: 256,
      maxComputeWorkgroupsPerDimension: 65535,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxStorageBuffersPerShaderStage: 8,
      maxColorAttachments: 8,
      maxBindGroups: 4,
    },
    features: new Set(),
    createBuffer: create('buffer', (d) => ({ size: d.size, usage: d.usage, destroy })),
    createTexture: create('texture', (d) => ({
      ...size(d.size),
      format: d.format,
      usage: d.usage,
      sampleCount: d.sampleCount ?? 1,
      dimension: d.dimension ?? '2d',
      mipLevelCount: d.mipLevelCount ?? 1,
      createView: view,
      destroy,
    })),
    createSampler: create('sampler'),
    createShaderModule: create('module'),
    createBindGroup: create('group'),
    createBindGroupLayout: create('layout'),
    createPipelineLayout: create('pipelineLayout'),
    createRenderPipeline: create('renderPipeline', pipeline),
    createComputePipeline: create('computePipeline', pipeline),
    queue: {
      writeBuffer(buffer, offset, data, start = 0, count) {
        if (!log) return;
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(
              data.buffer,
              data.byteOffset + start * (data.BYTES_PER_ELEMENT ?? 1),
              (count ?? data.length - start) * (data.BYTES_PER_ELEMENT ?? 1),
            )
          : new Uint8Array(data, start, count);
        log.push(['writeBuffer', ids.get(buffer), offset, Buffer.from(bytes).toString('hex')]);
      },
      writeTexture: call('writeTexture'),
      copyExternalImageToTexture: call('copyExternalImageToTexture'),
      submit: call('submit'),
    },
  });
  const encoder = made('encoder', {
    beginRenderPass: begin('beginRenderPass'),
    beginComputePass: begin('beginComputePass'),
    clearBuffer: call('clearBuffer'),
    copyTextureToTexture: call('copyTextureToTexture'),
    copyBufferToBuffer: call('copyBufferToBuffer'),
    copyTextureToBuffer: call('copyTextureToBuffer'),
    copyBufferToTexture: call('copyBufferToTexture'),
  });
  return {
    device,
    encoder,
    snap,
    /** Add a line of observable non-GPU state (for example the shader a pass leaves on the context). */
    note(name, ...values) {
      if (log) log.push([name, ...values.map(snap)]);
    },
    /** Run `work` with logging on and return the calls it made. */
    record(work) {
      log = [];
      try {
        work();
        return log;
      } finally {
        log = null;
      }
    },
  };
}

/** Collects passes the way the engine's frame graph does and runs them in order. */
export function passes(plugin) {
  const list = [];
  plugin.registerPasses({ add: (pass) => list.push(pass) });
  list.sort((a, b) => a.order - b.order);
  return (context) => {
    for (const pass of list) pass.execute(context);
  };
}

/**
 * A WebGPU pass context over the mock. `state` holds what a host could change between frames (size, formats, samples,
 * shader); begin(frame) rebuilds targets when those change, moves the camera and resets the per-frame fields;
 * end() logs what later passes and the next frame would see.
 */
export function context(gpu, initial = {}) {
  const state = {
    width: 1280,
    height: 720,
    samples: 4,
    format: 'rgba16float',
    depthFormat: 'depth24plus-stencil8',
    shader: '',
    singular: false,
    ...initial,
  };
  const camera = {
    matrix: new Float32Array(16),
    fov: 60,
    near: 0.1,
    far: 500,
    position: [0, 1, 4],
    target: [0, 0, 0],
    planes: new Float32Array(24),
  };
  const draw = (options) => gpu.note('draw', options),
    c = { backend: 'webgpu', device: gpu.device, encoder: gpu.encoder, bindings: [], delta: 1 / 60 };
  const target = (format) =>
    gpu.device.createTexture({
      size: [state.width, state.height],
      format,
      sampleCount: state.samples,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  let built, color, depth, descriptor;
  return {
    c,
    state,
    camera,
    begin(frame) {
      // Kept allocation-free so timings measure the package, not this driver.
      if (
        !built ||
        built.width !== state.width ||
        built.height !== state.height ||
        built.samples !== state.samples ||
        built.format !== state.format ||
        built.depthFormat !== state.depthFormat
      ) {
        built = { ...state };
        color = target(state.format).createView();
        depth = target(state.depthFormat).createView();
        descriptor = {
          layout: 'auto',
          vertex: { entryPoint: 'vertex', buffers: [] },
          fragment: { entryPoint: 'fragment', targets: [{ format: state.format }] },
          depthStencil: { format: state.depthFormat, depthWriteEnabled: true, depthCompare: 'greater-equal' },
          multisample: { count: state.samples },
        };
      }
      // Perspective times a moving orbit: changes every frame and stays invertible.
      const f = 1 / Math.tan((camera.fov * Math.PI) / 360),
        a = frame * 0.01,
        cos = Math.cos(a),
        sin = Math.sin(a),
        aspect = state.width / state.height,
        m = camera.matrix;
      if (state.singular) m.fill(0);
      else {
        m[0] = (f / aspect) * cos;
        m[1] = 0;
        m[2] = -sin * 1.002;
        m[3] = -sin;
        m[4] = 0;
        m[5] = f;
        m[6] = m[7] = 0;
        m[8] = (f / aspect) * sin;
        m[9] = 0;
        m[10] = cos * 1.002;
        m[11] = cos;
        m[12] = 0.3;
        m[13] = -1.2 * f;
        m[14] = 4.9;
        m[15] = 5;
      }
      camera.position[0] = 4 * sin;
      camera.position[2] = 4 * cos;
      c.camera = camera;
      c.width = state.width;
      c.height = state.height;
      c.color = color;
      c.depth = depth;
      c.descriptor = descriptor;
      c.format = state.format;
      c.shader = state.shader;
      c.draw = draw;
      c.bindings.length = 0;
    },
    end() {
      gpu.note(
        'context',
        c.shader,
        c.bindings,
        c.camera === camera,
        c.color === color,
        c.depth === depth,
        c.descriptor === descriptor,
        c.format,
        c.draw === draw,
      );
    },
  };
}
