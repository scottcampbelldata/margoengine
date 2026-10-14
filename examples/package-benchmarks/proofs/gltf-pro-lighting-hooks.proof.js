// Proof that gltf-pro's lighting hooks (HANDOFF 1g.c) change nothing on the GPU: shadows, clustered lights, environment IBL and
// fog used to find their places in gltf-pro's WGSL by text search; now each hands gltf-pro a `pbr(group)` contribution and
// gltf-pro composes it. A 14-frame story (effects added in different orders, a text-patching custom effect in between, the
// environment going away and back, removals, an HDR and a canvas target, MSAA 1x/4x, beauty/SSAO-ambient/G-buffer draws, the
// standard, physical, unlit, masked and blended materials) records every GPU call, descriptor, shader module and buffer
// write of gltf-pro + shadows + clustered + environment at `ref` and in the working tree: they must be identical.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/gltf-pro-lighting-hooks.proof.js [ref]
import assert from 'node:assert/strict';
import {versions} from './compare.js';
import {mockGPU, context} from './gpu-recorder.js';
import {Engine, TransformStore} from '../../../packages/core/dist/extension.js';
import {animatedTriangle} from '../../../tests/support/gltf-pro-fixture.js';

const ref = process.argv[2] ?? '15c87f1';
const load = async () => {const all = await Promise.all(['gltf-pro', 'shadows', 'clustered', 'environment'].map(name => versions(name, ref))); return ['baseline', 'candidate'].map(k => all.map(v => v[k]));};
const [baseline, candidate] = await load();
const materials = [{alphaMode: 'OPAQUE'}, {alphaMode: 'BLEND', pbrMetallicRoughness: {baseColorFactor: [1, 1, 1, 0.5]}}, {extensions: {KHR_materials_clearcoat: {clearcoatFactor: 1}}},
  {extensions: {KHR_materials_unlit: {}}}, {alphaMode: 'MASK', alphaCutoff: 0.3}];

async function story([gltf, shadowsModule, clusteredModule, environment], samples) {
  const gpu = mockGPU(), store = await TransformStore.create(32), canvas = {width: 128, height: 96, clientWidth: 128, clientHeight: 96};
  const renderer = {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine(canvas, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  const fixture = animatedTriangle(), primitive = fixture.doc.meshes[0].primitives[0];
  fixture.doc.materials = materials; fixture.doc.extensionsUsed = ['KHR_materials_clearcoat', 'KHR_materials_unlit'];
  fixture.doc.meshes = materials.map((_, material) => ({primitives: [{...primitive, material}]}));
  fixture.doc.nodes = materials.map((_, mesh) => ({mesh, translation: [0, 0, -mesh]}));
  delete fixture.doc.skins; delete fixture.doc.animations;
  const environmentStub = {device: gpu.device, disposed: false, version: 0, specularView: {}, sampler: {}, brdfLutView: {}, shBuffer: {}, paramsBuffer: {}, restore: () => Promise.resolve()};
  const log = gpu.record(() => {
    const model = gltf.parseGLTF(engine, fixture.doc, fixture.buffers); engine.camera.update(4 / 3, true); store.tick(false);
    const view = context(gpu, {samples, format: 'rgba16float', depthFormat: 'depth32float-stencil8'});
    const shadows = new shadowsModule.Shadows({resolution: 64}), clustered = new clusteredModule.Clustered({grid: [4, 3, 2]});
    const ibl = new environment.EnvironmentLighting(environmentStub), fog = new environment.Fog({color: '#9ab', density: 0.05, heightFalloff: 0.2});
    shadows.setup(engine); clustered.setup(engine); fog.setup(engine);
    // A custom effect that still patches text, between hook effects (materials and LOD baking work this way).
    const custom = {shader: source => '// custom\n' + source.replace('fn ambient(', '// before ambient\nfn ambient('), bindings: () => []};
    const removers = new Map(), add = (effect, apply) => removers.set(effect, apply()), drop = effect => {removers.get(effect)(); removers.delete(effect);};
    const steps = [
      () => {}, () => add(shadows, () => shadows.add(model)), () => add(ibl, () => ibl.applyTo(model)), () => add(custom, () => model.addLighting(custom)),
      () => add(clustered, () => clustered.add(model)), () => add(fog, () => fog.applyTo(model)), () => {environmentStub.device = null;},
      () => {environmentStub.device = gpu.device; environmentStub.version++;}, () => drop(shadows), () => {view.state.format = 'bgra8unorm';},
      () => drop(ibl), () => add(ibl, () => ibl.applyTo(model)), () => {drop(fog); drop(custom);}, () => {for (const effect of [...removers.keys()]) drop(effect);},
    ];
    steps.forEach((step, frame) => {
      step(); view.begin(frame);
      for (const mode of ['beauty', 'ambient', 'gbuffer']) {gpu.note('draw', frame, mode); try {model.draw(view.c, mode, view.c.color, view.c.depth);} catch (error) {gpu.note('throw', error.message);}}
    });
    model.dispose(); shadows.dispose(); clustered.dispose(); ibl.dispose(); fog.dispose();
  });
  engine.dispose();
  return log;
}

let calls = 0, modules = 0;
for (const samples of [1, 4]) {
  const expected = await story(baseline, samples), actual = await story(candidate, samples);
  const shaders = expected.filter(entry => entry[0] === 'module');
  assert.ok(shaders.some(entry => /shadowLit\(direct/.test(entry[2].code) && /clusterLighting\(/.test(entry[2].code) && /let margoAmbient=/.test(entry[2].code) && /fogAmount\(/.test(entry[2].code) && /\/\/ custom/.test(entry[2].code)), 'story must compose every effect');
  assert.ok(!expected.some(entry => entry[0] === 'throw'), 'no draw may throw');
  assert.deepEqual(actual, expected, `gltf-pro lighting GPU calls differ at ${samples}x`);
  calls += expected.length; modules += shaders.length;
}
console.log(JSON.stringify({packages: ['gltf-pro', 'shadows', 'clustered', 'environment'], baseline: ref, identicalCalls: calls, shaderModules: modules, writes: 'byte-identical'}));

// --time: CPU of one beauty draw of 300 primitives (60 per material) lit by shadows, clustered, IBL and fog, steady frames.
// The pipeline key used to append the whole shader text, so every draw flattened and hashed ~20 kB of string.
if (process.argv.includes('--time')) {
  const {time} = await import('./compare.js');
  const scene = async ([gltf, shadowsModule, clusteredModule, environment]) => {
    const gpu = mockGPU(), store = await TransformStore.create(512), renderer = {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}};
    const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
    const fixture = animatedTriangle(), primitive = fixture.doc.meshes[0].primitives[0], count = 300;
    fixture.doc.materials = materials; fixture.doc.extensionsUsed = ['KHR_materials_clearcoat', 'KHR_materials_unlit'];
    fixture.doc.meshes = [{primitives: Array.from({length: count}, (_, k) => ({...primitive, material: k % materials.length}))}];
    fixture.doc.nodes = [{mesh: 0}]; delete fixture.doc.skins; delete fixture.doc.animations;
    const model = gltf.parseGLTF(engine, fixture.doc, fixture.buffers); engine.camera.update(4 / 3, true); store.tick(false);
    const view = context(gpu, {samples: 4}), stub = {device: gpu.device, disposed: false, version: 0, specularView: {}, sampler: {}, brdfLutView: {}, shBuffer: {}, paramsBuffer: {}, restore: () => Promise.resolve()};
    const shadows = new shadowsModule.Shadows({resolution: 64}), clustered = new clusteredModule.Clustered({grid: [4, 3, 2]}), fog = new environment.Fog();
    shadows.setup(engine); clustered.setup(engine); fog.setup(engine); shadows.add(model); clustered.add(model); new environment.EnvironmentLighting(stub).applyTo(model); fog.applyTo(model);
    view.begin(0); model.draw(view.c, 'beauty', view.c.color, view.c.depth);
    return () => model.draw(view.c, 'beauty', view.c.color, view.c.depth);
  };
  console.log(JSON.stringify({case: 'beauty draw, 300 primitives, 4 lighting effects', ...time(await scene(baseline), await scene(candidate), 40)}));
}
