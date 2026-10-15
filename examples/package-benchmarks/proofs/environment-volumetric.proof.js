// Proof that VolumetricFog (`@margoengine/environment/volumetric`) changes nothing it does not own:
// 1. environment's root entry (Fog, ColorBackground) records the same GPU calls at `ref` and in the working tree (the
//    volumetric entry is a separate build that shares no module with the root).
// 2. A 12-frame story at 1x and 4x MSAA (Tonemap capture, core main pass, Clustered lights, a switched-off Fog, a
//    ColorBackground; lights moved, a resize, a device restore): with VolumetricFog attached from frame 3 and disposed at
//    frame 8, every other GPU call (all calls outside its own pass, resource ids renumbered by first use), the lit shader
//    and its bindings left on the pass context, and the frames before attach and after dispose are identical to the
//    story without it. Its own pass makes one compute pass and one composite draw per frame.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/environment-volumetric.proof.js [ref]
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {versions} from './compare.js';
import {mockGPU, context} from './gpu-recorder.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';
import {Clustered} from '../../../packages/clustered/dist/index.js';
import {Tonemap} from '../../../packages/tonemap/dist/index.js';
import * as environment from '../../../packages/environment/dist/index.js';
import {VolumetricFog} from '../../../packages/environment/dist/volumetric.js';

const ref = process.argv[2] ?? '7c47a09';
// 1. Root entry at ref vs working tree.
const {baseline, candidate} = await versions('environment', ref);
const rootStory = module => {
  const gpu = mockGPU(), engine = {backend: 'webgpu', gpu: gpu.device, removePlugin() {}, onError() {}}, view = context(gpu, {samples: 4, shader: wgsl, format: 'bgra8unorm'});
  return gpu.record(() => {
    const fog = new module.Fog({color: '#a0b0c0', density: 0.02, heightFalloff: 0.1}), background = new module.ColorBackground({color: '#203040'}), list = [{order: 0, execute: c => c.draw()}];
    for (const effect of [fog, background]) {effect.setup(engine); effect.registerPasses({add: pass => list.push(pass)});} list.sort((a, b) => a.order - b.order);
    for (let i = 0; i < 6; i++) {if (i === 2) fog.far = 50; if (i === 3) fog.enabled = false; if (i === 4) view.state.samples = 1; view.begin(i); for (const pass of list) pass.execute(view.c); view.end();}
    fog.dispose(); background.dispose();
  });
};
const rootCalls = rootStory(baseline);
assert.deepEqual(rootStory(candidate), rootCalls, 'environment root entry changed');

// 2. Full story with and without VolumetricFog.
const point = {position: [0, 2, 1], range: 6, intensity: 9}, spot = {position: [1, 3, 0], range: 8, direction: [0, -1, 0.2], outerAngle: 0.6, intensity: 20};
function story(samples, withFog) {
  const gpu = mockGPU(), view = context(gpu, {samples, shader: wgsl, format: 'bgra8unorm'});
  const engine = {backend: 'webgpu', gpu: gpu.device, plugins: new Map(), lighting: {direction: new Float32Array([0.3, 0.8, -0.5, 4]), radiance: new Float32Array([1, 1, 1, 0.1])},
    hasPlugin: name => engine.plugins.has(name), removePlugin(name) {engine.plugins.delete(name);}, onError() {}};
  const ownPasses = [], own = (kind, work) => {gpu.note('volumetric:begin', kind); work(); gpu.note('volumetric:end');};
  const log = gpu.record(() => {
    const lights = new Clustered({grid: [4, 3, 2]}), tonemap = new Tonemap(), fog = new environment.Fog({density: 0.02}), background = new environment.ColorBackground();
    fog.enabled = false;
    const list = [{order: 0, execute: c => c.draw()}], add = pass => list.push(pass);
    for (const effect of [tonemap, lights, fog, background]) {engine.plugins.set(effect.name, effect); effect.setup(engine); effect.registerPasses({add});}
    let volumetric;
    for (let i = 0; i < 12; i++) {
      if (i === 1) lights.setLights([point]); if (i === 4) lights.setLights([point, spot]); if (i === 5) {view.state.width = 640; view.state.height = 360;}
      if (i === 7) {for (const effect of [tonemap, lights, fog]) effect.onDeviceRestored(engine); own('setup', () => volumetric?.onDeviceRestored(engine));}
      if (withFog && i === 3) {
        volumetric = new VolumetricFog({lights, density: 0.03, grid: [16, 9, 8]}); engine.plugins.set(volumetric.name, volumetric); own('setup', () => volumetric.setup(engine));
        volumetric.registerPasses({add: pass => list.push({...pass, execute: c => own('pass', () => pass.execute(c))})});
      }
      if (withFog && i === 8) {own('setup', () => volumetric.dispose()); list.splice(list.findIndex(p => p.order === 5), 1);}
      list.sort((a, b) => a.order - b.order);
      view.begin(i); gpu.note('frame', i); for (const pass of list) pass.execute(view.c); view.end();
    }
    for (const effect of [tonemap, lights, fog, background]) effect.dispose();
  });
  // Drop the volumetric pass's own calls; renumber resource ids by first appearance.
  const others = [];let inside = false;
  for (const entry of log) {if (entry[0] === 'volumetric:begin') {inside = true; ownPasses.push(entry[1] === 'pass' ? [] : null); continue;} if (entry[0] === 'volumetric:end') {inside = false; continue;} if (inside) ownPasses.at(-1)?.push(entry); else others.push(entry);}
  const ids = new Map(), rename = value => typeof value === 'string' ? value.replace(/\b([a-zA-Z]+)#(\d+)\b/g, (match, kind) => {if (!ids.has(match)) ids.set(match, kind + '#' + ids.size); return ids.get(match);}) : value;
  return {calls: JSON.parse(JSON.stringify(others), (_, value) => rename(value)), ownPasses: ownPasses.filter(Boolean)};
}
const report = {package: 'environment', entry: 'volumetric', baseline: ref, rootEntryCalls: rootCalls.length, stories: {}};
for (const samples of [1, 4]) {
  const without = story(samples, false), withFog = story(samples, true);
  assert.ok(without.calls.some(e => e[0] === 'context' && /clusterLighting\(/.test(e[1])), 'story must light core meshes with clustered lights');
  const first = withFog.calls.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(without.calls[i]));
  assert.deepEqual(withFog.calls, without.calls, `${samples}x: GPU calls outside VolumetricFog's pass, or the lit shader/bindings, changed (first at ${first}: ${JSON.stringify(withFog.calls[first])?.slice(0, 300)} vs ${JSON.stringify(without.calls[first])?.slice(0, 300)})`);
  assert.equal(withFog.ownPasses.length, 5, 'attached for frames 3-7');
  for (const pass of withFog.ownPasses) {
    assert.equal(pass.filter(e => e[0] === 'beginComputePass').length, 1); assert.equal(pass.filter(e => e[0] === 'beginRenderPass').length, 1);
    assert.equal(pass.filter(e => e[0] === 'pass.draw').length, 1); assert.equal(pass.filter(e => e[0] === 'pass.dispatchWorkgroups').length, 2);
  }
  report.stories[samples + 'x'] = {identicalCalls: without.calls.length, volumetricCalls: withFog.ownPasses.reduce((s, p) => s + p.length, 0)};
}
console.log(JSON.stringify(report));
await writeFile(resolve(import.meta.dirname, 'results/environment-volumetric.json'), JSON.stringify(report, null, 2) + '\n');
