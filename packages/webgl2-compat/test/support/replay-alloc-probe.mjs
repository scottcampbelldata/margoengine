// Runs in its own process with --expose-gc (tests/frame-alloc.test.js at the repository root gives the reasons for
// the other V8 flags): heap bytes per replayed draw of the WebGL2 layer (src/device/render.ts), on a stand-in context
// whose calls keep nothing, so every byte left is the replay's own. A real pipeline (a uniform buffer, a texture and
// sampler, a vertex buffer and an index buffer) is made through the public API, then its draws are replayed inside an
// open pass, the steady frame of every scene: the same pipeline, bind group and buffers each draw.
// Prints JSON { bytes: { <case>: [heap bytes per call, five windows] }, errors: { <case>: message }, refused: [the first
// uncaptured errors], draws: the draws device.passes counted }.
import { heapWindows } from '../../../../tests/support/heap-windows.mjs';
import { COMPAT_LIMITS } from '../../dist/index.js';
import { createCompatGPU } from '../../dist/device.js';

const values = new Map(COMPAT_LIMITS.map((name, i) => [0x1000 + i, 4096])),
  made = new Map(),
  context = {
    ...Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i])),
    HIGH_FLOAT: 0x8df2,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    checkFramebufferStatus: () => 0x8cd5,
    getExtension: (name) => (name === 'EXT_color_buffer_float' ? {} : null),
    getParameter: (p) => values.get(p) ?? '',
    getShaderPrecisionFormat: (_s, type) =>
      type === 0x8df2 ? { precision: 23, rangeMin: 127, rangeMax: 127 } : { precision: 0, rangeMin: 31, rangeMax: 30 },
    getProgramParameter: () => true,
    getShaderParameter: () => true,
    getActiveUniformBlockParameter: () => 0,
    getUniformBlockIndex: (_p, name) => (name.length & 7),
    getAttribLocation: () => 0,
  },
  // Every other GL enum is a distinct number and every other GL call one function per name, made once; create* and
  // fenceSync calls return a new object (a GL object), every other call nothing, so the stand-in allocates only when
  // the replay makes a GL object per call.
  gl = new Proxy(context, {
    get: (t, k) => {
      if (k in t) return t[k];
      let f = made.get(k);
      // GL enums (upper-case names): a distinct number each.
      if (f === undefined)
        made.set(
          k,
          (f =
            typeof k === 'string' && /^[A-Z0-9_]+$/.test(k)
              ? 0x9000 + made.size
              : typeof k === 'string' && /^(create|fenceSync)/.test(k)
                ? () => ({})
                : () => undefined),
        );
      return f;
    },
  });

// Usage flags by value (GPUBufferUsage and GPUTextureUsage are browser globals): UNIFORM 0x40, COPY_DST 0x8, VERTEX
// 0x20, INDEX 0x10, TEXTURE_BINDING 0x4.
const device = await (await createCompatGPU({ createContext: () => gl }).requestAdapter()).requestDevice(),
  code = `
struct U { m: mat4x4f, tint: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var t: texture_2d<f32>;
@group(0) @binding(2) var s: sampler;
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@location(0) p: vec3f, @location(1) uv: vec2f) -> V { return V(u.m * vec4f(p, 1), uv); }
@fragment fn fs(v: V) -> @location(0) vec4f { return textureSample(t, s, v.uv) * u.tint; }`,
  module = device.createShaderModule({ code }),
  pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: 20,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x2' },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [{ format: 'rgba8unorm', blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} } }],
    },
    primitive: { cullMode: 'back' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  }),
  uniforms = device.createBuffer({ size: 256, usage: 0x40 | 0x8 }),
  vertices = device.createBuffer({ size: 20 * 3, usage: 0x20 }),
  indices = device.createBuffer({ size: 16, usage: 0x10 }),
  texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x4 }),
  group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniforms } },
      { binding: 1, resource: texture.createView() },
      { binding: 2, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
    ],
  }),
  r = device.replayer,
  // A render pass's targets (RENDER_ATTACHMENT 0x10): a colour target cleared and a depth target cleared, as a scene's
  // main pass is, and the descriptor the encoder hands the replay (one object, as each frame's recorded pass is).
  color = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 }),
  depth = device.createTexture({ size: [4, 4], format: 'depth24plus', usage: 0x10 }),
  passDesc = {
    colors: [{ view: color.createView(), depthSlice: 0, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    depth: {
      view: depth.createView(),
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'discard',
      depthReadOnly: false,
      stencilClearValue: 0,
      stencilReadOnly: true,
    },
  },
  // KB-COMPAT-FRAMEALLOC1 part 9: a storage buffer keeps a CPU copy, so a large write copied through a new view each time
  // (the same range of the same staging array each frame: one kept view), and an indirect draw read its four words
  // through a sliced buffer and a Uint32Array.
  stagingLarge = new Float32Array(512),
  storage = device.createBuffer({ size: 4096, usage: 0x80 | 0x8 | 0x4 }),
  indirectArgs = device.createBuffer({ size: 32, usage: 0x100 | 0x8 }),
  // What a scene writes each frame: one uniform block from a staging array it keeps.
  staging = new Float32Array(64),
  // A frame's GPU descriptor, as the engine writes it (a colour and a depth attachment, cleared), and the list submit
  // takes, kept (the case measures the layer's work, not the array literal a caller writes).
  frameDesc = {
    colorAttachments: [{ view: color.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: {
      view: depth.createView(),
      depthClearValue: 1,
      depthLoadOp: 'clear',
      depthStoreOp: 'discard',
    },
  },
  submitted = [null],
  // Encoder copies (KB-COMPAT-FRAMEALLOC1 part 7): a buffer and a texture to copy between, kept.
  copyFrom = device.createBuffer({ size: 256, usage: 0x04 | 0x08 }),
  copyTo = device.createBuffer({ size: 256, usage: 0x04 | 0x08 }),
  copySource = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x01 | 0x02 | 0x10 }),
  copyTarget = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x01 | 0x02 | 0x10 }),
  copyFromInfo = { texture: copySource, mipLevel: 0, origin: [0, 0, 0] },
  copyToInfo = { texture: copyTarget, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
  copySize = [4, 4, 1],
  // Compute dispatches on the layer's fragment tier (an own-texel storage texture) and scatter tier (a storage buffer),
  // each recorded in a compute pass of one frame (KB-COMPAT-FRAMEALLOC1 part 6).
  computeModule = device.createShaderModule({
    code: `
@group(0) @binding(0) var t: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(4, 4) fn tex(@builtin(global_invocation_id) id: vec3u) { textureStore(t, vec2i(id.xy), vec4f(1)); }
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(4) fn buf(@builtin(global_invocation_id) id: vec3u) { out[id.x] = id.x; }`.replace('@group(0) @binding(0) var<storage', '@group(1) @binding(0) var<storage'),
  }),
  computeTexture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x8 }),
  computeBuffer = device.createBuffer({ size: 64, usage: 0x80 | 0x4 }),
  texPipeline = device.createComputePipeline({ layout: 'auto', compute: { module: computeModule, entryPoint: 'tex' } }),
  bufPipeline = device.createComputePipeline({ layout: 'auto', compute: { module: computeModule, entryPoint: 'buf' } }),
  // KB-COMPAT-FRAMEALLOC1 part 10: a pass of two colour targets and one of none in turn (the pass state's stand-in list
  // was set to each pass's length, so a shorter pass trimmed it and a longer one grew it again), a '2d' view of one
  // layer of an array texture sampled (its copy was found by a key string built per lookup), and a view of a texture
  // made with no descriptor (a renderer's view of its canvas texture each frame: ten fields and a default `{}`).
  color2 = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 }),
  twoColors = {
    colors: [passDesc.colors[0], { ...passDesc.colors[0], view: color2.createView() }],
    depth: passDesc.depth,
  },
  depthOnly = { colors: [], depth: passDesc.depth },
  layered = device.createTexture({ size: [4, 4, 2], format: 'rgba8unorm', usage: 0x04 | 0x10 }),
  layerView = layered.createView({ dimension: '2d', baseArrayLayer: 1, arrayLayerCount: 1 }),
  kept = [null],
  texGroup = device.createBindGroup({ layout: texPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: computeTexture.createView() }] }),
  bufGroup = device.createBindGroup({ layout: bufPipeline.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: computeBuffer } }] });
await device.loadCompute();

/** An open pass with the pipeline's state set, as the replay holds it between a frame's draws. */
function open() {
  r.pass = { pipeline: null, desc: { colors: [], depth: null }, groups: [], vertex: [], index: null };
  r.setPipeline(pipeline);
  r.setBindGroup(0, group, []);
  r.setVertexBuffer(0, vertices, 0);
  r.setIndexBuffer(indices, 'uint16', 0);
}
const refused = [];
device.addEventListener('uncapturederror', (e) => (e.preventDefault(), refused.length < 4 && refused.push(e.error.message)));
open();
device.queue.writeBuffer(indirectArgs, 0, new Uint32Array([3, 1, 0, 0, 0, 0, 0, 0]));

const cases = {
    draw: (n) => {
      for (let i = 0; i < n; i++) r.draw(3, 1, 0, 0);
    },
    drawIndexed: (n) => {
      for (let i = 0; i < n; i++) r.drawIndexed(3, 1, 0, 0, 0);
    },
    drawIndirect: (n) => {
      for (let i = 0; i < n; i++) r.drawIndirect(indirectArgs, 0);
    },
    // (After the draws: a pass ends with no pass open.) A pass begun and ended: its framebuffer found, its targets cleared, its pass state reset (KB-COMPAT-FRAMEALLOC1
    // part 3; the code before read 3,281 B a pass).
    pass: (n) => {
      for (let i = 0; i < n; i++) {
        r.beginPass(passDesc);
        r.endPass();
      }
    },
    passMix: (n) => {
      for (let i = 0; i < n; i++) {
        r.beginPass(i & 1 ? depthOnly : twoColors);
        r.endPass();
      }
    },
    sampledLayer: (n) => {
      for (let i = 0; i < n; i++) kept[0] = layered.sampled(layerView);
    },
    view: (n) => {
      for (let i = 0; i < n; i++) kept[0] = color.createView();
    },
    // queue.writeBuffer from the same staging array (part 3; before, a new Uint8Array view and a list a write).
    writeBuffer: (n) => {
      for (let i = 0; i < n; i++) device.queue.writeBuffer(uniforms, 0, staging, 0, 16);
    },
    writeStorage: (n) => {
      for (let i = 0; i < n; i++) device.queue.writeBuffer(storage, 0, stagingLarge, 0, 512);
    },
    // A whole frame of commands encoded, finished and submitted (KB-COMPAT-FRAMEALLOC1 part 4): the objects WebGPU
    // returns each call (an encoder, a pass encoder, a command buffer) are the only bytes left.
    encode: (n) => {
      for (let i = 0; i < n; i++) {
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginRenderPass(frameDesc);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.setVertexBuffer(0, vertices);
        pass.setIndexBuffer(indices, 'uint16');
        pass.drawIndexed(3);
        pass.end();
        submitted[0] = encoder.finish();
        device.queue.submit(submitted);
      }
    },
    // Encoder copies (part 7): before, a closure and two descriptor copies each, and arrays at the replay.
    copyBuffer: (n) => {
      for (let i = 0; i < n; i++) {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(copyFrom, 0, copyTo, 0, 256);
        submitted[0] = encoder.finish();
        device.queue.submit(submitted);
      }
    },
    copyTexture: (n) => {
      for (let i = 0; i < n; i++) {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToTexture(copyFromInfo, copyToInfo, copySize);
        submitted[0] = encoder.finish();
        device.queue.submit(submitted);
      }
    },
    // Compute dispatches (part 6): one pass, a pipeline, a bind group and a dispatch each, on each tier.
    dispatchTexture: (n) => {
      for (let i = 0; i < n; i++) {
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(texPipeline);
        pass.setBindGroup(0, texGroup);
        pass.dispatchWorkgroups(1, 1, 1);
        pass.end();
        submitted[0] = encoder.finish();
        device.queue.submit(submitted);
      }
    },
    dispatchBuffer: (n) => {
      for (let i = 0; i < n; i++) {
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(bufPipeline);
        pass.setBindGroup(1, bufGroup);
        pass.dispatchWorkgroups(4, 1, 1);
        pass.end();
        submitted[0] = encoder.finish();
        device.queue.submit(submitted);
      }
    },
  },
  bytes = {},
  errors = {};
for (const [name, run] of Object.entries(cases)) {
  try {
    // Warm: the first draws link, cache and fill the per-program state; the steady frame is what is measured.
    run(20000);
    bytes[name] = heapWindows(run, 1000, 5);
  } catch (e) {
    errors[name] = String(e?.stack ?? e);
  }
}
// Uncaptured errors (a draw the replay refused would measure its message, not a draw) and the draws counted.
await new Promise((resolve) => setTimeout(resolve, 0));
process.stdout.write(JSON.stringify({ bytes, errors, refused, draws: device.passes.draws }));
