import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { EngineKernel, box } from '@margoengine/core';
import { Stats } from '@margoengine/stats';
import { FrameDebugger, textureBytes } from '../dist/frame.js';
import { parseGLTF, parsePreparedPBR } from '@margoengine/gltf-pro';
import { parseFBX } from '@margoengine/fbx';

// Tracing fake WebGPU (tests/support/gpu-trace.js pattern): every command a pass encoder receives is appended to
// `log`, so a report can be compared with exactly what reached the "GPU". Classes carry the native names the
// debugger recognizes (GPUTexture, GPUTextureView, GPUSampler); timestamps advance 1 ms per pass.
class GPUBuffer {
  constructor({ size, usage, label = '' }) {
    Object.assign(this, { size, usage, label, destroyed: false, data: new ArrayBuffer(size) });
  }
  destroy() {
    this.destroyed = true;
  }
  async mapAsync() {}
  getMappedRange(offset = 0, size = this.size - offset) {
    return this.data.slice(offset, offset + size);
  }
  unmap() {}
}
class GPUTextureView {}
class GPUTexture {
  constructor({ size, format, label = '', sampleCount = 1, mipLevelCount = 1, dimension = '2d' }) {
    const [width, height = 1, depthOrArrayLayers = 1] = size;
    Object.assign(this, {
      label,
      format,
      width,
      height,
      depthOrArrayLayers,
      sampleCount,
      mipLevelCount,
      dimension,
      destroyed: false,
    });
  }
  createView() {
    return new GPUTextureView();
  }
  destroy() {
    this.destroyed = true;
  }
}
class GPUSampler {
  constructor() {
    this.label = '';
  }
}
const usage = {
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
};

function fakeGPU(t, offered = []) {
  const keys = [
    'navigator',
    'GPUBufferUsage',
    'GPUTextureUsage',
    'GPUMapMode',
    'GPUTexture',
    'GPUTextureView',
    'GPUSampler',
    'GPUBuffer',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const log = [],
    label = (value) => (typeof value === 'object' && value ? value.label : value);
  const pass = () => {
    const record =
      (name) =>
      (...args) =>
        log.push([name, ...args.map(label)].join(' '));
    return {
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      end() {},
      draw: record('draw'),
      drawIndexed: record('drawIndexed'),
      drawIndirect: record('drawIndirect'),
      drawIndexedIndirect: record('drawIndexedIndirect'),
      dispatchWorkgroups: record('dispatchWorkgroups'),
      dispatchWorkgroupsIndirect: record('dispatchWorkgroupsIndirect'),
    };
  };
  const canvas = { width: 64, height: 48, clientWidth: 64, clientHeight: 48 };
  const context = {
    configure() {},
    unconfigure() {},
    getCurrentTexture: () =>
      new GPUTexture({ label: 'canvas', size: [canvas.width, canvas.height], format: 'bgra8unorm' }),
  };
  canvas.getContext = () => context;
  const devices = [],
    timestamps = [];
  const adapter = {
    features: new Set(offered),
    async requestDevice({ requiredFeatures }) {
      const device = {
        features: new Set(requiredFeatures),
        limits: { maxBufferSize: 2 ** 30 },
        lost: new Promise(() => {}),
        addEventListener() {},
        destroy() {},
        queue: {
          writeBuffer(buffer, offset, data, start = 0, size) {
            const element = data.BYTES_PER_ELEMENT ?? 1,
              bytes = new Uint8Array(
                data.buffer ?? data,
                (data.byteOffset ?? 0) + start * element,
                size === undefined ? data.byteLength - start * element : size * element,
              );
            new Uint8Array(buffer.data, offset, bytes.length).set(bytes);
          },
          writeTexture() {},
          submit() {},
        },
        createShaderModule: (descriptor) => ({ label: descriptor.label ?? '' }),
        createBindGroup: (descriptor) => ({ label: descriptor.label ?? '' }),
        createBuffer: (descriptor) => new GPUBuffer(descriptor),
        createTexture: (descriptor) => new GPUTexture(descriptor),
        createSampler: () => new GPUSampler(),
        createQuerySet: (descriptor) => ({ ...descriptor, destroy() {} }),
        async createRenderPipelineAsync(descriptor) {
          return { label: descriptor.label ?? '', getBindGroupLayout: () => ({}) };
        },
        createRenderPipeline: (descriptor) => ({ label: descriptor.label ?? '', getBindGroupLayout: () => ({}) }),
        createComputePipeline: (descriptor) => ({ label: descriptor.label ?? '', getBindGroupLayout: () => ({}) }),
        createCommandEncoder: () => ({
          beginRenderPass: (descriptor) => {
            if (descriptor.timestampWrites) timestamps.push(descriptor.label ?? '');
            return pass();
          },
          beginComputePass: (descriptor) => {
            if (descriptor?.timestampWrites) timestamps.push(descriptor.label ?? '');
            return pass();
          },
          copyBufferToBuffer(source, from, target, to, size) {
            new Uint8Array(target.data, to, size).set(new Uint8Array(source.data, from, size));
          },
          resolveQuerySet(_set, first, count, target, offset) {
            const values = new BigUint64Array(target.data, offset, count);
            for (let i = 0; i < count; i++) values[i] = BigInt(first + i) * 1000000n;
          },
          finish: () => ({}),
        }),
      };
      devices.push(device);
      return device;
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: '',
      gpu: { requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' },
    },
  });
  Object.assign(globalThis, {
    GPUBufferUsage: usage,
    GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
    GPUMapMode: { READ: 1 },
    GPUTexture,
    GPUTextureView,
    GPUSampler,
    GPUBuffer,
  });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  return { canvas, log, devices, timestamps };
}

// A post-like plugin: a compute pass, then a render pass into its own target with 15 sampled textures + 1 sampler,
// one direct and one indirect draw (arguments buffer with COPY_SRC), a uniform upload and a pipeline compiled lazily.
function effect() {
  const state = { frame: 0 };
  return {
    name: 'fx',
    state,
    setup(engine) {
      const device = engine.gpu;
      state.target = device.createTexture({ label: 'fx:target', size: [64, 48], format: 'rgba16float', usage: 20 });
      state.uniform = device.createBuffer({ label: 'fx:uniform', size: 16, usage: usage.UNIFORM | usage.COPY_DST });
      state.args = device.createBuffer({
        label: 'fx:args',
        size: 20,
        usage: usage.INDIRECT | usage.COPY_SRC | usage.COPY_DST,
      });
      device.queue.writeBuffer(state.args, 0, new Uint32Array([36, 5, 0, 0, 0]));
      state.compute = device.createComputePipeline({
        label: 'fx:blur',
        layout: 'auto',
        compute: { module: {}, entryPoint: 'main' },
      });
      const textures = Array.from({ length: 15 }, (_, i) =>
        device.createTexture({ label: `fx:layer${i}`, size: [4, 4], format: 'rgba8unorm', usage: 4 }),
      );
      state.group = device.createBindGroup({
        label: 'fx:inputs',
        layout: {},
        entries: [
          { binding: 0, resource: { buffer: state.uniform } },
          { binding: 1, resource: device.createSampler() },
          ...textures.map((texture, i) => ({ binding: i + 2, resource: texture.createView() })),
        ],
      });
      state.view = state.target.createView();
    },
    registerPasses(graph) {
      graph.add({
        name: 'fx:compose',
        order: 10,
        execute: (context) => {
          const device = context.device;
          state.pipeline ??= device.createRenderPipeline({
            label: 'fx:compose',
            layout: 'auto',
            vertex: { module: {}, entryPoint: 'v' },
            fragment: {
              module: {},
              entryPoint: 'f',
              targets: [
                {
                  format: 'rgba16float',
                  blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} },
                },
              ],
            },
            primitive: { cullMode: 'back' },
          });
          device.queue.writeBuffer(state.uniform, 0, new Float32Array([state.frame++, 0, 0, 1]));
          const compute = context.encoder.beginComputePass({ label: 'fx:blur' });
          compute.setPipeline(state.compute);
          compute.setBindGroup(0, state.group);
          compute.dispatchWorkgroups(8, 6);
          compute.end();
          const pass = context.encoder.beginRenderPass({
            label: 'fx:compose',
            colorAttachments: [{ view: state.view, loadOp: 'clear', storeOp: 'store' }],
          });
          pass.setPipeline(state.pipeline);
          pass.setBindGroup(0, state.group);
          pass.draw(3);
          pass.drawIndexedIndirect(state.args, 0);
          pass.end();
        },
      });
    },
  };
}

const describe = (command) =>
  command.kind.startsWith('dispatch')
    ? `${command.kind} ${command.workgroups.join(' ')}`
    : command.indirect
      ? `${command.kind} ${command.indirect.buffer.replace(/ \(.*$/, '')} ${command.indirect.offset}`
      : `${command.kind} ${command.indexCount ?? command.vertexCount} ${command.instanceCount}`;
const traced = (entry) =>
  entry
    .replace(/^(draw|drawIndexed) (\d+)$/, '$1 $2 1')
    .replace(/^dispatchWorkgroups (\d+) (\d+)$/, 'dispatchWorkgroups $1 $2 1');
function framePath(engine) {
  const device = engine.gpu,
    graph = engine.frameGraph,
    records = Object.values(graph).find(Array.isArray);
  return {
    encoder: device.createCommandEncoder,
    write: device.queue.writeBuffer,
    texture: device.queue.writeTexture,
    submit: device.queue.submit,
    view: GPUTexture.prototype.createView,
    render: Object.hasOwn(engine, 'render'),
    execute: Object.hasOwn(graph, 'execute'),
    passes: records.map((record) => record.execute),
  };
}

test('capture lists exactly the recorded commands, pass by pass, with pipelines, bindings, targets and GPU times', async (t) => {
  const gpu = fakeGPU(t, ['timestamp-query']);
  const engine = await EngineKernel.create(gpu.canvas, {
    capacity: 8,
    backend: 'webgpu',
    features: ['timestamp-query'],
  });
  t.after(() => engine.dispose());
  const debug = FrameDebugger.attach(engine, { parent: null }),
    fx = effect();
  engine.use(fx);
  const geometry = box(),
    small = box(0.5, 0.5, 0.5);
  const meshes = [
    engine.createMesh().setGeometry(geometry),
    engine.createMesh().setGeometry(geometry).setPosition([2, 0, 0]),
    engine.createMesh().setGeometry(small).setPosition([-2, 0, 0]),
  ];
  engine.render();
  const idle = framePath(engine);
  for (let i = 0; i < 3; i++) engine.render();
  assert.deepEqual(framePath(engine), idle, 'idle frames install no wrapper on the frame path');
  assert.equal(debug.report, null);

  gpu.log.length = 0;
  gpu.timestamps.length = 0;
  fx.state.pipeline = undefined; // compiled again inside the captured frame, like a first-use hitch
  const report = await debug.capture({ render: true });
  assert.deepEqual(
    framePath(engine),
    idle,
    'engine.render, the frame graph, the device, the queue and GPUTexture are restored after capture',
  );

  // The report lists the trace exactly, in order.
  const listed = report.graph.flatMap((entry) => entry.passes.flatMap((pass) => pass.commands.map(describe)));
  assert.deepEqual(listed, gpu.log.map(traced));
  assert.deepEqual(gpu.log, [
    'drawIndexed 36 2',
    'drawIndexed 36 1',
    'dispatchWorkgroups 8 6',
    'draw 3',
    'drawIndexedIndirect fx:args 0',
  ]);
  assert.deepEqual(
    report.graph.map((entry) => [entry.name, entry.owner, entry.passes.map((pass) => pass.kind + ':' + pass.label)]),
    [
      ['main', 'core', ['render:']],
      ['fx:compose', 'fx', ['compute:fx:blur', 'render:fx:compose']],
      ['(after frame graph)', 'engine', ['render:']],
    ],
  );

  // Core's batches name their meshes; the indirect draw's counts come from the read-back arguments.
  const [main] = report.graph[0].passes,
    [blur, compose] = report.graph[1].passes;
  assert.deepEqual(
    main.commands.map((command) => command.entities),
    [[meshes[0].id, meshes[1].id], [meshes[2].id]],
  );
  assert.deepEqual(compose.commands[1], { ...compose.commands[1], indexCount: 36, instanceCount: 5, triangles: 60 });
  assert.deepEqual(blur.commands[0].workgroups, [8, 6, 1]);
  assert.equal(report.totals.triangles, 12 * 2 + 12 + 1 + 60);
  assert.deepEqual(
    [
      report.totals.draws,
      report.totals.indexedDraws,
      report.totals.indirectDraws,
      report.totals.dispatches,
      report.totals.renderPasses,
      report.totals.computePasses,
    ],
    [4, 3, 1, 1, 3, 1],
  );

  // Pipelines: fx's described from its descriptor and compiled during this frame; core's predate the debugger.
  const pipeline = report.pipelines[compose.commands[0].pipeline];
  assert.deepEqual(pipeline, {
    id: pipeline.id,
    kind: 'render',
    label: 'fx:compose',
    createdThisFrame: true,
    known: true,
    passes: ['fx:compose'],
    topology: 'triangle-list',
    cullMode: 'back',
    formats: ['rgba16float'],
    blend: ['add(src-alpha, one-minus-src-alpha)'],
    depth: null,
    samples: 1,
    textures: 15,
    samplers: 1,
  });
  assert.equal(report.pipelines[main.commands[0].pipeline].known, false);
  assert.equal(report.totals.pipelinesCreated, 1);
  assert.ok(
    report.warnings.some((warning) => /"fx:compose" binds 15 textures and 1 samplers/.test(warning)),
    report.warnings.join('\n'),
  );
  assert.ok(report.warnings.some((warning) => /1 pipeline\(s\) compiled/.test(warning)));

  // Bindings, render targets, uploads and memory.
  const group = report.bindGroups[compose.commands[0].bindGroups[0]];
  assert.equal(group.label, 'fx:inputs');
  assert.deepEqual(group.entries.slice(0, 3), [
    { binding: 0, kind: 'buffer', resource: 'fx:uniform (16 B) @0' },
    { binding: 1, kind: 'sampler', resource: 'sampler' },
    { binding: 2, kind: 'texture', resource: 'fx:layer0 rgba8unorm 4x4' },
  ]);
  assert.deepEqual(compose.attachments, [
    {
      target: 'color',
      index: 0,
      loadOp: 'clear',
      storeOp: 'store',
      view: {
        label: 'fx:target',
        format: 'rgba16float',
        width: 64,
        height: 48,
        depthOrArrayLayers: 1,
        sampleCount: 1,
        mipLevelCount: 1,
      },
    },
  ]);
  assert.deepEqual(
    main.attachments.map((item) => [item.target, item.view?.format, item.view?.sampleCount, item.resolveTarget?.label]),
    [
      ['color', 'bgra8unorm', 4, 'canvas'],
      ['depth', 'depth32float', 4, undefined],
    ],
  );
  assert.deepEqual(
    report.uploads.find((upload) => upload.target === 'fx:uniform (16 B)'),
    { target: 'fx:uniform (16 B)', calls: 1, bytes: 16 },
  );
  assert.ok(report.totals.uploadBytes >= 16 + 112, 'fx uniform and core frame uniform');
  assert.equal(report.memory.textures.count, 16 + 2, 'fx target, 15 layers and core MSAA color + depth');
  assert.equal(report.memory.textures.bytes, 64 * 48 * 8 + 15 * 4 * 4 * 4 + 64 * 48 * 4 * 4 * 2);
  assert.ok(report.memory.buffers.count >= 3);

  // GPU times: every pass on the frame graph's encoder got timestamps (1 ms each in the fake).
  assert.equal(report.timing, 'gpu');
  assert.deepEqual(
    report.graph.flatMap((entry) => entry.passes.map((pass) => pass.gpuMilliseconds)),
    [1, 1, 1, 1],
  );
  assert.equal(report.gpuMilliseconds, 4);
  assert.equal(gpu.timestamps.length, 4);

  // Plain JSON, and the next frames are back to the untouched path.
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  gpu.log.length = 0;
  gpu.timestamps.length = 0;
  engine.render();
  assert.equal(gpu.timestamps.length, 0, 'no timestamps after the capture');
  assert.deepEqual(framePath(engine), idle);
});

test('capture waits for the next rendered frame and dispose restores every device method and resource', async (t) => {
  const gpu = fakeGPU(t);
  const engine = await EngineKernel.create(gpu.canvas, { capacity: 4, backend: 'webgpu' });
  t.after(() => engine.dispose());
  const device = engine.gpu,
    before = {
      buffer: device.createBuffer,
      texture: device.createTexture,
      group: device.createBindGroup,
      pipeline: device.createRenderPipeline,
    };
  const debug = FrameDebugger.attach(engine, { parent: null });
  assert.notEqual(device.createBuffer, before.buffer, 'resource creation is wrapped while attached');
  const texture = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 4 });
  assert.equal(Object.hasOwn(texture, 'createView'), true);
  engine.createMesh().setGeometry(box());
  const pending = debug.capture();
  assert.equal(debug.capture(), pending, 'one pending capture');
  assert.equal(Object.hasOwn(engine, 'render'), true);
  engine.render();
  assert.equal(Object.hasOwn(engine, 'render'), false);
  const report = await pending;
  assert.equal(report.timing, 'cpu');
  assert.match(report.note, /timestamp-query/);
  assert.equal(report.graph[0].gpuMilliseconds, null);
  assert.ok(report.graph[0].cpuMilliseconds >= 0);
  texture.destroy();
  assert.equal(Object.hasOwn(texture, 'destroy'), false, 'destroy unwraps the resource');

  const kept = device.createBuffer({ size: 64, usage: usage.UNIFORM });
  assert.equal(debug.memory().buffers.bytes >= 64, true);
  const waiting = debug.capture();
  debug.dispose();
  await assert.rejects(waiting, /disposed/);
  assert.deepEqual(
    {
      buffer: device.createBuffer,
      texture: device.createTexture,
      group: device.createBindGroup,
      pipeline: device.createRenderPipeline,
    },
    before,
  );
  assert.equal(Object.hasOwn(kept, 'destroy'), false, 'live resources are unwrapped on dispose');
  assert.equal(Object.hasOwn(engine, 'render'), false);
  assert.equal(engine.hasPlugin('frame-debugger'), false);
  await assert.rejects(debug.capture(), /not attached/);
});

for (const fixture of [
  { name: 'gltf-pro', file: '../../exporters/tests/fixtures/Box.glb', parse: parseGLTF },
  { name: 'FBX', file: '../../fbx/test/fixtures/blender-rig.fbx', parse: parseFBX },
])
  test(`capture names ${fixture.name} loader draws without core Geometry`, async (t) => {
    const gpu = fakeGPU(t),
      engine = await EngineKernel.create(gpu.canvas, { capacity: 64, backend: 'webgpu' });
    t.after(() => engine.dispose());
    const debug = FrameDebugger.attach(engine, { parent: null });
    const bytes = await readFile(new URL(fixture.file, import.meta.url)),
      model = await fixture.parse(engine, bytes),
      mesh = model.primitives[0].node;
    assert.equal(mesh.geometry, null);
    const captureDraws = async () =>
      (await debug.capture({ render: true })).graph
        .filter((entry) => entry.owner === model.name)
        .flatMap((entry) => entry.passes.flatMap((pass) => pass.commands));
    assert.deepEqual(
      (await captureDraws()).map((draw) => draw.entities),
      [[mesh.id]],
    );
    const primitive = model.primitives[0],
      deformed = engine.gpu.createBuffer({ size: primitive.vertices.byteLength, usage: usage.VERTEX });
    primitive.deformed = deformed;
    try {
      assert.deepEqual(
        (await captureDraws()).map((draw) => draw.entities),
        [[mesh.id]],
        'the report follows the current deformed vertex buffer',
      );
    } finally {
      primitive.deformed = undefined;
      deformed.destroy();
    }
  });

test('capture names every PBR primitive and deduplicates mesh ownership of shared vertex buffers', async (t) => {
  const gpu = fakeGPU(t),
    engine = await EngineKernel.create(gpu.canvas, { capacity: 8, backend: 'webgpu' });
  t.after(() => engine.dispose());
  const debug = FrameDebugger.attach(engine, { parent: null }),
    vertices = new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1,
      1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1,
    ]),
    data = { vertices, indices: new Uint32Array([0, 1, 2]) },
    other = { vertices: vertices.slice(), indices: data.indices },
    model = parsePreparedPBR(
      engine,
      {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0, 1] }],
        nodes: [{ mesh: 0 }, { mesh: 0 }],
        meshes: [{ primitives: [{ attributes: {} }, { attributes: {} }, { attributes: {} }] }],
      },
      [[data, data, other]],
    ),
    meshes = [...new Set(model.primitives.map((primitive) => primitive.node))];
  assert.equal(meshes.length, 2);
  assert.ok(meshes.every((mesh) => mesh.geometry === null));
  const picking = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(model), 'pickingPrimitives').get;
  let drawReads = 0;
  Object.defineProperty(model, 'pickingPrimitives', {
    get() {
      drawReads++;
      return picking.call(this);
    },
  });
  const report = await debug.capture({ render: true }),
    commands = report.graph
      .filter((entry) => entry.owner === model.name)
      .flatMap((entry) => entry.passes.flatMap((pass) => pass.commands));
  assert.equal(commands.length, 6);
  assert.equal(drawReads, 1, 'a model draw list is read once even when several mesh nodes share it');
  assert.deepEqual(
    commands.map((command) => command.entities),
    Array.from({ length: 6 }, () => meshes.map((mesh) => mesh.id)),
    'each mesh is listed once even when two primitives share its vertex buffer',
  );
});

test("works under Stats (draw counts agree) and the panel lists passes and selects a draw's mesh", async (t) => {
  const gpu = fakeGPU(t),
    dom = new JSDOM('<body></body>');
  t.after(() => dom.window.close());
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const engine = await EngineKernel.create(gpu.canvas, { capacity: 4, backend: 'webgpu' });
  t.after(() => engine.dispose());
  const stats = Stats.attach(engine, { parent: dom.window.document.body });
  let selected = null;
  engine.use({
    name: 'inspector',
    setup() {},
    select(mesh) {
      selected = mesh;
    },
  });
  const debug = FrameDebugger.attach(engine, { parent: dom.window.document.body });
  const mesh = engine.createMesh().setGeometry(box());
  engine.use(effect());
  const report = await debug.capture({ render: true });
  assert.equal(report.totals.draws + report.totals.dispatches, stats.drawCalls + stats.dispatches);
  assert.deepEqual(
    report.graph.map((entry) => entry.name).filter((name) => name.startsWith('stats')),
    ['stats:begin', 'stats:sample'],
  );
  const panel = dom.window.document.querySelector('[data-margo-frame-debugger]').shadowRoot;
  assert.match(panel.textContent, /fx:compose \(fx, order 10\)/);
  assert.match(panel.textContent, /15\/16/);
  panel.querySelector('td button').click();
  assert.equal(selected, mesh);
  debug.dispose();
  assert.equal(dom.window.document.querySelector('[data-margo-frame-debugger]'), null);
});

test('security: GPU labels and pass names reach the panel as text, never markup (gate 11b)', async (t) => {
  const gpu = fakeGPU(t),
    dom = new JSDOM('<body></body>'),
    hostile = '<img src=x onerror=alert(1)>';
  t.after(() => dom.window.close());
  const engine = await EngineKernel.create(gpu.canvas, { capacity: 4, backend: 'webgpu' });
  t.after(() => engine.dispose());
  const debug = FrameDebugger.attach(engine, { parent: dom.window.document.body });
  t.after(() => debug.dispose());
  // A large labelled texture so it is listed under "GPU memory", and a frame graph pass named like markup.
  engine.gpu.createTexture({ size: [1024, 1024], format: 'rgba8unorm', usage: 4, label: hostile });
  engine.createMesh().setGeometry(box());
  engine.use({ ...effect(), name: hostile });
  await debug.capture({ render: true });
  const panel = dom.window.document.querySelector('[data-margo-frame-debugger]').shadowRoot;
  assert.ok(panel.textContent.includes(hostile), 'the label is shown literally');
  assert.equal(panel.querySelector('img'), null, 'no element was parsed from a label');
});

test('texture size estimate covers mips, layers, samples and block formats', () => {
  assert.equal(
    textureBytes({
      width: 256,
      height: 256,
      depthOrArrayLayers: 1,
      mipLevelCount: 9,
      sampleCount: 1,
      dimension: '2d',
      format: 'rgba8unorm',
    }),
    349524,
  );
  assert.equal(
    textureBytes({
      width: 64,
      height: 64,
      depthOrArrayLayers: 6,
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: 'rgba16float',
    }),
    64 * 64 * 6 * 8,
  );
  assert.equal(
    textureBytes({
      width: 64,
      height: 64,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount: 4,
      dimension: '2d',
      format: 'depth24plus',
    }),
    64 * 64 * 16,
  );
  assert.equal(
    textureBytes({
      width: 128,
      height: 128,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: 'bc7-rgba-unorm',
    }),
    128 * 128,
  );
  assert.equal(
    textureBytes({
      width: 128,
      height: 128,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: 'astc-8x8-unorm',
    }),
    (128 * 128) / 4,
  );
});
