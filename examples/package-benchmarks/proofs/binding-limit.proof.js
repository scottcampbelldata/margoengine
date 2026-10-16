// Proof for HANDOFF 5c (environment's BRDF LUT moved from a texture to a storage buffer; gltf-pro names the combination when
// a shader declares more sampled textures or samplers than the device allows). The 14-frame story of
// gltf-pro-lighting-hooks.proof.js (shadows, clustered, environment IBL, fog and a text-patching effect added, removed and
// reordered; HDR and canvas targets; MSAA 1x/4x; beauty, SSAO-ambient and G-buffer draws; standard, physical, unlit and
// blended materials) records every GPU call of gltf-pro + shadows + clustered + environment at `ref` and in the working tree.
// Without IBL: identical. With IBL: identical once the intended change is mapped back (the IBL WGSL: LUT declaration,
// iblBrdfTerms, iblShade's arguments; and the LUT bind group entry, a view before, a buffer binding now).
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/binding-limit.proof.js [ref] [pin]
// Pinned: e017d50 against f8a36ca, the 5c commit that made this claim, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import { refs, versions } from './compare.js';
import { mockGPU, context } from './gpu-recorder.js';
import { Engine, TransformStore } from '../../../packages/core/dist/extension.js';
import { animatedTriangle } from '../../../tests/support/gltf-pro-fixture.js';

const { ref, pin } = refs('e017d50', 'f8a36ca');
const all = await Promise.all(
  ['gltf-pro', 'shadows', 'clustered', 'environment'].map((name) => versions(name, ref, undefined, pin)),
);
const [baseline, candidate] = ['baseline', 'candidate'].map((k) => all.map((v) => v[k]));
const materials = [
  { alphaMode: 'OPAQUE' },
  { alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5] } },
  { extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } } },
  { extensions: { KHR_materials_unlit: {} } },
];

async function story([gltf, shadowsModule, clusteredModule, environment], samples, withIbl) {
  const gpu = mockGPU(),
    store = await TransformStore.create(32),
    canvas = { width: 128, height: 96, clientWidth: 128, clientHeight: 96 };
  const renderer = { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} };
  const engine = new Engine(canvas, store, renderer, { position: [0, 0, 4], target: [0, 0, 0] }, null);
  const fixture = animatedTriangle(),
    primitive = fixture.doc.meshes[0].primitives[0];
  fixture.doc.materials = materials;
  fixture.doc.extensionsUsed = ['KHR_materials_clearcoat', 'KHR_materials_unlit'];
  fixture.doc.meshes = materials.map((_, material) => ({ primitives: [{ ...primitive, material }] }));
  fixture.doc.nodes = materials.map((_, mesh) => ({ mesh, translation: [0, 0, -mesh] }));
  delete fixture.doc.skins;
  delete fixture.doc.animations;
  const lut = {},
    environmentStub = {
      device: gpu.device,
      disposed: false,
      version: 0,
      specularView: {},
      sampler: {},
      brdfLutView: lut,
      brdfLut: lut,
      shBuffer: {},
      paramsBuffer: {},
      restore: () => Promise.resolve(),
    };
  const log = gpu.record(() => {
    const model = gltf.parseGLTF(engine, fixture.doc, fixture.buffers);
    engine.camera.update(4 / 3, true);
    store.tick(false);
    const view = context(gpu, { samples, format: 'rgba16float', depthFormat: 'depth32float-stencil8' });
    const shadows = new shadowsModule.Shadows({ resolution: 64 }),
      clustered = new clusteredModule.Clustered({ grid: [4, 3, 2] });
    const ibl = new environment.EnvironmentLighting(environmentStub),
      fog = new environment.Fog({ color: '#9ab', density: 0.05, heightFalloff: 0.2 });
    shadows.setup(engine);
    clustered.setup(engine);
    fog.setup(engine);
    const custom = {
      shader: (source) => '// custom\n' + source.replace('fn ambient(', '// before ambient\nfn ambient('),
      bindings: () => [],
    };
    const removers = new Map(),
      add = (effect, apply) => removers.set(effect, apply()),
      drop = (effect) => {
        removers.get(effect)?.();
        removers.delete(effect);
      };
    const iblStep = (step) => (withIbl ? step : () => {});
    const steps = [
      () => {},
      () => add(shadows, () => shadows.add(model)),
      iblStep(() => add(ibl, () => ibl.applyTo(model))),
      () => add(custom, () => model.addLighting(custom)),
      () => add(clustered, () => clustered.add(model)),
      () => add(fog, () => fog.applyTo(model)),
      () => {
        environmentStub.device = null;
      },
      () => {
        environmentStub.device = gpu.device;
        environmentStub.version++;
      },
      () => drop(shadows),
      () => {
        view.state.format = 'bgra8unorm';
      },
      iblStep(() => drop(ibl)),
      iblStep(() => add(ibl, () => ibl.applyTo(model))),
      () => {
        drop(fog);
        drop(custom);
      },
      () => {
        for (const effect of [...removers.keys()]) drop(effect);
      },
    ];
    steps.forEach((step, frame) => {
      step();
      view.begin(frame);
      for (const mode of ['beauty', 'ambient', 'gbuffer']) {
        gpu.note('draw', frame, mode);
        try {
          model.draw(view.c, mode, view.c.color, view.c.depth);
        } catch (error) {
          gpu.note('throw', error.message);
        }
      }
    });
    model.dispose();
    shadows.dispose();
    clustered.dispose();
    ibl.dispose();
    fog.dispose();
  });
  engine.dispose();
  return log;
}

const [, , , oldEnv] = baseline,
  [, , , newEnv] = candidate;
// The intended change, mapped back: candidate IBL text -> baseline IBL text; LUT bind group entry -> the view it was.
const declaration = ['var<storage,read> iblBrdf:array<u32>;', 'var iblBrdf:texture_2d<f32>;'],
  call = ['iblShade(iblSpecular,iblSampler,iblSh,', 'iblShade(iblSpecular,iblSampler,iblBrdf,iblSh,'];
assert.notEqual(newEnv.IBL_WGSL, oldEnv.IBL_WGSL);
const mapBack = (log) => {
  let json = JSON.stringify(log),
    mapped = 0;
  for (const [from, to] of [
    [JSON.stringify(newEnv.IBL_WGSL).slice(1, -1), JSON.stringify(oldEnv.IBL_WGSL).slice(1, -1)],
    declaration,
    call,
    ['{"binding":22,"resource":{"buffer":{}}}', '{"binding":22,"resource":{}}'],
  ]) {
    const parts = json.split(from);
    mapped += parts.length - 1;
    json = parts.join(to);
  }
  return { log: JSON.parse(json), mapped }; // JSON round trip on both sides (undefined array members become null)
};
const result = { packages: ['gltf-pro', 'shadows', 'clustered', 'environment'], baseline: ref };
for (const withIbl of [false, true]) {
  let calls = 0,
    modules = 0,
    mapped = 0;
  for (const samples of [1, 4]) {
    const recorded = await story(baseline, samples, withIbl),
      expected = withIbl ? JSON.parse(JSON.stringify(recorded)) : recorded,
      raw = await story(candidate, samples, withIbl),
      actual = withIbl ? mapBack(raw) : { log: raw, mapped: 0 };
    assert.ok(
      !expected.some((entry) => entry[0] === 'throw') && !raw.some((entry) => entry[0] === 'throw'),
      'no draw may throw',
    );
    assert.ok(
      expected.some(
        (entry) =>
          entry[0] === 'module' &&
          /shadowLit\(direct/.test(entry[2].code) &&
          /clusterLighting\(/.test(entry[2].code) &&
          /fogAmount\(/.test(entry[2].code) &&
          /\/\/ custom/.test(entry[2].code) &&
          (!withIbl || /let margoAmbient=/.test(entry[2].code)),
      ),
      'story must compose every effect',
    );
    assert.deepEqual(actual.log, expected, `GPU calls differ at ${samples}x ${withIbl ? 'with' : 'without'} IBL`);
    calls += expected.length;
    modules += expected.filter((entry) => entry[0] === 'module').length;
    mapped += actual.mapped;
  }
  if (withIbl) assert.ok(mapped > 0);
  result[withIbl ? 'withIbl' : 'withoutIbl'] = {
    identicalCalls: calls,
    shaderModules: modules,
    ...(withIbl ? { mappedOccurrences: mapped } : {}),
  };
}
console.log(JSON.stringify(result));
