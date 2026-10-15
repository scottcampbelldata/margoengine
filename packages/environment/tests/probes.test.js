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
  remove();
  probes.dispose();
  core.dispose();
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
