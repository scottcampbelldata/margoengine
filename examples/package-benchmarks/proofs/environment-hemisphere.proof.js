// Proof that HemisphereLight and AmbientLight (environment's root entry) change nothing for apps without them: the root
// gained the classes, the `sky` lighting hook (packages/shared/pbr-hooks.js, composed by gltf-pro) and LightProbes'
// patch learned to take a hemisphere as its fallback. Without a hemisphere, at `ref` and in the working tree:
// 1. EnvironmentLighting, Fog and LightProbes (with and without an environment) patch every core-shader variant other
//    packages leave before order -1 (plain, shadows, sky ambient, clustered, HDR capture, terrain) to the same text, and
//    give gltf-pro the same lighting hooks.
// 2. Those hooks composed by gltf-pro's lightPBR (each alone, IBL + fog, probes + fog) into the standard, extended,
//    physical and transmissive shaders give the same WGSL.
// 3. Six frames of each effect's passes (uploads, patch, bindings; a device restore) record the same GPU calls.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/environment-hemisphere.proof.js [ref] [pin] [--current]
// Pinned: 6c20076d against b4700864, the series' last code commit; --current: 57250a49 against the working tree.
import assert from 'node:assert/strict';
import { refs, versions, load as loadAt, commit, announce } from './compare.js';
import { mockGPU, context } from './gpu-recorder.js';
import { wgsl } from '../../../packages/core/src/shaders.ts';

const { ref, pin } = refs('6c20076d', 'b4700864', '57250a49');
const root = await versions('environment', ref, 'src/index.ts', pin),
  probes = await versions('environment', ref, 'src/probes.ts', pin);
// gltf-pro's shaders and the hook composer (packages/shared, inlined into gltf-pro) from the same refs.
announce('gltf-pro src/shader.ts + shared/pbr-hooks.js', ref, pin);
const gltfAt = async (at) => ({
  ...(await loadAt('gltf-pro', 'src/shader.ts', at)),
  ...(await loadAt('gltf-pro', '../shared/pbr-hooks.js', at)),
});
const shaders = { baseline: await gltfAt(commit(ref)), candidate: await gltfAt(pin && commit(pin)) };

const variants = {
  core: wgsl,
  shadows: wgsl.replace('let linear=direct*', 'let linear=shadowLit(direct,i.position,i.normal)*'),
  sky: wgsl.replace('frame.radiance.w*frame.ambient.rgb', 'skyAmbient.rgb'),
  clustered: wgsl.replace(
    /let linear=([^;]+);/,
    'let linear=$1+clusterLighting(i.clip.xy,i.position,n,frame.eye.xyz,i.color,i.material.x,i.material.y);',
  ),
  hdr: wgsl.replace(/let mapped=pbrNeutral\([\s\S]*?return vec4f\([^\n]+\);/, 'return vec4f(linear,1);'),
  terrain:
    'let base=terrainColor(i.position,n);\n' +
    wgsl.replace('+i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb', '+base*frame.radiance.w'),
};
const room = { min: [-2, 0, -2], max: [2, 3, 2] };
const stub = (device) => ({
  device,
  disposed: false,
  version: 0,
  specularView: {},
  sampler: {},
  brdfLutView: {},
  brdfLut: {},
  shBuffer: {},
  paramsBuffer: {},
  restore: () => Promise.resolve(),
});
function effects(env, probe, device) {
  const engine = { backend: 'webgpu', gpu: device, onError() {}, removePlugin() {} },
    list = {
      ibl: new env.EnvironmentLighting(stub(device)),
      fog: new env.Fog({ color: '#a0b0c0', density: 0.02 }),
      probes: new probe.LightProbes({ volume: { ...room, counts: [2, 2, 2] } }),
      envProbes: new probe.LightProbes({ environment: stub(device), volume: { ...room, counts: [2, 2, 2] } }),
    };
  for (const effect of Object.values(list)) effect.setup(engine);
  return { engine, list };
}
// 1 and 2: text.
function texts(env, probe, gltf) {
  const { list } = effects(env, probe, mockGPU().device),
    out = {};
  for (const [name, effect] of Object.entries(list)) {
    for (const [variant, code] of Object.entries(variants)) {
      if (name === 'ibl' && variant === 'terrain') continue;
      out[`${name}/${variant}`] = effect.shader(code, 0);
    }
    out[`${name}/hooks`] = JSON.stringify(effect.pbr(2));
  }
  out['fog/after-ibl'] = list.fog.shader(list.ibl.shader(wgsl, 0), 0);
  out['fog/after-probes'] = list.fog.shader(list.probes.shader(wgsl, 0), 0);
  for (const [name, source] of Object.entries({
    standard: gltf.pbrShader,
    extended: gltf.extendedPBRShader,
    physical: gltf.physicalShader(),
    transmissive: gltf.transmissiveShader(),
  }))
    for (const combination of [['ibl'], ['probes'], ['envProbes'], ['fog'], ['ibl', 'fog'], ['probes', 'fog']])
      out[`${name}/${combination.join('+')}`] = combination
        .map((n) => list[n].pbr(2))
        .reduce((code, h) => gltf.lightPBR(code, h), source);
  return out;
}
// 3: GPU calls of each effect's passes over six frames, a device restore at frame 3.
function calls(env, probe) {
  const gpu = mockGPU(),
    { engine, list } = effects(env, probe, gpu.device),
    view = context(gpu, { samples: 4, shader: wgsl, format: 'bgra8unorm' });
  return gpu.record(() => {
    const passes = new Map();
    for (const effect of Object.values(list)) {
      const own = [];
      effect.registerPasses({ add: (pass) => own.push(pass) });
      passes.set(
        effect,
        own.sort((a, b) => a.order - b.order),
      );
    }
    for (let i = 0; i < 6; i++) {
      if (i === 2) list.fog.far = 50;
      if (i === 3) for (const effect of Object.values(list)) effect.onDeviceRestored(engine);
      view.begin(i);
      // One shader-patching effect per frame, in turn (IBL and probes never share a shader).
      for (const pass of passes.get(Object.values(list)[i % 4])) pass.execute(view.c);
      view.end();
    }
    for (const effect of Object.values(list)) effect.dispose();
  });
}
const pairs = ['baseline', 'candidate'].map((k) => [root[k], probes[k], shaders[k]]);
const [expectedText, gotText] = pairs.map(([env, probe, gltf]) => texts(env, probe, gltf));
let compared = 0;
for (const key of Object.keys(expectedText)) {
  assert.equal(gotText[key], expectedText[key], `${key} differs without a hemisphere`);
  compared++;
}
const [expectedCalls, gotCalls] = pairs.map(([env, probe]) => calls(env, probe));
assert.deepEqual(gotCalls, expectedCalls, 'environment GPU calls differ without a hemisphere');
// The candidate's hemisphere does reach both shader kinds once attached.
const sky = new root.candidate.HemisphereLight({ sky: '#bcd', ground: '#432' });
sky.setup({ backend: 'webgpu', gpu: mockGPU().device, onError() {}, removePlugin() {} });
assert.ok(sky.shader(wgsl, 0).includes('*margoSkyLight(n);') && sky.pbr(2).sky, 'a hemisphere patches and hooks');
console.log(
  JSON.stringify({
    package: 'environment',
    baseline: ref,
    identicalTexts: compared,
    identicalCalls: expectedCalls.length,
  }),
);
