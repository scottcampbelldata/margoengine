import test from 'node:test';
import assert from 'node:assert/strict';
import { GrassField } from '../packages/creative/dist/index.js';
import { Camera, FrameGraph } from '../packages/core/dist/extension.js';

function fixture(t, options = {}, limits = {}) {
  for (const [name, value] of Object.entries({
    GPUBufferUsage: { COPY_SRC: 4, COPY_DST: 8, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
    navigator: { gpu: { getPreferredCanvasFormat: () => 'rgba8unorm' } },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  const state = {
    buffers: [],
    pipelines: [],
    writes: [],
    clears: [],
    passes: [],
    draws: [],
    commands: [],
    resources: 0,
  };
  const pipeline = (descriptor) => {
    state.resources++;
    state.pipelines.push(descriptor);
    return { descriptor, getBindGroupLayout: () => ({}) };
  };
  const device = {
    limits: {
      maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxBufferSize: 256 * 1024 * 1024,
      maxComputeWorkgroupsPerDimension: 65535,
      ...limits,
    },
    features: new Set(),
    createBuffer(descriptor) {
      state.resources++;
      const b = {
        descriptor,
        bytes: new Uint8Array(descriptor.size),
        destroyed: 0,
        destroy() {
          this.destroyed++;
        },
      };
      state.buffers.push(b);
      return b;
    },
    createShaderModule(descriptor) {
      state.resources++;
      return descriptor;
    },
    createComputePipeline: pipeline,
    createRenderPipeline: pipeline,
    createBindGroupLayout(descriptor) {
      state.resources++;
      return descriptor;
    },
    createPipelineLayout(descriptor) {
      state.resources++;
      return descriptor;
    },
    createBindGroup(descriptor) {
      state.resources++;
      return descriptor;
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
        state.writes.push({ buffer, data });
      },
    },
  };
  const graph = new FrameGraph(),
    plugins = new Map();
  const engine = {
    gpu: device,
    lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
    use(plugin) {
      try {
        graph.withOwner(plugin.name, () => {
          plugin.setup(this);
          plugin.registerPasses(graph);
        });
        plugins.set(plugin.name, plugin);
      } catch (error) {
        graph.removeOwner(plugin.name);
        plugin.dispose();
        throw error;
      }
    },
    hasPlugin: (name) => plugins.has(name),
    removePlugin(name) {
      const plugin = plugins.get(name);
      graph.removeOwner(name);
      plugins.delete(name);
      plugin?.dispose();
    },
  };
  const camera = new Camera({ position: [0, 2, 5] });
  camera.update(1, true);
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    drawIndirect(buffer, offset) {
      state.draws.push({ buffer, offset });
      state.commands.push('indirect:' + offset);
    },
    draw(vertices, instances) {
      state.draws.push({ vertices, instances });
      state.commands.push('spores');
    },
    dispatchWorkgroups(count) {
      state.dispatch = count;
      state.commands.push('dispatch:' + count);
    },
    end() {
      state.commands.push('end');
    },
  };
  const context = {
    backend: 'webgpu',
    device,
    camera,
    delta: 0.1,
    format: 'rgba8unorm',
    color: {},
    depth: {},
    descriptor: { depthStencil: { format: 'depth32float' } },
    draw() {},
    encoder: {
      clearBuffer(buffer, offset, size) {
        state.clears.push({ buffer, offset, size });
        state.commands.push('clear:' + offset);
      },
      beginComputePass() {
        state.commands.push('compute');
        return pass;
      },
      beginRenderPass(descriptor) {
        state.passes.push(descriptor);
        state.commands.push('render');
        return pass;
      },
    },
  };
  const stage = { engine };
  const field = new GrassField(stage, { blades: 257, ...options });
  t.after(() => {
    for (const name of plugins.keys()) engine.removePlugin(name);
  });
  return { field, stage, engine, state, device, context, graph };
}

test('GrassField packs rooted six-float instances, a seven-vertex strip and two portable indirect commands', (t) => {
  const { field, state, graph, context } = fixture(t, { area: [60, 40], spores: true });
  graph.execute(context);
  const byLabel = (name) => state.buffers.find((b) => b.descriptor.label === 'grass:' + name);
  const instances = new Float32Array(byLabel('instances').bytes.buffer);
  assert.equal(instances.length, 257 * 6);
  for (let i = 0; i < 257; i++) {
    assert.ok(Math.abs(instances[i * 6]) <= 30 && Math.abs(instances[i * 6 + 2]) <= 20);
    assert.equal(instances[i * 6 + 1], 0);
    assert.ok(instances[i * 6 + 4] >= 0.7 && instances[i * 6 + 4] <= 1.25);
    assert.ok(instances[i * 6 + 5] >= 0.75 && instances[i * 6 + 5] <= 1.25);
  }
  assert.deepEqual([...new Uint32Array(byLabel('indirect').bytes.buffer)], [7, 0, 0, 0, 3, 0, 7, 0]);
  assert.equal(byLabel('indirect').descriptor.usage, 396);
  const vertices = new Float32Array(byLabel('blade').bytes.buffer);
  assert.equal(vertices.length, 50);
  assert.equal(vertices[4], 0);
  assert.equal(vertices[9], 0);
  assert.equal(vertices[34], 1);
  for (const descriptor of state.pipelines.filter((p) => ['nearVertex', 'farVertex'].includes(p.vertex?.entryPoint))) {
    assert.equal(descriptor.primitive.topology, 'triangle-strip');
    assert.equal(descriptor.primitive.cullMode, 'none');
    assert.equal(descriptor.depthStencil.depthCompare, 'greater-equal');
    assert.equal(descriptor.depthStencil.depthWriteEnabled, true);
  }
  assert.deepEqual(state.commands, [
    'clear:4',
    'clear:20',
    'compute',
    'dispatch:5',
    'end',
    'render',
    'indirect:0',
    'indirect:16',
    'end',
    'render',
    'spores',
    'end',
  ]);
  assert.equal(state.dispatch, 5);
  assert.deepEqual(
    state.clears.map((c) => [c.offset, c.size]),
    [
      [4, 4],
      [20, 4],
    ],
  );
  assert.deepEqual(
    state.draws.map((d) => d.offset ?? [d.vertices, d.instances]),
    [0, 16, [6, 240]],
  );
  assert.equal(field.windTime, 0.1);
  const frame = state.writes.at(-1).data;
  assert.equal(frame.byteLength, 288);
  assert.deepEqual([...frame.slice(16, 40)], [...context.camera.planes]);
  assert.ok(Math.abs(Math.hypot(frame[52], frame[53]) - 1) < 1e-6);
});

test('GrassField.destroy removes compute and both render passes before releasing buffers, even when repeated', (t) => {
  const { field, engine, state, context, graph } = fixture(t, { spores: true });
  graph.execute(context);
  const buffers = state.buffers.slice(),
    writes = state.writes.length,
    time = field.windTime;
  for (const buffer of buffers)
    buffer.destroy = () => {
      assert.equal(engine.hasPlugin(field.name), false, 'Buffer destroyed before deregistration');
      buffer.destroyed++;
    };
  field.destroy();
  field.destroy();
  field.dispose();
  assert.equal(engine.hasPlugin(field.name), false);
  assert.ok(buffers.every((buffer) => buffer.destroyed === 1));
  for (const key of [
    'instances',
    'visible',
    'indirect',
    'vertices',
    'uniform',
    'compute',
    'computeGroup',
    'engine',
    'device',
  ])
    assert.equal(field[key], undefined);
  state.commands.length = 0;
  for (let i = 0; i < 10; i++) graph.execute(context);
  assert.deepEqual(state.commands, []);
  assert.equal(state.writes.length, writes);
  assert.equal(field.windTime, time);
});

test('GrassField reuses staging, descriptors and all resources for canvas and HDR frames', (t) => {
  const { field, state, device, context, graph } = fixture(t, { spores: true });
  graph.execute(context);
  context.format = 'rgba16float';
  graph.execute(context);
  const data = state.writes.at(-1).data,
    grassPass = state.passes[0],
    sporePass = state.passes[1],
    resources = state.resources;
  for (const name of Object.keys(device))
    if (name.startsWith('create')) device[name] = () => assert.fail('Allocated ' + name);
  for (let i = 0; i < 20; i++) {
    context.format = i % 2 ? 'rgba16float' : 'rgba8unorm';
    graph.execute(context);
    assert.equal(state.writes.at(-1).data, data);
  }
  assert.equal(state.resources, resources);
  assert.ok(state.passes.every((p, i) => p === (i % 2 ? sporePass : grassPass)));
  assert.equal(data[62], 1);
  assert.equal(grassPass.depthStencilAttachment.depthLoadOp, 'load');
  assert.equal(sporePass.depthStencilAttachment.depthReadOnly, true);
  const snapshot = data.slice();
  for (const value of [NaN, Infinity, -1, '1', 101])
    assert.throws(() => {
      field.windSpeed = value;
    }, /speed/);
  for (const value of [NaN, Infinity, -1, '1', 3])
    assert.throws(() => {
      field.windStrength = value;
    }, /strength/);
  for (const value of [NaN, Infinity, -1, '1', 1e40])
    assert.throws(() => {
      field.windTime = value;
    }, /time/);
  assert.deepEqual(data, snapshot);
  field.windSpeed = 0;
  field.windStrength = 0;
});

test('GrassField validates options, WebGPU and device limits before allocating', (t) => {
  const { stage, engine, state, field } = fixture(t);
  field.dispose();
  const resources = state.resources;
  for (const options of [
    { blades: 0 },
    { blades: 1.5 },
    { blades: 16_777_217 },
    { area: [0, 1] },
    { area: [1e-50, 1] },
    { area: [1, Infinity] },
    { area: [1, 1, 1] },
    { bladeHeight: '1' },
    { bladeHeight: 0 },
    { bladeHeight: 101 },
    { drawDistance: 0 },
    { windSpeed: NaN },
    { windDirection: [0, 0] },
    { windDirection: [1, '2'] },
    { spores: 'yes' },
  ])
    assert.throws(() => new GrassField(stage, options));
  engine.gpu = null;
  assert.throws(() => new GrassField(stage), /WebGPU/);
  engine.gpu = { limits: { maxStorageBufferBindingSize: 16, maxBufferSize: 256, maxComputeWorkgroupsPerDimension: 1 } };
  assert.throws(() => new GrassField(stage), /GPU limits/);
  assert.equal(state.resources, resources);
});

test('GrassField handles independent fields, direct disposal, restoration and failed setup cleanup', (t) => {
  const { field, engine, stage, state, device, context, graph } = fixture(t);
  const other = new GrassField(stage, { blades: 1 });
  assert.notEqual(field.name, other.name);
  graph.execute(context);
  const time = field.windTime,
    old = state.buffers.slice(0, 5);
  field.onDeviceRestored(engine);
  assert.equal(field.windTime, time);
  assert.ok(old.every((b) => b.destroyed === 1));
  field.dispose();
  field.dispose();
  assert.equal(engine.hasPlugin(field.name), false);
  assert.equal(engine.hasPlugin(other.name), true);
  state.draws.length = 0;
  graph.execute(context);
  assert.equal(state.draws.length, 2);
  other.dispose();
  state.draws.length = 0;
  graph.execute(context);
  assert.equal(state.draws.length, 0);
  device.createRenderPipeline = () => {
    throw new Error('Pipeline failed');
  };
  const before = state.buffers.length;
  assert.throws(() => new GrassField(stage, { blades: 1 }), /Pipeline failed/);
  assert.ok(state.buffers.slice(before).every((b) => b.destroyed === 1));
});

test('GrassField builds only its initial variant, warms changed targets once, and retries failed variants', (t) => {
  const { field, state, device, context, graph } = fixture(t, { spores: true });
  const renders = () => state.pipelines.filter((p) => p.vertex);
  assert.equal(renders().length, 3, 'Unused canvas/HDR and sampling variants must not compile during setup');
  context.descriptor.multisample = { count: 4 };
  graph.execute(context);
  assert.equal(renders().length, 3);
  context.format = 'rgba16float';
  graph.execute(context);
  assert.equal(renders().length, 6);
  context.descriptor.multisample.count = 1;
  graph.execute(context);
  assert.equal(renders().length, 9);
  context.descriptor.depthStencil.format = 'depth24plus';
  graph.execute(context);
  assert.equal(renders().length, 12);
  assert.ok(
    renders()
      .slice(-3)
      .every((p) => p.depthStencil.format === 'depth24plus'),
  );
  const resources = state.resources;
  for (let i = 0; i < 120; i++) graph.execute(context);
  assert.equal(state.resources, resources, 'Stable frames must retain pipelines, layouts and groups');
  const create = device.createRenderPipeline,
    failure = new Error('Variant failed');
  device.createRenderPipeline = () => {
    throw failure;
  };
  context.descriptor.depthStencil.format = 'depth32float';
  context.format = 'rgba8unorm';
  context.descriptor.multisample.count = 1;
  assert.throws(
    () => graph.execute(context),
    (error) => error === failure,
  );
  device.createRenderPipeline = create;
  graph.execute(context);
  assert.ok(
    renders()
      .slice(-3)
      .every((p) => p.depthStencil.format === 'depth32float' && p.multisample.count === 1),
  );
  context.format = 'r32uint';
  assert.throws(() => graph.execute(context), /Unsupported grass/);
  context.format = 'rgba8unorm';
  context.descriptor.multisample.count = 2;
  assert.throws(() => graph.execute(context), /Unsupported grass/);
  field.dispose();
  assert.equal(field.variants.size, 0);
});
