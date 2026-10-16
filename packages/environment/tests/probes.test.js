// CPU checks (mock GPU) for @margoengine/environment/probes: validation, buffer layout, the ambient patch on core's shader
// variants and gltf-pro's hooks, the bake's capture shader and GPU work, and the CPU irradiance mirror. The GPU itself is
// checked by examples/package-benchmarks/probes-gpu.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf-pro/dist/index.js';
import { EnvironmentLighting, Fog, floatToHalf } from '../dist/index.js';
import { LightProbes, MAX_REFLECTION_PROBES, PROBE_BINDING } from '../dist/probes.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').split('`')[1];
const coreShader = source('../../core/src/shaders.ts');
const clusteredShader = coreShader.replace(
  /let linear=([^;]+);/,
  'let linear=$1+clusterLighting(i.clip.xy,i.position,n,frame.eye.xyz,i.color,i.material.x,i.material.y);',
);
const fragment = (shader) => shader.slice(shader.lastIndexOf('@fragment fn fragment'));
const room = { min: [-2, 0, -2], max: [2, 3, 2] };
function device(gpu) {
  const d = gpu.device,
    encoder = gpu.encoder;
  encoder.finish ??= () => ({});
  return Object.assign(d, {
    createCommandEncoder: () => encoder,
    pushErrorScope() {},
    popErrorScope: async () => null,
    queue: Object.assign(d.queue, { onSubmittedWorkDone: async () => undefined }),
  });
}
const fakeEngine = (gpu) => ({
  backend: 'webgpu',
  gpu: device(gpu),
  errors: [],
  removed: [],
  lighting: { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.3]) },
  onError(error) {
    this.errors.push(error);
  },
  removePlugin(name) {
    this.removed.push(name);
  },
});
function fakeEnvironment(device) {
  return {
    device,
    disposed: false,
    version: 0,
    specularView: { id: 'specular' },
    sampler: {},
    brdfLut: {},
    shBuffer: {},
    paramsBuffer: {},
    restore: () => Promise.resolve(),
  };
}

test('LightProbes validates its layout and sizes one storage buffer for it', () => {
  assert.throws(() => new LightProbes({}), /volume or reflection probes/);
  for (const volume of [
    { ...room, counts: [0, 1, 1] },
    { ...room, counts: [65, 1, 1] },
    { ...room, counts: [64, 64, 2] },
    { ...room, counts: [2, 2, 2], sh: 3 },
    { min: [0, 0, 0], max: [0, 1, 1], counts: [1, 1, 1] },
    { ...room, counts: [1, 1, 1], blend: -1 },
  ])
    assert.throws(() => new LightProbes({ volume }), RangeError, JSON.stringify(volume));
  assert.throws(() => new LightProbes({ volume: { ...room, counts: [1, 1, 1], resolution: 12 } }), /power of two/);
  assert.throws(() => new LightProbes({ reflections: [{ position: [5, 1, 0], ...room }] }), /position inside/);
  assert.throws(
    () =>
      new LightProbes({
        reflections: Array.from({ length: MAX_REFLECTION_PROBES + 1 }, () => ({ position: [0, 1, 0], ...room })),
      }),
    /at most 16/,
  );
  assert.throws(
    () => new LightProbes({ reflections: [{ position: [0, 1, 0], ...room }], resolution: 100 }),
    /power of two/,
  );
  assert.throws(
    () => new LightProbes({ reflections: [{ position: [0, 1, 0], ...room }], near: 1, far: 1 }),
    /near\/far/,
  );
  assert.throws(() => new LightProbes({ volume: { ...room, counts: [1, 1, 1] }, environment: {} }), /Environment/);
  // 2 x 2 x 2 L2 probes (64 B = 8 texel units each) + two 16-px reflection probes (16^2 + 8^2 + 4^2 = 336 texels each), after a 1,088-byte header.
  const probes = new LightProbes({
    volume: { ...room, counts: [2, 2, 2] },
    reflections: [
      { position: [0, 1, 0], ...room },
      { position: [1, 1, 1], ...room, blend: 0.5 },
    ],
    resolution: 16,
  });
  assert.equal(probes.byteLength, 1088 + (64 + 2 * 336) * 8);
  assert.deepEqual([probes.reflectionOffset(0), probes.reflectionOffset(1)], [64, 400]);
  assert.equal(probes.reflections[0].blend, 0.1 * 3, 'default blend: 10% of the smallest side');
  assert.equal(probes.baked, false);
  assert.equal(probes.irradianceAt([0, 1, 0], [0, 1, 0]), null);
  assert.equal(
    new LightProbes({ volume: { ...room, counts: [3, 1, 1], sh: 1 } }).byteLength,
    1088 + 3 * 32,
    'L1: 12 float16 values in 2 vec4u per probe',
  );
});

test('LightProbes replaces the ambient term on every core shader variant, with or without an environment fallback', () => {
  const gpu = mockGPU(),
    engine = fakeEngine(gpu),
    probes = new LightProbes({ volume: { ...room, counts: [2, 2, 2] } });
  assert.equal(probes.shader(coreShader, 0), coreShader, 'unpatched before setup');
  probes.setup(engine);
  const run = passes(probes),
    frame = context(gpu, { shader: clusteredShader, format: 'bgra8unorm' });
  frame.begin(0);
  run(frame.c);
  const patched = frame.c.shader;
  assert.match(
    patched,
    new RegExp(`@group\\(0\\) @binding\\(${PROBE_BINDING}\\) var<storage,read> probeData:ProbeData;`),
  );
  // Named margoAmbient (SSAO occludes it); without an environment the fallback is core's own ambient term, so unbaked probes change nothing.
  assert.match(
    fragment(patched),
    /let margoAmbient=probeShade\(i\.position,n,v,i\.color,i\.material\.y,i\.material\.x,i\.color\*\(1\.0-i\.material\.y\)\*frame\.radiance\.w\);let linear=direct\*frame\.radiance\.xyz\*frame\.light\.w\+i\.color\*\(1\.0-i\.material\.y\)\*0\.0\+clusterLighting\([^;]+\)\+margoAmbient;/,
  );
  assert.doesNotMatch(patched, /iblSpecular/, 'no texture bindings without an environment');
  assert.deepEqual(
    frame.c.bindings.map((e) => e.binding),
    [PROBE_BINDING],
  );
  const terrain =
    'let base=terrainColor(i.position,n);\n' +
    coreShader.replace('+i.color*(1.0-i.material.y)*frame.radiance.w', '+base*frame.radiance.w');
  assert.match(
    probes.shader(terrain, 0),
    /probeShade\(i\.position,n,v,base,i\.material\.y,i\.material\.x,base\*\(1\.0-i\.material\.y\)\*frame\.radiance\.w\)/,
  );
  assert.throws(() => probes.shader('@fragment fn custom() {}', 0), /standard core PBR shader/);
  // Never together with EnvironmentLighting (both own margoAmbient): the environment goes to LightProbes instead.
  const lighting = new EnvironmentLighting(fakeEnvironment(engine.gpu));
  lighting.setup(engine);
  assert.throws(() => probes.shader(lighting.shader(coreShader, 0), 0), /replaces EnvironmentLighting/);
  // With an environment: its five IBL bindings plus the probe buffer; fallback and split-sum from the environment.
  const env = fakeEnvironment(engine.gpu),
    withEnv = new LightProbes({ environment: env, reflections: [{ position: [0, 1, 0], ...room }] });
  withEnv.setup(engine);
  const code = withEnv.shader(coreShader, 0);
  assert.match(code, /@group\(0\) @binding\(20\) var iblSpecular:texture_cube<f32>;/);
  assert.match(code, /let ab=iblBrdfTerms\(nv,rough\);/);
  assert.match(
    fragment(code),
    /let margoAmbient=probeShade\(i\.position,n,v,i\.color,i\.material\.y,i\.material\.x,vec3f\(0\)\);/,
  );
  assert.deepEqual(
    withEnv.bindings().map((e) => e.binding),
    [20, 21, 22, 23, 24, PROBE_BINDING],
  );
  assert.equal(withEnv.bindings()[0].resource, env.specularView);
  env.device = null;
  assert.deepEqual(withEnv.bindings(), [], 'environment restoring: nothing patched');
  // Fog still composes (it patches the output, probes the ambient).
  const fog = new Fog();
  fog.setup(engine);
  assert.match(fog.shader(patched, 0), /fogAmount/);
  probes.dispose();
  withEnv.dispose();
  lighting.dispose();
  fog.dispose();
  assert.ok(engine.removed.includes('light-probes'));
});

test('moving a reflection probe validates and copies its point, updates the GPU box origin, and preserves its influence', () => {
  const volume = { min: [-2, 0, -2], max: [2, 3, 2], counts: [1, 1, 1] },
    reflection = { position: [0, 1, 0], min: [-2, 0, -2], max: [2, 3, 2] },
    probes = new LightProbes({ volume, reflections: [reflection] }),
    gpu = mockGPU(),
    engine = fakeEngine(gpu);
  volume.min[0] = volume.max[0] = reflection.min[0] = reflection.max[0] = 99;
  volume.counts[0] = 64;
  reflection.position[0] = 99;
  assert.deepEqual(probes.volume.min, [-2, 0, -2]);
  assert.deepEqual(probes.volume.max, [2, 3, 2]);
  assert.deepEqual(probes.volume.counts, [1, 1, 1]);
  assert.deepEqual(probes.reflections[0].position, [0, 1, 0]);
  assert.deepEqual(probes.reflections[0].min, [-2, 0, -2]);
  assert.deepEqual(probes.reflections[0].max, [2, 3, 2]);
  for (const index of [-1, 1, 0.5, NaN, Infinity])
    assert.throws(() => probes.setReflectionPosition(index, [0, 1, 0]), /probe index/);
  for (const position of [[3, 1, 0], [0, -1, 0], [0, 1, Infinity], [NaN, 1, 0], [0, 1], null])
    assert.throws(() => probes.setReflectionPosition(0, position), /finite and inside/);
  const position = [-2, 3, 2];
  probes.setReflectionPosition(0, position); // Faces of the influence box are valid, before engine setup too.
  position[0] = 99;
  assert.deepEqual(probes.reflections[0].position, [-2, 3, 2]);
  probes.setup(engine);
  const log = gpu.record(() => probes.setReflectionPosition(0, [1, 2, -1])),
    write = log.find((e) => e[0] === 'writeBuffer'),
    header = Buffer.from(write[3], 'hex');
  assert.deepEqual(
    [64, 68, 72].map((o) => header.readFloatLE(o)),
    [1, 2, -1],
  );
  assert.deepEqual(
    [80, 84, 88].map((o) => header.readFloatLE(o)),
    [-2, 0, -2],
  );
  assert.deepEqual(
    [96, 100, 104].map((o) => header.readFloatLE(o)),
    [2, 3, 2],
  );
  assert.equal(header.readUInt32LE(124), 0, 'moving an unbaked probe leaves it inactive');
  assert.equal(probes.baked, false);
  probes.dispose();
});

async function gltfModel(engine) {
  const store = await TransformStore.create(16),
    canvas = { width: 128, height: 96, clientWidth: 128, clientHeight: 96 };
  const core = new Engine(
    canvas,
    store,
    { backend: 'webgpu', gpu: engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const fixture = animatedTriangle();
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  const model = parseGLTF(core, fixture.doc, fixture.buffers);
  core.camera.update(4 / 3, true);
  store.tick(false);
  return { core, model };
}

test('LightProbes reach gltf-pro models through the ambient hook and the bake captures core meshes and added models', async () => {
  const gpu = mockGPU(),
    engine = fakeEngine(gpu),
    { core, model } = await gltfModel(engine);
  const probes = new LightProbes({
    volume: { ...room, counts: [2, 1, 1], resolution: 8 },
    reflections: [{ position: [0, 1, 0], ...room }],
    resolution: 16,
  });
  probes.setup(engine);
  probes.setReflectionPosition(0, [1, 2, -1]);
  const remove = probes.add(model);
  const frame = context(gpu, {
    shader:
      clusteredShader.replace(
        'let mapped=linear/(1.0+linear);',
        'let mapped=mix(linear/(1.0+linear),margoFog.color.rgb,fogAmount(i.position,frame.eye.xyz));',
      ) + '\nfn fogAmount(p:vec3f,eye:vec3f)->f32 {return 0.0;}',
    samples: 4,
  });
  frame.c.shader = frame.state.shader;
  const lit = gpu.record(() => {
    frame.begin(0);
    passes(probes)(frame.c);
    model.draw(frame.c, 'beauty', frame.c.color, frame.c.depth);
  });
  const modelCode = lit
    .filter((e) => e[0] === 'module')
    .map((e) => e[2].code)
    .find((code) => code.includes('fn surface('));
  assert.match(
    modelCode,
    /let margoAmbient=probeShade\(i\.position,s\.n,v,s\.base\.rgb,s\.metal,s\.roughness,\(s\.base\.rgb\*\(1\.0-s\.metal\)[^;]+\*f\.radiance\.w\)\*s\.occlusion;/,
  );
  assert.match(
    modelCode,
    /fn ambient\(s:Surface\)->vec3f \{return vec3f\(0\);\}/,
    'the hemisphere ambient is replaced, not added',
  );
  // Bake: the engine renders one ordinary frame, then the capture frame runs the passes with the probe flag set.
  const clustered = frame.state.shader.replace(
    'fn fogAmount',
    '\nfn clusterLighting(pixel:vec2f)->vec3f {if(depth<clusterFrame.depth.x||depth>clusterFrame.depth.y){return vec3f(0);}let count=clusterCounts[cell];for(var j=0u;j<count;j++){let light=clusterLights[clusterIndices[cell*1024u+j]];}}\nfn fogAmount',
  );
  let renders = 0,
    log = [];
  engine.render = () => {
    renders++;
    log.push(
      ...gpu.record(() => {
        frame.begin(renders);
        frame.c.shader = clustered;
        frame.c.draw = (options) => gpu.note('draw', options, frame.c.color, frame.c.depth);
        passes(probes)(frame.c);
      }),
    );
  };
  const read = Object.assign(gpu.device.createBuffer({ size: 0 }), {
    mapAsync: async () => undefined,
    getMappedRange: () => new ArrayBuffer((2 * 8 + 336) * 8),
    unmap() {},
  });
  const createBuffer = gpu.device.createBuffer;
  gpu.device.createBuffer = (d) => (d.usage & GPUBufferUsage.MAP_READ ? read : createBuffer(d));
  await probes.bake({ bounces: 2 });
  assert.equal(renders, 3, 'one ordinary frame and one capture frame per bounce');
  const modules = log.filter((e) => e[0] === 'module').map((e) => e[2].code),
    capture = modules.find((code) => code.includes('margoMainFrame'));
  assert.match(
    capture,
    /@group\(0\) @binding\(0\) var<uniform> margoMainFrame:Frame;\n@group\(0\) @binding\(27\) var<uniform> frame:Frame;/,
    'probe camera frame',
  );
  assert.match(
    capture,
    /if\(false\)\{let mapped=[^\n]*\}return vec4f\(linear,1\);/,
    'linear radiance out, tone map dead but bindings kept',
  );
  assert.match(capture, /0\.0\*fogAmount\(/, 'no fog in the capture');
  assert.match(capture, /let count=clusterFrame\.grid\.w;/);
  assert.match(capture, /let light=clusterLights\[j\];/);
  assert.doesNotMatch(capture, /depth>clusterFrame\.depth\.y/, "every clustered light, not the camera's clusters");
  assert.ok(
    modules.some((code) => code.includes('fn prefilter(') && code.includes('fn sh(')),
    'bake compute module',
  );
  const submits = log.filter((e) => e[0] === 'submit').length,
    probeCount = 2 + 1;
  assert.equal(submits, 2 * probeCount * 6, 'six face submits per probe per bounce');
  // Core meshes draw into each face with the capture pipeline and the frame bindings plus the probe camera (binding 27).
  const draws = log.filter((e) => e[0] === 'draw');
  assert.equal(draws.length, 2 * probeCount * 6);
  assert.ok(draws.every((d) => d[1].clear === false && d[1].bindings.some((b) => b.binding === 27)));
  // The model is drawn per face through the capture context (rgba16float, its own depth format) and gets the capture edits.
  const passCount = log.filter((e) => e[0] === 'beginComputePass').length;
  assert.equal(passCount, 2 * probeCount, 'one compute pass per probe');
  const dispatches = log.filter((e) => e[0] === 'pass.dispatchWorkgroups').map((e) => [e[1], e[2]]);
  assert.deepEqual(
    dispatches.slice(0, 4),
    [
      [1, 1],
      [1, 1],
      [2, 2],
      [1, 1],
    ],
    'SH per volume probe; reflection: resample 16 px, prefilter 8 and 4 px',
  );
  assert.equal(probes.baked, true);
  assert.equal(probes.texels.length, (16 + 336) * 2);
  const captures = log
    .filter((e) => e[0] === 'writeBuffer' && e[2] === 0 && e[3].length === 112 * 2)
    .map((e) => Buffer.from(e[3], 'hex'));
  assert.equal(captures.length, 2 * probeCount * 6);
  for (const values of [...captures.slice(12, 18), ...captures.slice(30, 36)])
    assert.deepEqual(
      [64, 68, 72].map((o) => values.readFloatLE(o)),
      [1, 2, -1],
      'all six faces use the moved point',
    );
  const bakedTexels = probes.texels,
    move = gpu.record(() => probes.setReflectionPosition(0, [-1, 1, 1])),
    movedHeader = Buffer.from(move.find((e) => e[0] === 'writeBuffer')[3], 'hex');
  assert.deepEqual(
    [64, 68, 72].map((o) => movedHeader.readFloatLE(o)),
    [-1, 1, 1],
  );
  assert.equal(movedHeader.readUInt32LE(124), 1, 'last baked reflection remains active between captures');
  assert.equal(probes.texels, bakedTexels, 'moving does not discard the previous radiance');
  assert.equal(probes.baked, true);
  remove();
  probes.dispose();
  core.dispose();
});

test('bounded GGX samples validate before rendering and do not leak into later default bakes', async () => {
  const gpu = mockGPU(),
    engine = fakeEngine(gpu),
    probes = new LightProbes({ reflections: [{ position: [0, 1, 0], ...room }], resolution: 16 });
  probes.setup(engine);
  let renders = 0,
    log = [];
  const frame = context(gpu, { shader: coreShader });
  engine.render = () => {
    renders++;
    log.push(
      ...gpu.record(() => {
        frame.begin(renders);
        frame.c.shader = coreShader;
        passes(probes)(frame.c);
      }),
    );
  };
  const createBuffer = gpu.device.createBuffer;
  gpu.device.createBuffer = (d) =>
    Object.assign(
      createBuffer(d),
      d.usage & GPUBufferUsage.MAP_READ
        ? {
            mapAsync: async () => undefined,
            getMappedRange: () => new ArrayBuffer(336 * 8),
            unmap() {},
          }
        : {},
    );
  for (const samples of [null, 0, 32, 65, 64.5, 8192, NaN, Infinity])
    await assert.rejects(probes.bake({ samples }), /bake samples must be a power of two/);
  await assert.rejects(probes.bake({ samples: 256, bounces: 0 }), /bounces/);
  assert.equal(renders, 0, 'invalid options are atomic');
  assert.equal(probes.baked, false);
  assert.equal(probes.texels, undefined);
  const pending = probes.bake({ samples: 256, bounces: 2 });
  await assert.rejects(probes.bake({ samples: 64 }), /bake pending/);
  await pending;
  const sampledCode = log.find((e) => e[0] === 'module' && e[2].code.includes('fn prefilter('))[2].code;
  assert.match(sampledCode, /importanceGGX\(hammersley\(i,bake.count\),alpha\)/);
  assert.doesNotMatch(sampledCode, /for\(var j=0u;j<m\*m;j\+\+\)/);
  const uniforms = log
    .filter((e) => e[0] === 'writeBuffer' && e[3].length === 3 * 256 * 2)
    .map((e) => Buffer.from(e[3], 'hex'));
  assert.equal(uniforms.length, 2);
  for (const uniform of uniforms)
    assert.deepEqual(
      [0, 1, 2].map((slot) => uniform.readUInt32LE(slot * 256 + 20)),
      [0, 256, 256],
    );
  assert.equal(
    log.filter((e) => e[0] === 'group' && e[2].entries.some((x) => x.binding === 2)).length,
    3,
    'resample and both rough dispatches reuse their face bind groups across bounces',
  );
  assert.equal(
    log.filter((e) => e[0] === 'pass.setBindGroup').length,
    6,
    'all three dispatches still bind their captured faces on both bounces',
  );
  assert.equal(probes.texels.length, 336 * 2, 'sampled radiance is snapshotted for device restore');
  const first = probes.texels;
  log = [];
  await probes.bake();
  const exactCode = log.find((e) => e[0] === 'module' && e[2].code.includes('fn prefilter('))[2].code;
  assert.match(exactCode, /for\(var j=0u;j<m\*m;j\+\+\)/);
  assert.doesNotMatch(exactCode, /fn importanceGGX/);
  assert.notEqual(probes.texels, first);
  probes.dispose();
});

test('probe bake pipelines are reused per device and filter mode, including changed sample counts', async () => {
  const engine = fakeEngine(mockGPU()),
    probes = new LightProbes({ reflections: [{ position: [0, 1, 0], ...room }], resolution: 16 });
  let log = [],
    shader = coreShader;
  const configure = (gpu) => {
    engine.gpu = device(gpu);
    const frame = context(gpu, { shader: coreShader }),
      createBuffer = gpu.device.createBuffer;
    gpu.device.createBuffer = (d) =>
      Object.assign(
        createBuffer(d),
        d.usage & GPUBufferUsage.MAP_READ
          ? {
              mapAsync: async () => undefined,
              getMappedRange: () => new ArrayBuffer(336 * 8),
              unmap() {},
            }
          : {},
      );
    engine.render = () =>
      log.push(
        ...gpu.record(() => {
          frame.begin(0);
          frame.c.shader = shader;
          passes(probes)(frame.c);
        }),
      );
  };
  configure(mockGPU());
  probes.setup(engine);
  const check = async (options, expected) => {
    log = [];
    await probes.bake(options);
    assert.equal(log.filter((e) => e[0] === 'computePipeline').length, expected);
    assert.equal(log.filter((e) => e[0] === 'module' && e[2].code.includes('fn prefilter(')).length, expected ? 1 : 0);
  };
  await check({}, 3);
  await check({}, 0);
  await check({ samples: 256 }, 3);
  await check({ samples: 64 }, 0);
  await check({ samples: 4096 }, 0);
  await check({}, 0);
  assert.equal(log.filter((e) => e[0] === 'module' && e[2].code.includes('margoMainFrame')).length, 0);
  shader += '\n// changed capture shader';
  await check({}, 0);
  assert.equal(log.filter((e) => e[0] === 'module' && e[2].code.includes('margoMainFrame')).length, 1);
  await check({}, 0);
  assert.equal(log.filter((e) => e[0] === 'module' && e[2].code.includes('margoMainFrame')).length, 0);
  shader = 'invalid shader';
  await assert.rejects(probes.bake(), /standard core .*shader/);
  shader = coreShader;
  const snapshot = probes.texels,
    captureResources = probes.captureResources;
  configure(mockGPU());
  probes.onDeviceRestored(engine);
  assert.ok(
    captureResources.owned.every((resource) => resource.destroyed),
    'device restoration releases the old capture pool',
  );
  assert.equal(probes.captureResources, undefined);
  assert.equal(probes.texels, snapshot, 'restoration retains captured radiance');
  await check({}, 3);
  await check({ samples: 256 }, 3);
  await check({ samples: 128 }, 0);
  probes.dispose();
  await assert.rejects(probes.bake(), /not attached/);
});

function pooledProbes(options = {}) {
  const gpu = mockGPU(),
    engine = fakeEngine(gpu),
    probes = new LightProbes({
      volume: { ...room, counts: [2, 1, 1], resolution: 8 },
      reflections: [{ position: [0, 1, 0], ...room }],
      resolution: 16,
      ...options,
    }),
    frame = context(gpu, { shader: coreShader }),
    run = passes(probes),
    created = [];
  for (const name of ['createBuffer', 'createTexture']) {
    const create = gpu.device[name];
    gpu.device[name] = (descriptor) => {
      const value = create(descriptor);
      created.push(value);
      if (name === 'createBuffer' && descriptor.usage & GPUBufferUsage.MAP_READ)
        Object.assign(value, {
          mapAsync: async () => undefined,
          getMappedRange: () => new ArrayBuffer(probes.byteLength - 1088),
          unmap() {},
        });
      return value;
    };
  }
  let log = [],
    frames = 0;
  engine.render = () =>
    log.push(
      ...gpu.record(() => {
        frame.begin(frames++);
        run(frame.c);
      }),
    );
  probes.setup(engine);
  return {
    gpu,
    engine,
    probes,
    frame,
    created,
    takeLog() {
      const previous = log;
      log = [];
      return previous;
    },
  };
}

test('probe capture reuses owned native resources, uniform slots, cameras and model context across repeated moving bakes', async () => {
  const h = pooledProbes(),
    { probes } = h;
  await probes.bake({ samples: 64 });
  const resources = probes.captureResources,
    owned = [...resources.owned],
    cameras = [...resources.cameras],
    values = resources.values,
    slots = resources.slots,
    context = resources.view;
  h.takeLog();
  for (let index = 0; index < 10; index++) {
    probes.setReflectionPosition(0, [index * 0.1, 1, -0.2]);
    const previous = probes.texels;
    await probes.bake({ samples: index % 2 ? 256 : 64, bounces: 2 });
    assert.notStrictEqual(probes.texels, previous, 'public snapshots retain their fresh-result lifetime');
  }
  const log = h.takeLog();
  for (const name of ['buffer', 'texture', 'view', 'sampler', 'group', 'renderPipeline', 'computePipeline'])
    assert.equal(
      log.filter((entry) => entry[0] === name).length,
      0,
      name + ' must not be recreated for unchanged layouts',
    );
  assert.equal(log.filter((entry) => entry[0] === 'pass.dispatchWorkgroups').length, 10 * 2 * 5);
  assert.strictEqual(probes.captureResources, resources);
  assert.strictEqual(resources.values, values);
  assert.strictEqual(resources.slots, slots);
  assert.strictEqual(resources.view, context);
  assert.deepEqual(resources.cameras, cameras);
  assert.ok(owned.every((resource) => !resource.destroyed));
  probes.dispose();
  assert.ok(
    owned.every((resource) => resource.destroyed),
    'dispose owns all retained native capture resources',
  );
});

test('pooled probe groups invalidate on actual environment resources and filter mode, while capture shader changes keep the targets', async () => {
  const h = pooledProbes(),
    environment = fakeEnvironment(h.engine.gpu);
  // Configure the environment before setup in the real API; this fixture isolates native binding identities.
  h.probes.dispose();
  const g = pooledProbes({ environment });
  environment.device = g.engine.gpu;
  await g.probes.bake();
  const resources = g.probes.captureResources,
    owned = [...resources.owned];
  g.takeLog();
  await g.probes.bake({ samples: 64 });
  assert.equal(
    g.takeLog().filter((entry) => entry[0] === 'group').length,
    4,
    'SH plus three sampled reflection groups',
  );
  await g.probes.bake();
  assert.equal(
    g.takeLog().filter((entry) => entry[0] === 'group').length,
    0,
    'exact convolution groups survive a sampled bake',
  );
  environment.specularView = { replacement: true };
  environment.paramsBuffer = { replacement: true };
  environment.version++;
  await g.probes.bake();
  const groups = g.takeLog().filter((entry) => entry[0] === 'group');
  assert.equal(groups.length, 4);
  assert.ok(
    groups
      .filter((entry) => entry[2].entries.some((binding) => binding.binding === 4))
      .every((entry) => entry[2].entries.find((binding) => binding.binding === 4).resource.replacement),
  );
  g.frame.state.shader += '\n// refreshed source';
  await g.probes.bake();
  const shaderChange = g.takeLog();
  assert.equal(shaderChange.filter((entry) => entry[0] === 'renderPipeline').length, 1);
  assert.equal(shaderChange.filter((entry) => entry[0] === 'group').length, 0);
  assert.strictEqual(g.probes.captureResources, resources);
  assert.deepEqual(resources.owned, owned);
  g.probes.dispose();
});

test('capture resource initialization rolls back each failed allocation and can retry without publishing partial state', async () => {
  for (const [name, failAt] of [
    ['createBuffer', 1],
    ['createBuffer', 2],
    ['createSampler', 1],
    ['createTexture', 1],
    ['createTexture', 2],
    ['createTexture', 3],
    ['createTexture', 4],
  ]) {
    const h = pooledProbes();
    h.engine.render();
    h.takeLog();
    const before = h.created.length,
      operation = h.gpu.device[name],
      failure = new Error(name + ':' + failAt);
    let calls = 0;
    h.gpu.device[name] = (...args) => {
      if (++calls === failAt) throw failure;
      return operation(...args);
    };
    await assert.rejects(h.probes.bake(), (error) => error === failure);
    assert.equal(h.probes.captureResources, undefined);
    assert.ok(
      h.created.slice(before).every((resource) => resource.destroyed),
      failure.message + ' leaked a partial capture resource',
    );
    h.gpu.device[name] = operation;
    await h.probes.bake();
    assert.equal(h.probes.baked, true);
    const owned = [...h.probes.captureResources.owned];
    h.probes.dispose();
    assert.ok(owned.every((resource) => resource.destroyed));
  }
});

test('failed capture draw restores its host context and leaves owned resources available for retry and disposal', async () => {
  const h = pooledProbes();
  let scopes = 0;
  h.gpu.device.pushErrorScope = () => {
    scopes++;
  };
  h.gpu.device.popErrorScope = async () => {
    scopes--;
    return null;
  };
  h.engine.render();
  const c = h.frame.c,
    failure = new Error('draw failure'),
    draw = c.draw,
    encoder = c.encoder,
    color = c.color,
    depth = c.depth,
    descriptor = c.descriptor;
  const render = h.engine.render,
    run = passes(h.probes);
  h.engine.render = () => {
    h.frame.begin(0);
    c.draw = () => {
      throw failure;
    };
    run(c);
  };
  await assert.rejects(h.probes.bake(), (error) => error === failure);
  assert.equal(scopes, 0, 'a failed receiver cannot strand the native error scope');
  assert.strictEqual(c.encoder, encoder);
  assert.strictEqual(c.color, color);
  assert.strictEqual(c.depth, depth);
  assert.strictEqual(c.descriptor, descriptor);
  const owned = [...h.probes.captureResources.owned];
  c.draw = draw;
  h.engine.render = render;
  await h.probes.bake();
  assert.equal(scopes, 0);
  assert.ok(owned.every((resource) => !resource.destroyed));
  h.probes.dispose();
  assert.ok(owned.every((resource) => resource.destroyed));
});

test('reused capture contexts restore receiver-mutated frame fields and capture cameras before every face', async () => {
  const h = pooledProbes(),
    borrowed = new Set(),
    cameras = new Set();
  let faces = 0;
  h.probes.add({
    addLighting() {
      return () => {};
    },
    draw(c) {
      assert.ok(c.shader.includes('margoAmbient'));
      assert.equal(c.camera.fov, 90);
      assert.equal(c.removedKey, undefined);
      assert.equal(c.width, faces % 18 < 12 ? 8 : 16);
      const eye = [...c.camera.position],
        aim = [...c.camera.target];
      c.camera.advance(0.05);
      assert.deepEqual(c.camera.position, eye, 'a previous receiver fit cannot advance the next capture camera');
      assert.deepEqual(c.camera.target, aim);
      borrowed.add(c);
      cameras.add(c.camera);
      faces++;
      c.shader = 'receiver mutation';
      c.camera.fov = 30;
      c.camera.fitToBoundingBox([-0.1, 0, -0.1], [0.1, 0.2, 0.1], { duration: 1 });
      c.removedKey = 'must not survive into the next face';
    },
  });
  await h.probes.bake({ bounces: 2 });
  assert.equal(faces, 36);
  assert.equal(borrowed.size, 1);
  assert.equal(cameras.size, 6);
  h.probes.dispose();
});

test('disposal during readback rejects the bake without publishing a stale snapshot or leaking pooled buffers', async () => {
  const h = pooledProbes();
  await h.probes.bake();
  const previous = h.probes.texels,
    resources = h.probes.captureResources,
    owned = [...resources.owned];
  let release, reached;
  const waiting = new Promise((resolve) => {
    reached = resolve;
  });
  resources.read.mapAsync = () => {
    reached();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pending = h.probes.bake();
  await waiting;
  await assert.rejects(h.probes.bake(), /bake pending/);
  h.probes.dispose();
  release();
  await assert.rejects(pending, /interrupted/);
  assert.strictEqual(h.probes.texels, previous);
  assert.ok(owned.every((resource) => resource.destroyed));
});

test('a readback failure preserves the previous public snapshot, unmaps completed reads, and can retry with the same owned buffer', async () => {
  const h = pooledProbes();
  await h.probes.bake();
  const previous = h.probes.texels,
    read = h.probes.captureResources.read,
    failure = new Error('readback failure'),
    mappedRange = read.getMappedRange;
  let unmaps = 0;
  read.unmap = () => {
    unmaps++;
  };
  read.getMappedRange = () => {
    throw failure;
  };
  await assert.rejects(h.probes.bake(), (error) => error === failure);
  assert.strictEqual(h.probes.texels, previous);
  assert.equal(unmaps, 1);
  assert.equal(read.destroyed, undefined);
  read.getMappedRange = mappedRange;
  await h.probes.bake();
  assert.strictEqual(h.probes.captureResources.read, read);
  assert.equal(unmaps, 2);
  assert.notStrictEqual(h.probes.texels, previous);
  h.probes.dispose();
  assert.equal(read.destroyed, true);
});

test('a restored device cannot publish an older device readback that completes after restoration', async () => {
  const h = pooledProbes();
  await h.probes.bake();
  const previous = h.probes.texels,
    resources = h.probes.captureResources,
    owned = [...resources.owned];
  let release, reached;
  const waiting = new Promise((resolve) => {
    reached = resolve;
  });
  resources.read.mapAsync = () => {
    reached();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pending = h.probes.bake();
  await waiting;
  h.engine.gpu = device(mockGPU());
  h.probes.onDeviceRestored(h.engine);
  assert.ok(owned.every((resource) => resource.destroyed));
  release();
  await assert.rejects(pending, /interrupted/);
  assert.strictEqual(h.probes.texels, previous);
  assert.equal(h.probes.captureResources, undefined);
  h.probes.dispose();
});

test('unpublished probe readbacks reuse their bulk storage while every published texel snapshot remains stable', async () => {
  const h = pooledProbes();
  await h.probes.bake();
  const initial = h.probes.snapshot,
    read = h.probes.captureResources.read;
  let value = 123;
  read.getMappedRange = () => new Uint32Array(initial.length).fill(value).buffer;
  await h.probes.bake();
  assert.strictEqual(h.probes.snapshot, initial, 'a bake without a texels reader must reuse private bulk storage');
  assert.ok(initial.every((word) => word === 123));
  const retained = h.probes.texels;
  assert.strictEqual(h.probes.texels, retained, 'repeated reads of one published bake retain identity');
  value = 456;
  await h.probes.bake();
  const unobserved = h.probes.snapshot;
  assert.notStrictEqual(unobserved, retained, 'publishing a previous bake requires a fresh destination');
  assert.ok(retained.every((word) => word === 123));
  assert.ok(unobserved.every((word) => word === 456));
  value = 789;
  await h.probes.bake();
  assert.strictEqual(h.probes.snapshot, unobserved, 'the new unpublished destination becomes reusable');
  assert.ok(unobserved.every((word) => word === 789));
  assert.ok(
    retained.every((word) => word === 123),
    'later private reuse cannot mutate any published old snapshot',
  );
  const failure = new Error('readback before publication');
  read.getMappedRange = () => {
    throw failure;
  };
  await assert.rejects(h.probes.bake(), (error) => error === failure);
  assert.strictEqual(h.probes.snapshot, unobserved);
  assert.ok(
    unobserved.every((word) => word === 789),
    'a failed read cannot partially update reusable storage',
  );
  assert.ok(retained.every((word) => word === 123));
  h.probes.dispose();
});

test('irradianceAt mirrors the shader: trilinear between probe centres, float16 SH', async () => {
  const gpu = mockGPU(),
    engine = fakeEngine(gpu),
    probes = new LightProbes({ volume: { ...room, counts: [2, 1, 1], sh: 1 } });
  probes.setup(engine);
  // Probe 0 (x = -1) radiates 1 uniformly, probe 1 (x = 1) 3: DC = value / 0.282094792 (irradiance / PI form).
  const texels = new Uint32Array(2 * 4 * 2),
    dc = (v) => floatToHalf(v / 0.282094792);
  for (const [probe, value] of [
    [0, 1],
    [1, 3],
  ]) {
    texels[probe * 8] = dc(value) | (dc(value) << 16);
    texels[probe * 8 + 1] = dc(value);
  }
  probes['snapshot'] = texels;
  const at = (x) => probes.irradianceAt([x, 1.5, 0], [0, 1, 0]).map((v) => +v.toFixed(2));
  assert.deepEqual(at(-1), [1, 1, 1]);
  assert.deepEqual(at(1), [3, 3, 3]);
  assert.deepEqual(at(0), [2, 2, 2]);
  assert.deepEqual(at(-2), [1, 1, 1], 'clamped to the first centre');
  assert.equal(probes.irradianceAt([0, 4, 0], [0, 1, 0]), null, 'outside the volume');
  probes.dispose();
});
