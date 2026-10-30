// Records one frame of WebGPU work so scripts/support/webgpu-replay.js can run it again with no engine code: every GPU
// object the frame reaches (its descriptor, shader text, buffer and texture bytes) and the frame's encoder, pass and
// queue calls. Made for docs/known-bugs.md "4x MSAA blending is not repeatable": a frame that differs when replayed
// from fixed bytes is a fault below the engine. installTrace() patches the WebGPU prototypes, so call it before the
// device is created, in a test page only: buffers get COPY_SRC (unless mappable), 1-sample colour textures COPY_SRC
// and multisampled colour textures TEXTURE_BINDING, so their contents can be read and probed.

/** The bytes a `queue.writeBuffer(buffer, offset, data, dataOffset, size)` call writes (offsets and size count elements of a typed array, bytes of an ArrayBuffer). */
export function writeRange(data, dataOffset = 0, size) {
  const view = ArrayBuffer.isView(data),
    element = view ? (data.BYTES_PER_ELEMENT ?? 1) : 1,
    start = (view ? data.byteOffset : 0) + dataOffset * element,
    length = size === undefined ? (view ? data.byteLength : data.byteLength) - dataOffset * element : size * element;
  if (dataOffset < 0 || length < 0 || start + length > (view ? data.byteOffset + data.byteLength : data.byteLength))
    throw new RangeError(
      `writeRange: dataOffset ${dataOffset} and size ${size} run past the data; pass a range inside it`,
    );
  return new Uint8Array(view ? data.buffer : data, start, length);
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/** A JSON-ready copy of `value`: objects `idOf` knows become `{$id}`, byte views `{$bytes}` (base64), functions go. */
export function serialize(value, idOf) {
  if (value && typeof value === 'object' && idOf(value) !== undefined) return { $id: idOf(value) };
  if (Array.isArray(value)) return value.map((v) => serialize(v, idOf));
  if (ArrayBuffer.isView(value))
    return { $bytes: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (value && typeof value === 'object') {
    const out = {};
    for (const key in value) if (typeof value[key] !== 'function') out[key] = serialize(value[key], idOf);
    return out;
  }
  return value;
}

/** The inverse of serialize: `{$id}` becomes `lookup(id)`, `{$bytes}` a Uint8Array. */
export function revive(value, lookup) {
  if (Array.isArray(value)) return value.map((v) => revive(v, lookup));
  if (value && typeof value === 'object') {
    if (typeof value.$id === 'number') return lookup(value.$id);
    if (typeof value.$bytes === 'string') return fromBase64(value.$bytes);
    const out = {};
    for (const key in value) out[key] = revive(value[key], lookup);
    return out;
  }
  return value;
}

/** Ids of the objects that `calls` name, directly or through other objects' descriptors, bundles and views. */
export function reachable(objects, calls) {
  const seen = new Set();
  const visit = (v) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    if (typeof v.$id === 'number') {
      if (seen.has(v.$id)) return;
      seen.add(v.$id);
      const o = objects[v.$id];
      if (o.texture !== undefined) visit({ $id: o.texture });
      if (o.pipeline !== undefined) visit({ $id: o.pipeline });
      visit(o.desc);
      if (o.calls) visit(o.calls);
      return;
    }
    for (const key in v) visit(v[key]);
  };
  for (const c of calls) visit(c[2]);
  return seen;
}

const PASS_CALLS = [
  'setPipeline',
  'setBindGroup',
  'setVertexBuffer',
  'setIndexBuffer',
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect',
  'executeBundles',
  'setViewport',
  'setScissorRect',
  'setBlendConstant',
  'setStencilReference',
  'dispatchWorkgroups',
  'dispatchWorkgroupsIndirect',
  'end',
];
const BUNDLE_CALLS = [
  'setPipeline',
  'setBindGroup',
  'setVertexBuffer',
  'setIndexBuffer',
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect',
];
const BYTES_PER_TEXEL = {
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rgba16float: 8,
  r8unorm: 1,
  rg8unorm: 2,
  r16float: 2,
  rg16float: 4,
  r32float: 4,
  rgba32float: 16,
};

/** Patches the WebGPU prototypes; returns `record(device, run)`, which records the calls `run()` makes. */
export function installTrace() {
  const ids = new WeakMap(),
    objects = [],
    live = [],
    bundles = new Map();
  let frame = null;
  const idOf = (o) => ids.get(o),
    plain = (v) => serialize(v, idOf);
  const add = (o, record) => {
    ids.set(o, objects.length);
    objects.push(record);
    live.push(o);
    return o;
  };
  const after = (proto, name, then) => {
    const original = proto[name];
    if (!original) return;
    proto[name] = function (...args) {
      const result = original.apply(this, args);
      then.call(this, result, args);
      return result;
    };
  };
  const D = GPUDevice.prototype,
    BU = GPUBufferUsage,
    TU = GPUTextureUsage;
  const createBuffer = D.createBuffer;
  D.createBuffer = function (desc) {
    const mappable = desc.usage & (BU.MAP_READ | BU.MAP_WRITE);
    return add(createBuffer.call(this, mappable ? desc : { ...desc, usage: desc.usage | BU.COPY_SRC }), {
      t: 'buffer',
      desc: plain({ ...desc, mappedAtCreation: false }),
    });
  };
  const createTexture = D.createTexture;
  D.createTexture = function (desc) {
    const depth = /depth|stencil/.test(desc.format),
      many = (desc.sampleCount ?? 1) > 1,
      usage = desc.usage | (depth ? 0 : many ? TU.TEXTURE_BINDING : TU.COPY_SRC);
    return add(createTexture.call(this, { ...desc, usage }), { t: 'texture', desc: plain(desc) });
  };
  for (const name of [
    'createSampler',
    'createShaderModule',
    'createBindGroupLayout',
    'createPipelineLayout',
    'createBindGroup',
    'createQuerySet',
    'createRenderPipeline',
    'createComputePipeline',
  ])
    after(D, name, (r, [desc]) => add(r, { t: name, desc: plain(desc ?? {}) }));
  for (const name of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const original = D[name];
    D[name] = function (desc) {
      const record = { t: name.replace('Async', ''), desc: plain(desc) };
      return original.call(this, desc).then((p) => add(p, record));
    };
  }
  after(GPUTexture.prototype, 'createView', function (r, [desc]) {
    add(r, { t: 'view', texture: idOf(this), desc: plain(desc ?? {}) });
  });
  for (const P of [GPURenderPipeline.prototype, GPUComputePipeline.prototype])
    after(P, 'getBindGroupLayout', function (r, [index]) {
      if (!ids.has(r)) add(r, { t: 'autoLayout', pipeline: idOf(this), index });
    });
  after(GPUCanvasContext.prototype, 'getCurrentTexture', (r) => {
    if (!ids.has(r)) add(r, { t: 'canvasTexture', desc: { size: [r.width, r.height], format: r.format } });
  });
  // Render bundles are made before the frame that runs them: their calls are always recorded.
  after(D, 'createRenderBundleEncoder', (encoder, [desc]) =>
    bundles.set(encoder, { t: 'bundle', desc: plain(desc), calls: [] }),
  );
  for (const name of BUNDLE_CALLS)
    after(GPURenderBundleEncoder.prototype, name, function (r, args) {
      bundles.get(this)?.calls.push([name, plain(args)]);
    });
  after(GPURenderBundleEncoder.prototype, 'finish', function (r) {
    if (bundles.has(this)) add(r, bundles.get(this));
  });
  // The frame: [call, target id, arguments, result id].
  const log = (target, name, args, result) =>
    frame?.calls.push([name, idOf(target) ?? null, plain(args), result === undefined ? null : idOf(result)]);
  after(D, 'createCommandEncoder', (r) => {
    if (!frame) return;
    add(r, { t: 'encoder' });
    log(r, 'createCommandEncoder', []);
  });
  const E = GPUCommandEncoder.prototype;
  for (const name of ['beginRenderPass', 'beginComputePass', 'finish'])
    after(E, name, function (r, args) {
      if (!frame) return;
      add(r, { t: name === 'finish' ? 'commandBuffer' : 'pass' });
      log(this, name, args, r);
    });
  for (const name of [
    'copyBufferToBuffer',
    'copyBufferToTexture',
    'copyTextureToBuffer',
    'copyTextureToTexture',
    'clearBuffer',
    'resolveQuerySet',
  ])
    after(E, name, function (r, args) {
      log(this, name, args);
    });
  for (const P of [GPURenderPassEncoder.prototype, GPUComputePassEncoder.prototype])
    for (const name of PASS_CALLS)
      after(P, name, function (r, args) {
        log(this, name, args);
      });
  after(GPUQueue.prototype, 'writeBuffer', function (r, [buffer, offset, data, dataOffset, size]) {
    if (frame) log(this, 'writeBuffer', [buffer, offset, writeRange(data, dataOffset, size)]);
  });
  for (const name of ['writeTexture', 'submit'])
    after(GPUQueue.prototype, name, function (r, args) {
      log(this, name, args);
    });
  return {
    /** Records the calls `run()` makes, then reads back every buffer and 1-sample colour texture they reach. */
    async record(device, run) {
      frame = { calls: [] };
      const recorded = frame;
      try {
        await run();
      } finally {
        frame = null;
      }
      const reach = reachable(objects, recorded.calls),
        data = {};
      for (const id of reach) {
        const o = objects[id];
        if (o.t === 'buffer' && !(o.desc.usage & (BU.MAP_READ | BU.MAP_WRITE)))
          data[id] = toBase64(await readBuffer(device, live[id], o.desc.size));
        if (o.t === 'texture' && (o.desc.sampleCount ?? 1) === 1 && !/depth|stencil/.test(o.desc.format))
          data[id] = await readTexture(device, live[id], o.desc);
      }
      return {
        objects: Object.fromEntries([...reach].sort((a, b) => a - b).map((id) => [id, objects[id]])),
        calls: recorded.calls,
        data,
      };
    },
  };
}

async function readBuffer(device, buffer, size) {
  const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(staging.getMappedRange()).slice();
  staging.destroy();
  return bytes;
}

export function textureSize(desc) {
  const s = desc.size;
  return Array.isArray(s) ? [s[0], s[1] ?? 1, s[2] ?? 1] : [s.width, s.height ?? 1, s.depthOrArrayLayers ?? 1];
}

async function readTexture(device, texture, desc) {
  const per = BYTES_PER_TEXEL[desc.format];
  if (!per)
    throw new TypeError(`webgpu-trace: cannot read a ${desc.format} texture; add its texel size to BYTES_PER_TEXEL`);
  const [width, height, layers] = textureSize(desc),
    levels = [];
  for (let m = 0; m < (desc.mipLevelCount ?? 1); m++) {
    const w = Math.max(1, width >> m),
      h = Math.max(1, height >> m),
      row = Math.ceil((w * per) / 256) * 256,
      staging = device.createBuffer({
        size: row * h * layers,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture, mipLevel: m }, { buffer: staging, bytesPerRow: row, rowsPerImage: h }, [
      w,
      h,
      layers,
    ]);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    levels.push({ row, data: toBase64(new Uint8Array(staging.getMappedRange()).slice()) });
    staging.destroy();
  }
  return { levels };
}
