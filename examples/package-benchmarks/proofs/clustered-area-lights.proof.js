// Proof that rectangle area lights (`@margoengine/clustered/area`) change nothing for apps without area lights: clustered's
// root gained an `area` hook (shader composition and bind group join). A 9-frame story (lights set, moved, a gltf-pro model
// added and removed, intensity scale changed, MSAA 1x/4x, device restored) records every GPU call, descriptor, shader
// module and buffer write of clustered (core-mesh shader patch and compute pass) and of a gltf-pro model it lights:
// identical at `ref` and in the working tree, both without the entry and with an AreaLights attached whose list is empty
// (it creates its buffer and hook only once it has lights).
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/clustered-area-lights.proof.js [ref] [pin] [--current]
// Pinned: 67e0172 against dab9633, the commit that made this claim. --current: 67e0172 against the working tree.
import assert from 'node:assert/strict';
import {refs, versions, entryAt} from './compare.js';
import {mockGPU, context, passes} from './gpu-recorder.js';
import {Engine, TransformStore} from '../../../packages/core/dist/extension.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';
import {animatedTriangle} from '../../../tests/support/gltf-pro-fixture.js';

const {ref, pin} = refs('67e0172', 'dab9633', '67e0172');
const {baseline, candidate} = await versions('clustered', ref, undefined, pin);
const gltf = await entryAt('gltf-pro', 'src/index.ts', pin), {AreaLights} = await entryAt('clustered', 'src/area.ts', pin);
const point = {position: [0, 2, 1], range: 6, color: [1, 0.5, 0.2], intensity: 9}, spot = {position: [1, 3, 0], range: 8, direction: [0, -1, 0.2], outerAngle: 0.6, innerAngle: 0.3, intensity: 20};

async function story(clustered, withArea, samples) {
  const gpu = mockGPU(), store = await TransformStore.create(32), canvas = {width: 128, height: 96, clientWidth: 128, clientHeight: 96};
  const renderer = {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine(canvas, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  const fixture = animatedTriangle(); delete fixture.doc.skins; delete fixture.doc.animations;
  const log = gpu.record(() => {
    const model = gltf.parseGLTF(engine, fixture.doc, fixture.buffers); engine.camera.update(4 / 3, true); store.tick(false);
    const view = context(gpu, {samples, shader: wgsl}), lights = new clustered.Clustered({grid: [4, 3, 2]}); lights.setup(engine);
    const area = withArea ? new AreaLights({lights}) : null; area?.setup(engine); const list = withArea === 'lit' ? [{position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 0.5, intensity: 4}] : []; area?.setLights(list);
    const run = [passes(lights), ...area ? [passes(area)] : []];
    let remove;
    const steps = [() => lights.setLights([point]), () => {remove = lights.add(model);}, () => lights.setLights([point, spot]), () => {lights.intensityScale = 0.5;},
      () => lights.setLights([spot, {...point, position: [0.5, 2, 1]}]), () => {lights.onDeviceRestored(engine); area?.onDeviceRestored(engine);}, () => {lights.intensityScale = () => 2;}, () => remove(), () => lights.setLights([])];
    steps.forEach((step, frame) => {step(); area?.setLights(list); view.begin(frame); for (const r of run) r(view.c); view.end(); gpu.note('draw', frame); model.draw(view.c, 'beauty', view.c.color, view.c.depth);});
    model.dispose(); area?.dispose(); lights.dispose();
  });
  engine.dispose();
  return log;
}
let calls = 0, modules = 0;
for (const samples of [1, 4]) {
  const expected = await story(baseline, false, samples);
  assert.ok(expected.some(e => e[0] === 'module' && /clusterLighting\(/.test(e[2].code)) && expected.some(e => e[0] === 'context' && /clusterLighting\(i\.clip/.test(e[1])), 'story must light the gltf-pro model and patch core\'s shader');
  assert.deepEqual(await story(candidate, false, samples), expected, `clustered GPU calls differ at ${samples}x`);
  assert.deepEqual(await story(candidate, 'empty', samples), expected, `an empty AreaLights changed GPU calls at ${samples}x`);
  const lit = await story(candidate, 'lit', samples);
  assert.ok(lit.some(e => e[0] === 'module' && /clusterAreaLighting\(/.test(e[2].code)) && lit.some(e => e[0] === 'context' && /clusterAreaLighting\(position/.test(e[1])), 'one area light reaches both shaders');
  calls += expected.length; modules += expected.filter(e => e[0] === 'module').length;
}
console.log(JSON.stringify({package: 'clustered', baseline: ref, identicalCalls: calls, shaderModules: modules, emptyAreaLights: 'identical'}));
