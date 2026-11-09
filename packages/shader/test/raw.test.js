import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { RawShaderMaterial, RawMesh, RawPicking, RawShaders } from '../dist/raw.js';

const shader = `
struct Out { @builtin(position) clip:vec4f, @location(0) tint:vec3f }
@vertex fn vertex(a:Attributes)->Out {
  return Out(camera.projection * camera.view * mesh.world * vec4f(a.position + a.offset, 1.0), vec3f(a.uv, 0.0) * uniforms.gain);
}
@fragment fn fragment(i:Out)->@location(0) vec4f { return margoDisplay(vec4f(i.tint, 1.0)); }`;
const quad = () => ({
  position: { data: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], type: 'vec3f' },
  uv: { data: [0, 0, 1, 0, 1, 1, 0, 1], type: 'vec2f' },
  offset: { data: [0, 0, 0, 2, 0, 0], type: 'vec3f', step: 'instance' },
  id: { data: [0, 1], type: 'u32', step: 'instance' },
});
const material = (extra = {}) =>
  new RawShaderMaterial({ vertexShader: shader, uniforms: { gain: { value: 1 } }, ...extra });

/** A mock engine with the real FrameGraph; `swap()` moves it to a fresh mock device (device restoration). */
function harness({ samples = 4, format = 'bgra8unorm', depthFormat = 'depth24plus-stencil8', async = false } = {}) {
  const graph = new FrameGraph(),
    plugins = new Map(),
    h = { graph, plugins, index: 0 };
  const device = (gpu) => {
    if (async) {
      Object.assign(gpu.device, {
        createRenderPipelineAsync: async (d) => gpu.device.createRenderPipeline(d),
        pushErrorScope() {},
        popErrorScope: async () => null,
      });
    }
    return gpu;
  };
  h.gpu = device(mockGPU());
  h.engine = {
    gpu: h.gpu.device,
    frameGraph: graph,
    disposed: false,
    meshes: new Map(),
    store: { hidden: new Uint8Array(8), matrices: new Float32Array(128) },
    hasPlugin: (name) => plugins.has(name),
    sceneOf: (plugin) => (plugins.get(plugin.name) === plugin ? h.engine : undefined),
    use(plugin) {
      graph.withOwner(plugin.name, () => {
        plugin.setup(h.engine);
        plugin.registerPasses?.(graph);
      });
      plugins.set(plugin.name, plugin);
      return h.engine;
    },
    removePlugin(name) {
      const plugin = plugins.get(name);
      if (plugin) {
        graph.removeOwner(name);
        plugins.delete(name);
        plugin.dispose?.();
      }
    },
  };
  h.view = context(h.gpu, { samples, shader: wgsl, format, depthFormat });
  h.frame = () => {
    h.view.begin(h.index++);
    if (h.matrix) h.view.camera.matrix.set(h.matrix);
    graph.execute(h.view.c);
  };
  h.swap = () => {
    h.gpu = device(mockGPU());
    h.engine.gpu = h.gpu.device;
    h.view = context(h.gpu, { samples, shader: wgsl, format, depthFormat });
    for (const plugin of plugins.values()) plugin.onDeviceRestored?.(h.engine);
  };
  return h;
}
const named = (log, name) => log.filter((call) => call[0] === name);
const floats = (hex) => [...new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer)];

test('the prelude declares camera, mesh, attributes in location order, uniforms with WGSL offsets and textures', () => {
  const m = new RawShaderMaterial({
    vertexShader: shader,
    uniforms: {
      gain: { value: 1 },
      tint: { value: '#ff8800' },
      count: { value: 3, type: 'u32' },
      model: { value: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      shift: { value: [1, 2] },
      basis: { value: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    },
    textures: { map: null, cells: { texture: null, sampleType: 'uint', dimension: '2d-array' } },
  });
  assert.deepEqual(
    m.members.map((x) => [x.name, x.type, x.offset]),
    [
      ['gain', 'f32', 0],
      ['tint', 'vec3f', 16],
      ['count', 'u32', 28],
      ['model', 'mat4x4f', 32],
      ['shift', 'vec2f', 96],
      ['basis', 'mat3x3f', 112],
    ],
  );
  assert.equal(m.size, 160);
  const mesh = new RawMesh({ material: m, attributes: quad() }),
    code = m.code('vertex', mesh);
  for (const line of [
    'struct MargoCamera { view:mat4x4f, projection:mat4x4f, viewProjection:mat4x4f, position:vec3f, time:f32, resolution:vec2f, deltaTime:f32, encoding:f32 }',
    '@group(0) @binding(0) var<uniform> camera:MargoCamera;',
    '@group(0) @binding(1) var<uniform> mesh:MargoMesh;',
    '  @location(0) position:vec3f,',
    '  @location(1) uv:vec2f,',
    '  @location(2) offset:vec3f,',
    '  @location(3) id:u32,',
    '  basis:mat3x3f,',
    '@group(1) @binding(0) var<uniform> uniforms:Uniforms;',
    '@group(1) @binding(1) var map:texture_2d<f32>;',
    '@group(1) @binding(2) var mapSampler:sampler;',
    '@group(1) @binding(3) var cells:texture_2d_array<u32>;',
    '@group(1) @binding(4) var cellsSampler:sampler;',
  ])
    assert.ok(code.includes(line), line);
  assert.ok(code.endsWith(shader), 'user code follows the prelude unchanged');
  assert.equal(m.code('fragment', mesh), code, 'one module holds both entry points');
  assert.ok(!m.code('vertex').includes('struct Attributes'), 'no attributes, no struct');
  assert.deepEqual(m.uniforms.tint.type, 'vec3f');
  assert.deepEqual(
    mesh.layout.map((a) => [a.name, a.type, a.step]),
    [
      ['position', 'vec3f', 'vertex'],
      ['uv', 'vec2f', 'vertex'],
      ['offset', 'vec3f', 'instance'],
      ['id', 'u32', 'instance'],
    ],
  );
});

test('draws in the main pass after core: interleaved buffers, reversed-Z depth, the pass format and samples', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material(),
    mesh = raw.add(new RawMesh({ material: m, attributes: quad(), index: [0, 1, 2, 0, 2, 3] }));
  const log = h.gpu.record(() => h.frame());
  const [pipeline] = named(log, 'renderPipeline');
  const d = pipeline[2];
  assert.deepEqual(d.vertex.buffers, [
    {
      arrayStride: 20,
      stepMode: 'vertex',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x2' },
      ],
    },
    {
      arrayStride: 16,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 2, offset: 0, format: 'float32x3' },
        { shaderLocation: 3, offset: 12, format: 'uint32' },
      ],
    },
  ]);
  assert.deepEqual(d.depthStencil, {
    format: 'depth24plus-stencil8',
    depthWriteEnabled: true,
    depthCompare: 'greater-equal',
  });
  assert.deepEqual(d.multisample, { count: 4 });
  assert.deepEqual(d.fragment.targets, [{ format: 'bgra8unorm', writeMask: 15 }], 'opaque normal blending is off');
  assert.equal(d.primitive.cullMode, 'back');
  assert.equal(d.vertex.entryPoint, 'vertex');
  assert.equal(d.fragment.entryPoint, 'fragment');
  assert.equal(d.vertex.module, d.fragment.module, 'one module for one source');
  const core = log.findIndex((c) => c[0] === 'draw'),
    begin = log.findIndex((c) => c[0] === 'beginRenderPass');
  assert.ok(core >= 0 && begin > core, 'after the core main pass (order 0)');
  const pass = log[begin][1];
  assert.equal(pass.colorAttachments[0].loadOp, 'load');
  assert.equal(pass.depthStencilAttachment.depthLoadOp, 'load');
  assert.equal(pass.depthStencilAttachment.stencilReadOnly, true);
  assert.deepEqual(named(log, 'pass.drawIndexed')[0].slice(1, 4), [6, 2, 0]);
  assert.deepEqual(
    named(log, 'pass.setVertexBuffer').map((c) => c[1]),
    [0, 1],
  );
  // Vertex stream: position then uv per vertex; instance stream: offset then the u32 id's bits.
  const buffers = named(log, 'buffer').filter((c) => c[2].label?.startsWith('shader:raw:'));
  const write = (label) => {
    const id = buffers.find((c) => c[2].label === label)[1];
    return log.find((c) => c[0] === 'writeBuffer' && c[1] === id);
  };
  assert.deepEqual(floats(write('shader:raw:vertex')[3]).slice(0, 10), [-1, -1, 0, 0, 0, 1, -1, 0, 1, 0]);
  const instance = Buffer.from(write('shader:raw:instance')[3], 'hex');
  assert.deepEqual([instance.readFloatLE(16), instance.readUInt32LE(28)], [2, 1]);
  // Camera block: projection x view = viewProjection (the camera matrix core draws with).
  const camera = floats(write('shader:raw:camera')[3]),
    view = camera.slice(0, 16),
    projection = camera.slice(16, 32);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += projection[k * 4 + r] * view[c * 4 + k];
      assert.ok(Math.abs(sum - h.view.camera.matrix[c * 4 + r]) < 1e-4, `P*V[${c},${r}]`);
    }
  assert.deepEqual(camera.slice(32, 48), [...h.view.camera.matrix]);
  assert.deepEqual(camera.slice(52, 56), [1280, 720, Math.fround(1 / 60), 1], 'resolution, deltaTime, display target');
  // Mesh block: world then the normal matrix.
  assert.deepEqual(floats(write('shader:raw:mesh')[3]).slice(0, 16), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(raw.stats.drawCalls, 1);
  assert.equal(mesh.owner, raw);
});

test('uniforms and attributes update live: no recompiles, ranged uploads, growth re-creates the buffer', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material(),
    mesh = raw.add(new RawMesh({ material: m, attributes: quad(), index: [0, 1, 2, 0, 2, 3] }));
  const first = h.gpu.record(() => h.frame()),
    id = (label) => named(first, 'buffer').find((c) => c[2].label === label)[1];
  const uniforms = id('shader:raw:uniforms'),
    instances = id('shader:raw:instance'),
    object = id('shader:raw:mesh');
  const quiet = h.gpu.record(() => h.frame());
  assert.deepEqual(
    named(quiet, 'writeBuffer').map((c) => c[1]),
    [id('shader:raw:camera')],
    'an unchanged frame writes only the camera block',
  );
  m.uniforms.gain.value = 0.5;
  const changed = h.gpu.record(() => h.frame());
  assert.equal(named(changed, 'module').length + named(changed, 'renderPipeline').length, 0, 'no recompile');
  const w = named(changed, 'writeBuffer').find((c) => c[1] === uniforms);
  assert.equal(floats(w[3])[0], 0.5);
  mesh.setAttribute('offset', [0, 0, 0, 5, 6, 7], [1, 1]);
  const ranged = named(
    h.gpu.record(() => h.frame()),
    'writeBuffer',
  ).find((c) => c[1] === instances);
  assert.equal(ranged[2], 16, 'second instance only');
  assert.deepEqual(floats(ranged[3]).slice(0, 3), [5, 6, 7]);
  assert.equal(ranged[3].length / 2, 16);
  mesh.matrix[12] = 3;
  const moved = named(
    h.gpu.record(() => h.frame()),
    'writeBuffer',
  ).find((c) => c[1] === object);
  assert.equal(floats(moved[3])[12], 3);
  // A third instance: both instance attributes grow, the stream is re-created and the draw follows.
  mesh.setAttribute('offset', [0, 0, 0, 5, 6, 7, 1, 1, 1]);
  mesh.setAttribute('id', [0, 1, 2]);
  const grown = h.gpu.record(() => h.frame());
  assert.ok(named(grown, 'destroy').some((c) => c[1] === instances));
  assert.ok(named(grown, 'buffer').some((c) => c[2].label === 'shader:raw:instance' && c[2].size === 48));
  assert.deepEqual(named(grown, 'pass.drawIndexed')[0].slice(1, 3), [6, 3]);
  mesh.instanceCount = 1;
  mesh.drawRange.start = 3;
  assert.deepEqual(
    named(
      h.gpu.record(() => h.frame()),
      'pass.drawIndexed',
    )[0].slice(1, 4),
    [3, 1, 3],
  );
  // A new attribute changes the layout: a new module and pipeline.
  mesh.setAttribute('weight', { data: [1, 1, 1, 1], type: 'f32' });
  const relaid = h.gpu.record(() => h.frame());
  assert.equal(named(relaid, 'renderPipeline').length, 1);
  assert.equal(named(relaid, 'renderPipeline')[0][2].vertex.buffers[0].arrayStride, 24);
  assert.ok(m.code('vertex', mesh).includes('@location(4) weight:f32,'));
});

test('transparent meshes draw after the opaque ones, back to front, with blending; render state is live', () => {
  const h = harness({ samples: 1, format: 'rgba16float' }),
    raw = RawShaders.attach(h.engine),
    vertexShader = `@vertex fn vertex(a:Attributes)->@builtin(position) vec4f { return camera.viewProjection * mesh.world * vec4f(a.position, 1.0); }
@fragment fn fragment()->@location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 0.5); }`,
    glass = new RawShaderMaterial({ vertexShader, transparent: true, depthWrite: false }),
    solid = new RawShaderMaterial({ vertexShader, cull: 'none' }),
    triangle = { position: { data: [0, 0, 0, 1, 0, 0, 0, 1, 0], type: 'vec3f' } };
  const near = raw.add(
      new RawMesh({
        material: glass,
        attributes: triangle,
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1],
        instanceCount: 2,
      }),
    ),
    far = raw.add(
      new RawMesh({
        material: glass,
        attributes: triangle,
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -20, 1],
        instanceCount: 1,
        // Past the mock camera's far plane: this test is about draw order.
        frustumCulled: false,
      }),
    );
  raw.add(new RawMesh({ material: solid, attributes: triangle, instanceCount: 7 }));
  const log = h.gpu.record(() => h.frame()),
    passes = named(log, 'beginRenderPass').map((c) => c[1].label);
  assert.deepEqual(passes.slice(-2), ['shader:raw:opaque', 'shader:raw:transparent']);
  assert.deepEqual(
    named(log, 'pass.draw').map((c) => c[2]),
    [7, 1, 2],
    'opaque, then far before near',
  );
  const pipelines = named(log, 'renderPipeline').map((c) => c[2]);
  const blended = pipelines.find((d) => d.fragment.targets[0].blend);
  assert.deepEqual(blended.fragment.targets[0].blend.color, {
    srcFactor: 'src-alpha',
    dstFactor: 'one-minus-src-alpha',
    operation: 'add',
  });
  assert.equal(blended.depthStencil.depthWriteEnabled, false);
  assert.equal(blended.depthStencil.format, 'depth24plus-stencil8');
  assert.equal(blended.fragment.targets[0].format, 'rgba16float');
  assert.equal(pipelines.find((d) => !d.fragment.targets[0].blend).primitive.cullMode, 'none');
  near.renderOrder = -1;
  assert.deepEqual(
    named(
      h.gpu.record(() => h.frame()),
      'pass.draw',
    ).map((c) => c[2]),
    [7, 2, 1],
    'renderOrder first',
  );
  glass.blending = 'additive';
  glass.depthTest = false;
  const restate = named(
    h.gpu.record(() => h.frame()),
    'renderPipeline',
  ).map((c) => c[2]);
  assert.equal(restate.length, 1, 'one new pipeline for the new state');
  assert.equal(restate[0].fragment.targets[0].blend.color.dstFactor, 'one');
  assert.equal(restate[0].depthStencil.depthCompare, 'always');
  far.visible = false;
  assert.equal(
    named(
      h.gpu.record(() => h.frame()),
      'pass.draw',
    ).length,
    2,
  );
});

test('pipelines compile asynchronously; a WGSL error is reported once with its line and the draw is skipped', async () => {
  const h = harness({ async: true }),
    raw = RawShaders.attach(h.engine),
    m = material(),
    mesh = raw.add(new RawMesh({ material: m, attributes: quad(), index: [0, 1, 2] }));
  assert.equal(
    named(
      h.gpu.record(() => h.frame()),
      'pass.drawIndexed',
    ).length,
    0,
    'pending: not drawn yet',
  );
  assert.equal(raw.stats.pending, 1);
  await raw.ready();
  assert.equal(
    named(
      h.gpu.record(() => h.frame()),
      'pass.drawIndexed',
    ).length,
    1,
  );
  // A broken shader: the module reports an error two lines into the user's code. Like Chromium on an idle device,
  // the mock answers getCompilationInfo() only when asked before the pipeline is requested; later it stays pending.
  const lines = m.prelude(mesh).split('\n').length - 1,
    device = h.gpu.device,
    create = device.createShaderModule;
  let pipelineRequested = false;
  device.createShaderModule = (d) =>
    Object.assign(create(d), {
      getCompilationInfo: () =>
        pipelineRequested
          ? new Promise(() => {})
          : Promise.resolve({
              messages: [{ type: 'error', lineNum: lines + 2, linePos: 5, message: "unresolved value 'nope'" }],
            }),
    });
  device.createRenderPipelineAsync = async () => {
    pipelineRequested = true;
    throw new Error('validation failed');
  };
  const errors = [];
  m.onError = (e) => errors.push(e);
  m.vertexShader = shader.replace('uniforms.gain', 'nope');
  const broken = h.gpu.record(() => h.frame());
  assert.equal(named(broken, 'pass.drawIndexed').length, 0);
  // fixed-wait: a bound on a promise that wins as soon as it settles; the assert below says if it never did
  await Promise.race([raw.ready(), new Promise((resolve) => setTimeout(resolve, 1000))]);
  assert.equal(errors.length, 1, 'the compile error is reported although the device went idle');
  assert.equal(errors[0].name, 'MargoError');
  assert.equal(errors[0].code, 'failed');
  assert.match(errors[0].message, /vertexShader line 2:5: unresolved value 'nope'/);
  assert.equal(m.error, errors[0]);
  const after = h.gpu.record(() => h.frame());
  assert.equal(named(after, 'renderPipeline').length + named(after, 'pass.drawIndexed').length, 0, 'no retry, no draw');
  assert.equal(errors.length, 1, 'reported once');
  device.createRenderPipelineAsync = async (d) => device.createRenderPipeline(d);
  m.vertexShader = shader;
  assert.equal(m.error, undefined);
  h.frame();
  await raw.ready();
  assert.equal(
    named(
      h.gpu.record(() => h.frame()),
      'pass.drawIndexed',
    ).length,
    1,
    'fixed shader draws again',
  );
});

test('device restoration rebuilds every GPU object; dispose releases them; a core mesh can be followed', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material({ textures: { map: null } }),
    mesh = raw.add(new RawMesh({ material: m, attributes: quad(), index: [0, 1, 2] }));
  const first = h.gpu.record(() => h.frame()),
    made = named(first, 'buffer')
      .filter((c) => c[2].label?.startsWith('shader:raw:'))
      .map((c) => c[1]);
  assert.equal(made.length, 6, 'camera, uniforms, mesh, vertex, instance, index');
  const old = h.gpu,
    destroyed = old.record(() => h.swap());
  assert.deepEqual(
    named(destroyed, 'destroy')
      .map((c) => c[1])
      .sort(),
    [...made].sort(),
  );
  const rebuilt = h.gpu.record(() => h.frame());
  assert.equal(named(rebuilt, 'buffer').filter((c) => c[2].label?.startsWith('shader:raw:')).length, 6);
  assert.equal(named(rebuilt, 'renderPipeline').length, 1);
  assert.equal(named(rebuilt, 'pass.drawIndexed').length, 1);
  // Follow a core mesh: world = mesh world x matrix.
  const core = { id: 0, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]) };
  h.engine.meshes.set(0, core);
  mesh.mesh = core;
  mesh.matrix[12] = 1;
  const follow = h.gpu.record(() => h.frame()),
    objectId = named(rebuilt, 'buffer').find((c) => c[2].label === 'shader:raw:mesh')[1],
    world = floats(follow.find((c) => c[0] === 'writeBuffer' && c[1] === objectId)[3]);
  assert.deepEqual(world.slice(12, 15), [11, 20, 30]);
  h.engine.store.hidden[0] = 1;
  assert.equal(
    named(
      h.gpu.record(() => h.frame()),
      'pass.drawIndexed',
    ).length,
    0,
    'hidden with its core mesh',
  );
  h.engine.store.hidden[0] = 0;
  const gone = h.gpu.record(() => mesh.dispose());
  assert.equal(named(gone, 'destroy').length, 4, 'mesh, vertex, instance, index');
  assert.equal(mesh.owner, undefined);
  assert.throws(() => mesh.setAttribute('uv', [0, 0, 1, 0, 1, 1, 0, 1]), { name: 'MargoError', code: 'disposed' });
  assert.throws(() => raw.add(mesh), { code: 'disposed' });
  const closing = h.gpu.record(() => h.engine.removePlugin(raw.name));
  assert.equal(named(closing, 'destroy').length, 1, 'the camera block');
  m.dispose();
});

test('arguments and values are checked with messages that name the fix', () => {
  assert.throws(
    () => new RawShaderMaterial({ vertexShader: '@fragment fn f()->@location(0) vec4f {return vec4f(1);}' }),
    {
      name: 'TypeError',
      message: /has no @vertex fn/,
    },
  );
  assert.throws(
    () => new RawShaderMaterial({ vertexShader: '@vertex fn v()->@builtin(position) vec4f {return vec4f(1);}' }),
    /no @fragment fn/,
  );
  assert.throws(() => material({ uniforms: { fn: { value: 1 } } }), /not a usable WGSL identifier/);
  assert.throws(() => material({ uniforms: { camera: { value: 1 } } }), /prelude name/);
  assert.throws(() => material({ uniforms: { odd: { value: [1, 2, 3, 4, 5] } } }), /has no WGSL type/);
  assert.throws(() => material({ textures: { map: { texture: null, dimension: 'cube-array' } } }), TypeError);
  const m = material();
  assert.throws(() => new RawMesh({ material: m, attributes: { p: { data: [1, 2], type: 'vec3f' } } }), {
    name: 'RangeError',
    message: /multiple of 3 numbers for vec3f/,
  });
  assert.throws(() => new RawMesh({ material: m, attributes: { p: { data: [1], type: 'vec3' } } }), TypeError);
  assert.throws(() => new RawMesh({ material: {} }), TypeError);
  const attributes = Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['a' + i, { data: [0], type: 'f32' }]));
  assert.throws(() => new RawMesh({ material: m, attributes }), /16 attributes/);
  const mesh = new RawMesh({ material: m, attributes: quad() });
  assert.throws(() => mesh.setAttribute('missing', [1]), /pass \{data, type, step\?\} to add one/);
  assert.throws(() => mesh.setAttribute('uv', [0, 0, 1, 0], [1, 1]), RangeError);
  assert.throws(() => mesh.setAttribute('uv', [0, 0, 1, 0, 1, 1, 0, 1], [3, 2]), RangeError);
  assert.throws(() => mesh.setIndex([0, -1]), RangeError);
  const h = harness(),
    raw = RawShaders.attach(h.engine);
  raw.add(mesh);
  assert.throws(() => new RawShaders({ name: 'other' }).add(mesh), { name: 'MargoError', code: 'attached' });
  m.uniforms.gain.value = [1, 2];
  assert.throws(() => h.frame(), { name: 'RangeError', message: /uniform gain needs 1 finite number for f32/ });
  assert.throws(() => new RawShaders().setup({ gpu: null }), { code: 'unsupported' });
  assert.throws(() => new RawShaders({ opaqueOrder: Number.NaN }), RangeError);
});

test('meshes of one material bind its group once a pass; each mesh binds its own object group', () => {
  // p-custom-shader draws 10,000 raw meshes of one material: every draw re-bound the same material group, a native
  // call per mesh. A bound group stays bound across draws and pipelines of a pass, so it is bound when it changes.
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    a = material(),
    b = material();
  for (const [m, order] of [
    [a, 0],
    [a, 0],
    [a, 0],
    [b, 1],
    [a, 2],
  ])
    raw.add(new RawMesh({ material: m, attributes: quad(), index: [0, 1, 2, 0, 2, 3], renderOrder: order }));
  h.frame();
  const log = h.gpu.record(() => h.frame()),
    binds = named(log, 'pass.setBindGroup'),
    draws = named(log, 'pass.drawIndexed').length;
  assert.equal(draws, 5);
  assert.equal(binds.filter((c) => c[1] === 0).length, 5, 'one object group per mesh');
  const material1 = binds.filter((c) => c[1] === 1).map((c) => c[2]);
  assert.equal(material1.length, 3, 'material a, then b, then a again');
  assert.notEqual(material1[0], material1[1]);
  assert.equal(material1[0], material1[2]);
  // Group 1 is bound before the first draw of each run of its material.
  const order = log.filter((c) => c[0] === 'pass.drawIndexed' || (c[0] === 'pass.setBindGroup' && c[1] === 1));
  assert.deepEqual(
    order.map((c) => (c[0] === 'pass.drawIndexed' ? 'draw' : 'bind')),
    ['bind', 'draw', 'draw', 'draw', 'bind', 'draw', 'bind', 'draw'],
  );
});

test('raw meshes with equal bytes share their buffers, and a run of them binds each once', () => {
  // p-custom-shader: 10,000 meshes of one geometry each uploaded and bound their own vertex and index buffers, two
  // native calls per draw that changed nothing.
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material(),
    index = [0, 1, 2, 0, 2, 3];
  const setup = h.gpu.record(() => {
    for (let i = 0; i < 3; i++) raw.add(new RawMesh({ material: m, attributes: quad(), index }));
    h.frame();
  });
  const made = (label) => named(setup, 'buffer').filter((c) => c[2].label === label).length;
  assert.equal(made('shader:raw:vertex'), 1);
  assert.equal(made('shader:raw:instance'), 1);
  assert.equal(made('shader:raw:index'), 1);
  assert.equal(made('shader:raw:mesh'), 3, 'each mesh keeps its own object block');
  const log = h.gpu.record(() => h.frame());
  assert.equal(named(log, 'pass.drawIndexed').length, 3);
  assert.equal(named(log, 'pass.setVertexBuffer').length, 2, 'vertex and instance streams, once each');
  assert.equal(named(log, 'pass.setIndexBuffer').length, 1);
  assert.equal(named(log, 'pass.setBindGroup').filter((c) => c[1] === 0).length, 3);
});

test('different bytes never share, and a shared buffer is rebound when the next draw needs another', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material(),
    index = [0, 1, 2, 0, 2, 3],
    other = quad();
  other.position.data = other.position.data.map((v) => v * 2);
  raw.add(new RawMesh({ material: m, attributes: quad(), index, renderOrder: 0 }));
  raw.add(new RawMesh({ material: m, attributes: other, index, renderOrder: 1 }));
  raw.add(new RawMesh({ material: m, attributes: quad(), index, renderOrder: 2 }));
  h.frame();
  const slot0 = named(
    h.gpu.record(() => h.frame()),
    'pass.setVertexBuffer',
  )
    .filter((c) => c[1] === 0)
    .map((c) => c[2]);
  assert.equal(slot0.length, 3, 'first, other, first again');
  assert.notEqual(slot0[0], slot0[1]);
  assert.equal(slot0[0], slot0[2]);
});

test('equal index bytes of another format share the buffer and still set the format', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material();
  raw.add(new RawMesh({ material: m, attributes: quad(), index: new Uint32Array([0, 1, 2, 3]), renderOrder: 0 }));
  raw.add(
    new RawMesh({ material: m, attributes: quad(), index: new Uint16Array([0, 0, 1, 0, 2, 0, 3, 0]), renderOrder: 1 }),
  );
  h.frame();
  const calls = named(
    h.gpu.record(() => h.frame()),
    'pass.setIndexBuffer',
  );
  assert.deepEqual(
    calls.map((c) => c[2]),
    ['uint32', 'uint16'],
  );
  assert.equal(calls[0][1], calls[1][1]);
});

test('a write copies a shared buffer for that mesh only', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material();
  let a, b;
  const vertexIds = (log) =>
    named(log, 'buffer')
      .filter((c) => c[2].label === 'shader:raw:vertex')
      .map((c) => c[1]);
  const [sharedId, ...more] = vertexIds(
    h.gpu.record(() => {
      a = raw.add(new RawMesh({ material: m, attributes: quad() }));
      b = raw.add(new RawMesh({ material: m, attributes: quad() }));
      h.frame();
    }),
  );
  assert.deepEqual(more, []);
  const shared = a.gpu.vertex.buffer;
  assert.equal(b.gpu.vertex.buffer, shared);
  b.setAttribute('uv', [1, 1, 0, 1, 0, 0, 1, 0]);
  const log = h.gpu.record(() => h.frame()),
    [copyId] = vertexIds(log);
  assert.equal(a.gpu.vertex.buffer, shared, 'the other mesh keeps the buffer');
  assert.notEqual(b.gpu.vertex.buffer, shared);
  assert.ok(copyId !== undefined && copyId !== sharedId);
  assert.ok(!named(log, 'writeBuffer').some((c) => c[1] === sharedId), 'the shared bytes are not written');
  assert.ok(!named(log, 'destroy').some((c) => c[1] === sharedId));
  assert.equal(named(log, 'writeBuffer').filter((c) => c[1] === copyId).length, 1, 'the copy holds the new bytes');
  // Alone now, each mesh writes in place, and a new mesh with the old bytes does not join a buffer that left the pool.
  const own = b.gpu.vertex.buffer;
  b.setAttribute('uv', [0, 0, 1, 0, 1, 1, 0, 1], [0, 2]);
  assert.deepEqual(vertexIds(h.gpu.record(() => h.frame())), []);
  assert.equal(b.gpu.vertex.buffer, own);
  a.setAttribute('uv', [0, 1, 1, 0, 1, 1, 0, 1], [0, 1]);
  const last = h.gpu.record(() => h.frame());
  assert.equal(a.gpu.vertex.buffer, shared, 'the last holder takes the buffer over');
  assert.equal(named(last, 'writeBuffer').filter((c) => c[1] === sharedId).length, 1);
  const c = raw.add(new RawMesh({ material: m, attributes: quad() }));
  h.frame();
  assert.notEqual(c.gpu.vertex.buffer, shared);
});

test('a shared buffer lives until its last mesh lets go', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material();
  let a, b;
  const setup = h.gpu.record(() => {
      a = raw.add(new RawMesh({ material: m, attributes: quad() }));
      b = raw.add(new RawMesh({ material: m, attributes: quad() }));
      h.frame();
    }),
    id = named(setup, 'buffer').find((c) => c[2].label === 'shader:raw:vertex')[1],
    shared = a.gpu.vertex.buffer;
  assert.ok(
    !named(
      h.gpu.record(() => a.dispose()),
      'destroy',
    ).some((c) => c[1] === id),
  );
  assert.ok(
    named(
      h.gpu.record(() => b.dispose()),
      'destroy',
    ).some((c) => c[1] === id),
  );
  const c = raw.add(new RawMesh({ material: m, attributes: quad() }));
  h.frame();
  assert.notEqual(c.gpu.vertex.buffer, shared, 'a freed buffer is not handed out again');
});

test('a device swap leaves the old pool and shares again on the new device', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material(),
    a = raw.add(new RawMesh({ material: m, attributes: quad() })),
    b = raw.add(new RawMesh({ material: m, attributes: quad() }));
  h.frame();
  const old = a.gpu.vertex.buffer;
  h.swap();
  h.frame();
  assert.notEqual(a.gpu.vertex.buffer, old);
  assert.equal(a.gpu.vertex.buffer, b.gpu.vertex.buffer);
});

test('uniform arrays and structs follow the WGSL layout, and their values land at those offsets', () => {
  const m = new RawShaderMaterial({
    vertexShader: shader,
    uniforms: {
      gain: { value: 1 },
      colors: { type: 'vec3f', count: 2, value: ['#ff0000', [0, 1, 0]] },
      light: {
        struct: { color: 'vec3f', power: 'f32', spin: 'mat3x3f' },
        value: { color: [1, 2, 3], power: 4, spin: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      },
      tail: { value: 5 },
      rows: { count: 2, struct: { a: 'f32' }, value: [{ a: 6 }, { a: 7 }] },
      flat: { type: 'vec4f', count: 2, value: [1, 2, 3, 4, 5, 6, 7, 8] },
    },
  });
  assert.deepEqual(
    m.members.map((x) => [x.name, x.type, x.offset]),
    [
      ['gain', 'f32', 0],
      ['colors', 'vec3f', 16],
      ['light', 'Raw_light', 48],
      ['tail', 'f32', 112],
      ['rows', 'Raw_rows', 128],
      ['flat', 'vec4f', 160],
    ],
  );
  assert.equal(m.size, 192);
  const code = m.code('vertex');
  for (const line of [
    'struct Raw_light {\n  @align(16) color:vec3f,\n  power:f32,\n  spin:mat3x3f,\n}',
    '  colors:array<vec3f,2>,',
    '  light:Raw_light,',
    '  rows:array<Raw_rows,2>,',
    '  flat:array<vec4f,2>,',
  ])
    assert.ok(code.includes(line), line);
  const h = harness(),
    raw = RawShaders.attach(h.engine);
  raw.add(new RawMesh({ material: m, attributes: quad() }));
  const log = h.gpu.record(() => h.frame()),
    id = named(log, 'buffer').find((c) => c[2].label === 'shader:raw:uniforms')[1],
    f = floats(named(log, 'writeBuffer').find((c) => c[1] === id)[3]);
  assert.deepEqual(f.slice(4, 7), [1, 0, 0], 'a colour string is an element');
  assert.deepEqual(f.slice(8, 11), [0, 1, 0], 'the next element is 16 bytes on');
  assert.deepEqual(f.slice(12, 16), [1, 2, 3, 4], 'a scalar field packs against a vec3f');
  assert.deepEqual(f.slice(16, 28), [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0], 'a mat3x3f keeps its padded columns');
  assert.equal(f[28], 5);
  assert.deepEqual([f[32], f[36]], [6, 7], 'a struct of one f32 is 16 bytes apart in an array');
  assert.deepEqual(f.slice(40, 48), [1, 2, 3, 4, 5, 6, 7, 8], 'numbers in a row fill the elements in order');
});

test('uniform arrays and structs refuse what WGSL cannot lay out, and name the fix', () => {
  const make = (uniforms) => () => new RawShaderMaterial({ vertexShader: shader, uniforms });
  assert.throws(make({ a: { type: 'f32', count: 4, value: [1, 2, 3, 4] } }), /16 bytes apart.*storage buffer/);
  assert.throws(make({ a: { type: 'vec2f', count: 2, value: [1, 2, 3, 4] } }), /16 bytes apart/);
  assert.throws(make({ a: { count: 2, value: [1, 2] } }), /is an array, so it needs type/);
  assert.throws(make({ a: { type: 'vec4f', count: 0, value: [] } }), /positive integer/);
  assert.throws(make({ a: { struct: {}, value: {} } }), /at least one field/);
  assert.throws(make({ a: { struct: { b: 'vec9f' }, value: { b: 1 } } }), /field b needs a type/);
  assert.throws(make({ a: { struct: { camera: 'f32' }, value: { camera: 1 } } }), /usable WGSL identifier/);
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = new RawShaderMaterial({
      vertexShader: shader,
      uniforms: {
        list: { type: 'vec4f', count: 2, value: [1, 2, 3, 4] },
        s: { struct: { a: 'vec2f' }, value: { a: [1, 2] } },
      },
    });
  raw.add(new RawMesh({ material: m, attributes: quad() }));
  assert.throws(() => h.frame(), /uniform list needs 2 elements/);
  m.uniforms.list.value = [
    [1, 2, 3, 4],
    [1, 2, 3],
  ];
  assert.throws(() => h.frame(), /uniform list\[1\] needs 4 finite numbers/);
  m.uniforms.list.value = [1, 2, 3, 4, 5, 6, 7, 8];
  m.uniforms.s.value = { a: 1 };
  assert.throws(() => h.frame(), /uniform s\.a needs 2 finite numbers/);
});

test('storage buffers are declared after the textures and bound live; read_write stays out of the vertex stage', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    node = {
      type: 'vec4f',
      calls: 0,
      buffer(device) {
        this.calls++;
        return (this.made ??= device.createBuffer({ size: 64, usage: 128 }));
      },
    },
    buffers = [],
    ids = named(
      h.gpu.record(() => buffers.push(...[0, 1].map(() => h.gpu.device.createBuffer({ size: 64, usage: 128 })))),
      'buffer',
    ).map((c) => c[1]),
    [other, next] = buffers,
    m = new RawShaderMaterial({
      vertexShader: shader,
      uniforms: { gain: { value: 1 } },
      textures: { map: null },
      storage: { field: node, items: { buffer: other, type: 'Item', access: 'read_write' } },
    });
  const code = m.code('vertex');
  assert.ok(code.includes('@group(1) @binding(3) var<storage,read> field:array<vec4f>;'));
  assert.ok(code.includes('@group(1) @binding(4) var<storage,read_write> items:array<Item>;'));
  raw.add(new RawMesh({ material: m, attributes: quad() }));
  const log = h.gpu.record(() => h.frame()),
    layout = named(log, 'layout').find((c) => c[2].label === 'shader:raw:' + m.name)[2].entries,
    group = () => named(log, 'group').at(-1)[2].entries;
  assert.deepEqual(layout[3].buffer, { type: 'read-only-storage' });
  assert.equal(layout[3].visibility, 3, 'a read buffer reaches both stages');
  assert.deepEqual(layout[4].buffer, { type: 'storage' });
  assert.equal(layout[4].visibility, 2, 'a written buffer reaches the fragment stage only');
  const bound = group();
  assert.equal(bound[3].resource.buffer, named(log, 'buffer').find((c) => c[2].usage === 128)[1], 'made by the node');
  assert.equal(bound[4].resource.buffer, ids[0]);
  const quiet = h.gpu.record(() => h.frame());
  assert.equal(named(quiet, 'group').length, 0, 'an unchanged buffer keeps its group');
  m.storage.items.buffer = next;
  const moved = h.gpu.record(() => h.frame());
  assert.equal(named(moved, 'group').at(-1)[2].entries[4].resource.buffer, ids[1], 'buffer is live');
  assert.throws(
    () => new RawShaderMaterial({ vertexShader: shader, storage: { a: {} } }),
    /must be \{buffer, type, access\?\}/,
  );
  assert.throws(
    () =>
      new RawShaderMaterial({ vertexShader: shader, storage: { a: { buffer: other, type: 'u32', access: 'write' } } }),
    /access must be read or read_write/,
  );
});

test('extra bind groups sit at 2 and up, over an empty group 1 when the material binds nothing', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    made = [],
    extra = (device) => {
      const layout = device.createBindGroupLayout({ entries: [] }),
        value = { layout, group: device.createBindGroup({ layout, entries: [] }) };
      made.push(value);
      return value;
    },
    m = new RawShaderMaterial({ vertexShader: shader, groups: [extra, extra] });
  raw.add(new RawMesh({ material: m, attributes: quad() }));
  raw.add(new RawMesh({ material: m, attributes: quad() }));
  h.frame();
  const log = h.gpu.record(() => h.frame()),
    binds = named(log, 'pass.setBindGroup');
  assert.equal(made.length, 2, 'one call each per device');
  assert.deepEqual(
    binds.filter((c) => c[1] !== 0).map((c) => c[1]),
    [1, 2, 3],
    'bound once for a run of the material',
  );
  h.swap();
  h.frame();
  assert.equal(made.length, 4, 'a restored device gets new groups');
  assert.throws(() => new RawShaderMaterial({ vertexShader: shader, groups: [extra, extra, extra] }), /at most two/);
  assert.throws(() => new RawShaderMaterial({ vertexShader: shader, groups: [{}] }), /functions of the device/);
});

test('a mesh out of view is skipped and counted; its sphere follows position, the matrix and bounds', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    m = material(),
    single = { position: { data: [-1, -1, 0, 1, -1, 0, 1, 1, 0], type: 'vec3f' } },
    code = `@vertex fn vertex(a:Attributes)->@builtin(position) vec4f {return vec4f(a.position,1);}
@fragment fn fragment()->@location(0) vec4f {return vec4f(1);}`,
    plain = new RawShaderMaterial({ vertexShader: code }),
    mesh = raw.add(new RawMesh({ material: plain, attributes: single }));
  // Clip space is world space: x and y within 1, z from 0 to 1.
  h.matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const seen = () => {
    h.frame();
    return [raw.stats.meshes, raw.stats.culled];
  };
  assert.deepEqual(seen(), [1, 0]);
  mesh.matrix[12] = 3;
  assert.deepEqual(seen(), [0, 1], 'past the right plane by more than its radius');
  mesh.matrix[12] = 2;
  assert.deepEqual(seen(), [1, 0], 'its sphere still touches the view');
  mesh.matrix[12] = 5;
  mesh.matrix[0] = 8;
  assert.deepEqual(seen(), [1, 0], "the world matrix's scale reaches the radius");
  mesh.matrix[0] = 1;
  assert.deepEqual(seen(), [0, 1]);
  mesh.setAttribute(
    'position',
    [4, -1, 0, 6, -1, 0, 6, 1, 0].map((v, i) => (i % 3 === 0 ? v - 10 : v)),
  );
  assert.deepEqual(seen(), [1, 0], 'new points make a new sphere');
  mesh.bounds = { center: [90, 0, 0], radius: 1 };
  assert.deepEqual(seen(), [0, 1], 'bounds replace it');
  mesh.frustumCulled = false;
  assert.deepEqual(seen(), [1, 0]);
  // An instanced mesh places its copies in the shader: no sphere of its points can hold them.
  raw.remove(mesh);
  const crowd = raw.add(
    new RawMesh({ material: m, attributes: quad(), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 50, 0, 0, 1] }),
  );
  assert.deepEqual(seen(), [1, 0]);
  crowd.bounds = { center: [0, 0, 0], radius: 1 };
  assert.deepEqual(seen(), [0, 1]);
});

test('reversed-Z with an infinite far plane culls by the other five planes', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    mesh = raw.add(new RawMesh({ material: material(), attributes: { position: quad().position }, vertexCount: 4 }));
  // x and y as w = -z; clip z = near, so z >= 0 has a zero-length normal and must not divide by it.
  h.matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0.1, 0];
  mesh.matrix[14] = -5;
  h.frame();
  assert.deepEqual([raw.stats.meshes, raw.stats.culled], [1, 0]);
  mesh.matrix[14] = 5;
  h.frame();
  assert.deepEqual([raw.stats.meshes, raw.stats.culled], [0, 1], 'behind the eye');
});

test('a shadow cascade draws the vertex stage with the light matrix, and the fragment only when it can discard', () => {
  const h = harness(),
    raw = RawShaders.attach(h.engine),
    plain = material(),
    cut = material({
      vertexShader: shader.replace('return margoDisplay', 'if(i.tint.x<0.5){discard;}return margoDisplay'),
    }),
    a = raw.add(new RawMesh({ material: plain, attributes: quad() })),
    b = raw.add(new RawMesh({ material: cut, attributes: quad() })),
    clear = raw.add(new RawMesh({ material: material({ transparent: true }), attributes: quad() })),
    matrix = Float32Array.from({ length: 16 }, (_, i) => i + 1);
  h.frame();
  const cascade = (mesh, index) => {
    const log = h.gpu.record(() => {
      h.view.begin(h.index++);
      const pass = h.gpu.encoder.beginRenderPass({ colorAttachments: [] });
      mesh.drawShadow({ context: h.view.c, pass, matrix, cascade: index });
      pass.end();
    });
    return log;
  };
  const first = cascade(a, 0),
    pipeline = named(first, 'renderPipeline')[0][2],
    camera = floats(
      named(first, 'writeBuffer').find((c) =>
        named(first, 'buffer').some((x) => x[1] === c[1] && x[2].label === 'shader:raw:camera'),
      )[3],
    );
  assert.equal(pipeline.fragment, undefined, 'a depth-only pipeline');
  assert.deepEqual(
    [pipeline.depthStencil.format, pipeline.depthStencil.depthCompare, pipeline.depthStencil.depthWriteEnabled],
    ['depth32float', 'less-equal', true],
  );
  assert.equal(pipeline.multisample.count, 1);
  assert.equal(pipeline.primitive.cullMode, 'none', 'a back-face cull would lose a caster seen from behind');
  assert.deepEqual(camera.slice(0, 16), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'the view is identity');
  assert.deepEqual(camera.slice(16, 32), [...matrix], 'so projection * view is the light');
  assert.deepEqual(camera.slice(32, 48), [...matrix]);
  assert.equal(named(first, 'pass.drawIndexed').length + named(first, 'pass.draw').length, 1);
  const cutting = named(cascade(b, 0), 'renderPipeline')[0][2];
  assert.equal(cutting.fragment.entryPoint, 'fragment');
  assert.deepEqual(cutting.fragment.targets, [], 'outputs go nowhere');
  const glass = cascade(clear, 0);
  assert.equal(named(glass, 'pass.draw').length + named(glass, 'pipeline').length, 0, 'transparent casts nothing');
  // The colour pass keeps working after a cascade rebound the mesh's camera.
  const colour = h.gpu.record(() => h.frame());
  assert.equal(named(colour, 'group').length, 0, 'each camera keeps its group');
  a.visible = false;
  const hidden = cascade(a, 1);
  assert.equal(named(hidden, 'pass.draw').length, 0);
  const version = a.shadowVersion;
  a.invalidateShadow();
  assert.equal(a.shadowVersion, version + 1);
  a.setAttribute('uv', [0, 0, 1, 0, 1, 1, 0, 1]);
  assert.equal(a.shadowVersion, version + 2, 'a changed attribute redraws a static map');
  a.dispose();
  assert.equal(a.disposed, true, 'Shadows drops a disposed source');
});

test('a static shadow map redraws when a caster pipeline arrives', async () => {
  const h = harness({ async: true }),
    raw = RawShaders.attach(h.engine),
    mesh = raw.add(new RawMesh({ material: material(), attributes: quad() })),
    version = mesh.shadowVersion;
  h.frame();
  await raw.ready();
  assert.ok(mesh.shadowVersion > version);
});

test('SSAO draws only opaque meshes with gbufferEntry, through that entry into two float targets', () => {
  const code = `${shader}
@fragment fn normals(i:Out)->MargoGBuffer {return margoGBuffer(vec3f(0,1,0),i.tint,vec3f(1));}`,
    h = harness(),
    raw = RawShaders.attach(h.engine),
    own = material({ vertexShader: code, gbufferEntry: 'normals' });
  raw.add(new RawMesh({ material: own, attributes: quad() }));
  raw.add(new RawMesh({ material: material(), attributes: quad() }));
  raw.add(
    new RawMesh({
      material: material({ vertexShader: code, gbufferEntry: 'normals', transparent: true }),
      attributes: quad(),
    }),
  );
  h.frame();
  const log = h.gpu.record(() => {
      h.view.begin(h.index++);
      const pass = h.gpu.encoder.beginRenderPass({ colorAttachments: [] });
      raw.draw(h.view.c, 'occlusion', null, null, 'all', { pass, view: new Float32Array(16), depthCompare: 'equal' });
      pass.end();
    }),
    pipeline = named(log, 'renderPipeline')[0][2];
  assert.equal(named(log, 'renderPipeline').length, 1);
  assert.equal(pipeline.fragment.entryPoint, 'normals');
  assert.deepEqual(pipeline.fragment.targets, [{ format: 'rgba16float' }, { format: 'rgba16float' }]);
  assert.equal(pipeline.depthStencil.depthCompare, 'equal');
  assert.equal(pipeline.depthStencil.depthWriteEnabled, false);
  assert.equal(pipeline.multisample.count, 4, 'the samples of the scene it tests against');
  assert.equal(named(log, 'pass.draw').length, 1);
  // Another mode, or no open pass, is not this source's to draw.
  const idle = h.gpu.record(() => raw.draw(h.view.c, 'gbuffer', null, null));
  assert.equal(idle.length, 0);
  assert.throws(() => material({ gbufferEntry: 'missing' }), /has no @fragment fn missing/);
  const first = new RawShaderMaterial({
    vertexShader: `@fragment fn normals()->MargoGBuffer {return margoGBuffer(vec3f(1),vec3f(0),vec3f(0));}\n${shader}`,
    gbufferEntry: 'normals',
  });
  assert.ok(first.code('fragment'), 'the colour entry is not the G-buffer entry, whichever comes first');
  const m = h.gpu.record(() => {
    raw.add(new RawMesh({ material: first, attributes: quad() }));
    h.frame();
  });
  assert.equal(named(m, 'renderPipeline').at(-1)[2].fragment.entryPoint, 'fragment');
});

test('RawPicking draws meshes into the tile with IDs from firstId and answers with a mesh', () => {
  const h = harness(),
    meshes = [],
    host = {
      overlays: [],
      addOverlay(o) {
        this.overlays.push(o);
        return () => this.overlays.splice(this.overlays.indexOf(o), 1);
      },
    };
  h.engine.createMesh = () => {
    const mesh = {
      dispose() {
        this.disposed = true;
      },
    };
    meshes.push(mesh);
    return mesh;
  };
  const raw = RawShaders.attach(h.engine),
    a = raw.add(new RawMesh({ material: material(), attributes: quad() })),
    picking = RawPicking.attach(host, raw),
    b = raw.add(new RawMesh({ material: material(), attributes: quad() })),
    core = {};
  assert.equal(meshes.length, 2, 'a stand-in for each mesh, made before any pick');
  h.frame();
  const pipelines = h.gpu.record(() => h.frame());
  assert.equal(named(pipelines, 'renderPipeline').length, 0, 'the pick pipeline compiled with the colour one');
  const pick = (mesh) =>
    h.gpu.record(() =>
      host.overlays[0].drawPick({
        encoder: h.gpu.encoder,
        color: {},
        depth: {},
        matrix: new Float32Array(16),
        camera: h.view.camera,
        rect: [0, 0, 1280, 720],
        firstId: 1000,
        ...mesh,
      }),
    );
  const log = pick();
  const ids = named(log, 'writeBuffer').filter((c) => c[2] === 112);
  assert.deepEqual(
    ids.map((c) => new Uint32Array(Uint8Array.from(Buffer.from(c[3], 'hex')).buffer)[0]),
    [1000, 1001],
  );
  assert.equal(named(log, 'pass.draw').length, 2);
  assert.equal(host.overlays[0].pickHit(1).mesh, meshes[1]);
  assert.equal(picking.rawOf(host.overlays[0].pickHit(1).mesh), b);
  assert.equal(host.overlays[0].pickHit(2), null);
  assert.equal(picking.rawOf(null), null);
  assert.equal(picking.rawOf({}), null);
  a.mesh = core;
  assert.equal(host.overlays[0].pickHit(0).mesh, core, 'a followed core mesh answers for it');
  assert.equal(picking.rawOf(core), a);
  a.mesh = null;
  b.visible = false;
  pick();
  assert.equal(host.overlays[0].pickHit(1), null, 'a hidden mesh takes no ID');
  const object = named(
    h.gpu.record(() => raw.remove(b)),
    'pass.draw',
  );
  assert.equal(object.length, 0);
  assert.equal(meshes[1].disposed, true, 'its stand-in goes with it');
  picking.dispose();
  assert.equal(host.overlays.length, 0);
  assert.equal(meshes[0].disposed, true);
  assert.equal(raw.watchers.size, 0);
  const other = new RawShaders({ name: 'shader:raw:unattached' });
  assert.throws(() => RawPicking.attach(host, other), /Attach RawShaders/);
});

test('a pick after a device swap makes a new camera block, and a broken material takes no ID', () => {
  const h = harness(),
    host = { addOverlay: (o) => ((host.overlay = o), () => {}) };
  h.engine.createMesh = () => ({ dispose() {} });
  const raw = RawShaders.attach(h.engine);
  RawPicking.attach(host, raw);
  const m = material(),
    mesh = raw.add(new RawMesh({ material: m, attributes: quad() }));
  h.frame();
  const pick = () =>
    host.overlay.drawPick({
      encoder: h.gpu.encoder,
      color: {},
      depth: {},
      matrix: new Float32Array(16),
      camera: h.view.camera,
      rect: [0, 0, 8, 8],
      firstId: 0,
    });
  pick();
  h.swap();
  const log = h.gpu.record(pick);
  assert.equal(named(log, 'buffer').filter((c) => c[2].label === 'shader:raw:camera').length, 1);
  assert.equal(host.overlay.pickHit(0).mesh !== undefined, true);
  m.error = new Error('did not compile');
  pick();
  assert.equal(host.overlay.pickHit(0), null);
  assert.ok(mesh);
});

test('TAA velocity draws only opaque meshes with velocityEntry, with last frame kept per TAA view', () => {
  const code = `${shader}
@vertex fn moved(a:Attributes)->MargoVelocity {return margoVelocity(a.position+vec3f(uniforms.gain,0,0),a.position);}`,
    h = harness(),
    raw = RawShaders.attach(h.engine),
    own = material({ vertexShader: code, velocityEntry: 'moved' });
  const mesh = raw.add(new RawMesh({ material: own, attributes: quad() }));
  raw.add(new RawMesh({ material: material(), attributes: quad() }));
  raw.add(
    new RawMesh({
      material: material({ vertexShader: code, velocityEntry: 'moved', transparent: true }),
      attributes: quad(),
    }),
  );
  assert.match(
    own.code('vertex'),
    /var<uniform> margoBefore:MargoBefore;/,
    'every stage declares what the entry reads',
  );
  assert.doesNotMatch(material().code('vertex'), /margoBefore/, 'a material without it is unchanged');
  const key = {},
    rows = new Float32Array(36);
  rows.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
  rows.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 1], 16);
  rows.set([64, 64, 1, 0], 32);
  const velocity = () =>
    h.gpu.record(() => {
      h.frame();
      const pass = h.gpu.encoder.beginRenderPass({ colorAttachments: [] });
      raw.drawVelocity(pass, { context: h.view.c, camera: rows, key });
      pass.end();
    });
  const first = velocity(),
    pipeline = named(first, 'renderPipeline').find((p) => p[2].fragment?.entryPoint === 'margoVelocityFragment')[2];
  assert.equal(pipeline.vertex.entryPoint, 'moved');
  assert.deepEqual(pipeline.fragment.targets, [{ format: 'rg16float' }, { format: 'r32float' }]);
  assert.equal(pipeline.depthStencil.depthCompare, 'equal');
  assert.equal(pipeline.depthStencil.depthWriteEnabled, false);
  assert.equal(pipeline.primitive.cullMode, 'none');
  const module = named(first, 'module').find((m) => /margoVelocityFragment/.test(m[2].code));
  assert.match(module[2].code, /@vertex fn moved/);
  const befores = (log) =>
    named(log, 'writeBuffer')
      .filter((c) => c[3].length === 144 * 2)
      .map((c) => floats(c[3]));
  assert.equal(befores(first).length, 1, 'one opted-in opaque mesh');
  assert.equal(befores(first)[0][33], 0, 'no last frame yet: no motion');
  assert.deepEqual(befores(first)[0].slice(0, 16), [...rows.slice(16, 32)], "TAA's previous view-projection");
  mesh.matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1];
  const second = befores(velocity())[0];
  assert.equal(second[33], 1, 'drawn last frame and TAA has history');
  assert.equal(second[28], 0, "last frame's world, not this frame's");
  assert.ok(second[32] > 0, "last frame's time");
  const third = velocity();
  assert.equal(befores(third)[0][28], 2, 'then the moved one');
  assert.equal(
    named(third, 'pass.draw').length + named(third, 'pass.drawIndexed').length,
    3 + 1,
    'the scene passes draw three, TAA one',
  );
  // Releasing the view's state frees its buffers; idle without an open TAA pass.
  const freed = h.gpu.record(() => raw.releaseVelocity(key));
  assert.equal(named(freed, 'destroy').length, 2, 'the camera block and the one mesh block');
  assert.throws(() => material({ velocityEntry: 'missing' }), /has no @vertex fn missing/);
});
