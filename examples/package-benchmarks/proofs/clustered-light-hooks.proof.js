// Proof that clustered's light-loop hooks (`@margoengine/clustered/directional`, `/ies` and `/projector`) change nothing for
// apps that do not use them: clustered's root gained the `directional`, `ies` and `projector` slots, a 7th argument of
// `clusteredSampling`, the light list getter and a general bind group join. The area-lights story (9 frames: lights set, moved,
// a gltf-pro model added and removed, intensity scale changed, MSAA 1x/4x, device restored) records every GPU call,
// descriptor, shader module and buffer write of clustered (core-mesh shader patch and compute pass) and of a gltf-pro model
// it lights: identical at `ref` and in the working tree, without the entries and with each attached but empty (each creates
// its buffer and hook only once it has something to draw).
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/clustered-light-hooks.proof.js [ref] [pin] [--current]
// Pinned: 6c20076d against b4700864, the series' last code commit; --current: 57250a49 against the working tree.
import assert from 'node:assert/strict';
import { refs, versions, entryAt, golden } from './compare.js';
import { mockGPU, context, passes } from './gpu-recorder.js';
import { Engine, TransformStore } from '../../../packages/core/dist/extension.js';
import { wgsl } from '../../../packages/core/src/shaders.ts';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

const { ref, pin } = refs('6c20076d', 'b4700864', 'da12bd07e');
const { baseline, candidate } = await versions('clustered', ref, undefined, pin);
const gltf = await entryAt('gltf-pro', 'src/index.ts', pin),
  { DirectionalLights } = await entryAt('clustered', 'src/directional.ts', pin),
  { IESLights, parseIES } = await entryAt('clustered', 'src/ies.ts', pin),
  { ProjectorLights } = await entryAt('clustered', 'src/projector.ts', pin);
const slide = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) };
const downlight = parseIES(
  ['IESNA:LM-63-2002', 'TILT=NONE', '1 -1 1 3 1 1 2 0 0 0', '1 1 10', '0 45 90', '0', '1000 600 0'].join('\n'),
);
const point = { position: [0, 2, 1], range: 6, color: [1, 0.5, 0.2], intensity: 9 },
  spot = { position: [1, 3, 0], range: 8, direction: [0, -1, 0.2], outerAngle: 0.6, innerAngle: 0.3, intensity: 20 };
// Each hook: attach it to `lights`, and fill it (lit) or leave it empty; `marker` is WGSL its lit shaders must contain.
const hooks = [
  {
    name: 'directional',
    attach: (lights) => new DirectionalLights({ lights }),
    fill: (hook, lit) => hook.setLights(lit ? [{ direction: [0, -1, -0.5], intensity: 2 }] : []),
    marker: /clusterDirectional\.lights\[j\]/,
  },
  {
    name: 'ies',
    attach: (lights) => new IESLights({ lights }),
    fill: (hook, lit) => hook.setProfiles(lit ? [downlight, downlight] : [null]),
    marker: /\*clusterIes\(index,light,l\)/,
  },
  {
    name: 'projector',
    attach: (lights) => new ProjectorLights({ lights }),
    fill: (hook, lit) => hook.setProjectors(lit ? [null, slide] : []),
    marker: /\*clusterProjector\(index,light,position\)/,
  },
];

async function story(clustered, mode, samples) {
  const gpu = mockGPU(),
    store = await TransformStore.create(32),
    canvas = { width: 128, height: 96, clientWidth: 128, clientHeight: 96 };
  const renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(canvas, store, renderer, { position: [0, 0, 4], target: [0, 0, 0] }, null);
  const fixture = animatedTriangle();
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  const log = gpu.record(() => {
    const model = gltf.parseGLTF(engine, fixture.doc, fixture.buffers);
    engine.camera.update(4 / 3, true);
    store.tick(false);
    const view = context(gpu, { samples, shader: wgsl }),
      lights = new clustered.Clustered({ grid: [4, 3, 2] });
    lights.setup(engine);
    const attached = mode ? hooks.map((hook) => [hook, hook.attach(lights)]) : [];
    for (const [hook, plugin] of attached) {
      plugin.setup(engine);
      hook.fill(plugin, mode === 'lit');
    }
    const run = [passes(lights), ...attached.map(([, plugin]) => passes(plugin))];
    let remove;
    const steps = [
      () => lights.setLights([point]),
      () => {
        remove = lights.add(model);
      },
      () => lights.setLights([point, spot]),
      () => {
        lights.intensityScale = 0.5;
      },
      () => lights.setLights([spot, { ...point, position: [0.5, 2, 1] }]),
      () => {
        lights.onDeviceRestored(engine);
        for (const [, plugin] of attached) plugin.onDeviceRestored(engine);
      },
      () => {
        lights.intensityScale = () => 2;
      },
      () => remove(),
      () => lights.setLights([]),
    ];
    steps.forEach((step, frame) => {
      step();
      for (const [hook, plugin] of attached) hook.fill(plugin, mode === 'lit');
      view.begin(frame);
      for (const r of run) r(view.c);
      view.end();
      gpu.note('draw', frame);
      model.draw(view.c, 'beauty', view.c.color, view.c.depth);
    });
    model.dispose();
    for (const [, plugin] of attached) plugin.dispose();
    lights.dispose();
  });
  engine.dispose();
  return log;
}
let calls = 0,
  modules = 0;
for (const samples of [1, 4]) {
  const expected = await golden(`${samples}x`, () => story(baseline, false, samples));
  assert.ok(
    expected.some((e) => e[0] === 'module' && /clusterLighting\(/.test(e[2].code)) &&
      expected.some((e) => e[0] === 'context' && /clusterLighting\(i\.clip/.test(e[1])),
    "story must light the gltf-pro model and patch core's shader",
  );
  assert.deepEqual(await story(candidate, false, samples), expected, `clustered GPU calls differ at ${samples}x`);
  assert.deepEqual(
    await story(candidate, 'empty', samples),
    expected,
    `empty light hooks changed GPU calls at ${samples}x`,
  );
  const lit = await story(candidate, 'lit', samples);
  for (const hook of hooks)
    assert.ok(
      lit.some((e) => e[0] === 'module' && hook.marker.test(e[2].code)) &&
        lit.some((e) => e[0] === 'context' && hook.marker.test(e[1])),
      `${hook.name} reaches both shaders`,
    );
  calls += expected.length;
  modules += expected.filter((e) => e[0] === 'module').length;
}
console.log(
  JSON.stringify({
    package: 'clustered',
    baseline: ref,
    identicalCalls: calls,
    shaderModules: modules,
    emptyHooks: hooks.map((hook) => hook.name),
  }),
);
