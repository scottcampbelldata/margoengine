import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { FrameGraph } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { RawShaderMaterial, RawMesh, RawShaders } from '../dist/raw.js';

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
