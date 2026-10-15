// Proof that point/spot light shadows (`@margoengine/clustered/shadows`) change nothing for apps that do not attach them:
// clustered's root gained a `castShadow` light field and a shadow hook in its light loop. A 9-frame story (lights set,
// moved, a gltf-pro model added and removed, intensity scale changed, MSAA 1x/4x, device restored) records every GPU call,
// descriptor, shader module and buffer write of clustered (core-mesh shader patch and compute pass) and of a gltf-pro model
// it lights, at `ref` and in the working tree: identical. With `castShadow: true` lights but no LocalShadows, the only
// difference is the light buffer's unused params.z (the shadow ordinal); shaders and every other call stay identical.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/clustered-local-shadows.proof.js [ref] [pin] [--current]
// Pinned: 0ed56b9 against 590278e, the commit that made this claim. --current: 0ed56b9 against the working tree.
import assert from 'node:assert/strict';
import {refs, versions, entryAt} from './compare.js';
import {mockGPU, context, passes} from './gpu-recorder.js';
import {Engine, TransformStore} from '../../../packages/core/dist/extension.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';
import {animatedTriangle} from '../../../tests/support/gltf-pro-fixture.js';

const {ref, pin} = refs('0ed56b9', '590278e', '0ed56b9');
const {baseline, candidate} = await versions('clustered', ref, undefined, pin), gltf = await entryAt('gltf-pro', 'src/index.ts', pin);
const point = {position: [0, 2, 1], range: 6, color: [1, 0.5, 0.2], intensity: 9}, spot = {position: [1, 3, 0], range: 8, direction: [0, -1, 0.2], outerAngle: 0.6, innerAngle: 0.3, intensity: 20};

async function story(clustered, castShadow, samples) {
  const gpu = mockGPU(), store = await TransformStore.create(32), canvas = {width: 128, height: 96, clientWidth: 128, clientHeight: 96};
  const renderer = {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine(canvas, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  const fixture = animatedTriangle(); delete fixture.doc.skins; delete fixture.doc.animations;
  const log = gpu.record(() => {
    const model = gltf.parseGLTF(engine, fixture.doc, fixture.buffers); engine.camera.update(4 / 3, true); store.tick(false);
    const view = context(gpu, {samples, shader: wgsl}), lights = new clustered.Clustered({grid: [4, 3, 2]}); lights.setup(engine);
    const run = passes(lights), list = (...l) => l.map(light => ({...light, castShadow}));
    let remove;
    const steps = [() => lights.setLights(list(point)), () => {remove = lights.add(model);}, () => lights.setLights(list(point, spot)), () => {lights.intensityScale = 0.5;},
      () => lights.setLights(list(spot, {...point, position: [0.5, 2, 1]})), () => lights.onDeviceRestored(engine), () => {lights.intensityScale = () => 2;}, () => remove(), () => lights.setLights([])];
    steps.forEach((step, frame) => {step(); view.begin(frame); run(view.c); view.end(); gpu.note('draw', frame); model.draw(view.c, 'beauty', view.c.color, view.c.depth);});
    model.dispose(); lights.dispose();
  });
  engine.dispose();
  return log;
}
// castShadow without LocalShadows: light uploads may differ only in params.z (float 14 of each 16-float light).
const sameExceptOrdinal = (a, b) => {
  if (a[0] !== 'writeBuffer' || b[0] !== 'writeBuffer' || a[3] === b[3]) return false;
  const floats = hex => new Float32Array(Uint8Array.from(Buffer.from(hex, 'hex')).buffer), x = floats(a[3]), y = floats(b[3]);
  return a[1] === b[1] && a[2] === b[2] && x.length === y.length && x.every((v, k) => k % 16 === 14 || Object.is(v, y[k]));
};
let calls = 0, modules = 0, ordinalWrites = 0;
for (const samples of [1, 4]) {
  const expected = await story(baseline, undefined, samples), actual = await story(candidate, undefined, samples);
  assert.ok(expected.some(e => e[0] === 'module' && /clusterLighting\(/.test(e[2].code)) && expected.some(e => e[0] === 'context' && /clusterLighting\(i\.clip/.test(e[1])), 'story must light the gltf-pro model and patch core\'s shader');
  assert.deepEqual(actual, expected, `clustered GPU calls differ at ${samples}x`);
  const shadowed = await story(candidate, true, samples);
  assert.equal(shadowed.length, expected.length);
  shadowed.forEach((entry, i) => {if (sameExceptOrdinal(entry, expected[i])) ordinalWrites++; else assert.deepEqual(entry, expected[i], `castShadow without LocalShadows changed call ${i}`);});
  calls += expected.length; modules += expected.filter(e => e[0] === 'module').length;
}
assert.ok(ordinalWrites > 0, 'castShadow writes its ordinal');
console.log(JSON.stringify({package: 'clustered', baseline: ref, identicalCalls: calls, shaderModules: modules, castShadowWithoutLocalShadows: {differingWrites: ordinalWrites, difference: 'params.z of the light buffer only'}}));
