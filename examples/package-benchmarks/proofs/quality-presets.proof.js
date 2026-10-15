// Proof for tier presets (HANDOFF 5i.b): every package that reads `globalThis.margoPreset` (set by @margoengine/quality)
// 1. records exactly the GPU calls it made at `ref` when no preset is set (apps without the quality package: unchanged),
// 2. with the light preset set, records exactly the calls of the same story given the preset's values as options
//    (the preset only fills options), and those differ from the defaults (the preset is visible on the GPU),
// 3. with the light preset set and every preset key passed explicitly, records exactly the calls without the preset
//    (explicit options always win).
// Story per package: setup on a core Engine over the recording mock GPU, 8 frames at 1x and 4x MSAA with a resize and a
// device restore, then dispose.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/quality-presets.proof.js [ref]
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {versions} from './compare.js';
import {mockGPU, context} from './gpu-recorder.js';
import {Engine, TransformStore} from '../../../packages/core/dist/extension.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';
import {Clustered} from '../../../packages/clustered/dist/index.js';
import {Tonemap} from '../../../packages/tonemap/dist/index.js';
import {QUALITY_PRESETS} from '../../../packages/quality/dist/index.js';

const ref = process.argv[2] ?? '96daac7', light = QUALITY_PRESETS.light;
const point = {position: [0, 2, 1], range: 6, intensity: 9, castShadow: true}, spot = {position: [1, 3, 0], range: 8, direction: [0, -1, 0.2], outerAngle: 0.6, intensity: 20, castShadow: true};
// key: [package, entry, make(module, options) -> effects (the measured one last), base options, explicit values for every preset key]
const cases = {
  shadows: ['shadows', 'src/index.ts', (m, o) => [new m.Shadows(o)], {distance: 80}, {resolution: 2048}],
  ssao: ['post', 'src/index.ts', (m, o) => [new m.SSAO(o)], {radius: 0.4}, {samples: 32}],
  ssr: ['post', 'src/index.ts', (m, o) => [new m.PostStack([new m.SSR(o)])], {maxDistance: 50}, {enabled: true, steps: 64}],
  volumetric: ['environment', 'src/volumetric.ts', (m, o) => [new Tonemap(), new m.VolumetricFog(o)], {density: 0.03}, {grid: [160, 90, 64]}],
  localShadows: ['clustered', 'src/shadows.ts', (m, o) => {const lights = new Clustered({grid: [4, 3, 2]}); return [lights, new m.LocalShadows({...o, lights})];}, {bias: 1}, {maxLights: 4, resolution: 512}],
  vfx: ['vfx', 'src/index.ts', (m, o) => [new m.VFX(o)], {rate: 1000, initialCount: 50_000}, {capacity: 1_000_000}],
};

async function story(make, samples, preset) {
  const gpu = mockGPU(), store = await TransformStore.create(32), canvas = {width: 128, height: 96, clientWidth: 128, clientHeight: 96};
  const renderer = {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine(canvas, store, renderer, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  if (preset) globalThis.margoPreset = preset; else delete globalThis.margoPreset;
  try {
    const log = gpu.record(() => {
      engine.camera.update(4 / 3, true); store.tick(false);
      const view = context(gpu, {samples, shader: wgsl, format: 'bgra8unorm'}), list = [{order: 0, execute: c => c.draw()}], effects = make();
      for (const effect of effects) {effect.setup(engine); effect.registerPasses?.({add: pass => list.push(pass)});}
      effects[0].setLights?.([point, spot]); list.sort((a, b) => a.order - b.order);
      for (let i = 0; i < 8; i++) {
        if (i === 3) {view.state.width = 96; view.state.height = 64;}
        if (i === 5) for (const effect of effects) effect.onDeviceRestored?.(engine);
        view.begin(i);
        try {for (const pass of list) pass.execute(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);}
        view.end();
      }
      for (const effect of effects.reverse()) effect.dispose();
    });
    return log;
  } finally {delete globalThis.margoPreset; engine.dispose();}
}

const report = {baseline: ref, recordedAt: new Date().toISOString(), preset: light, packages: {}};
for (const [key, [name, entry, make, base, explicit]] of Object.entries(cases)) {
  const {baseline, candidate} = await versions(name, ref, entry), row = report.packages[key] = {package: name, entry, calls: 0};
  for (const samples of [1, 4]) {
    const run = (module, options, preset) => story(() => make(module, options), samples, preset);
    const defaults = await run(baseline, base);
    assert.ok(defaults.length > 30 && !defaults.some(e => e[0] === 'throw'), `${key} story must exercise the GPU without errors`);
    assert.deepEqual(await run(candidate, base), defaults, `${key}: GPU calls without a preset differ from ${ref} at ${samples}x`);
    const filled = await run(candidate, base, light);
    assert.deepEqual(filled, await run(candidate, {...base, ...light[key]}), `${key}: the preset must act exactly like passing its values`);
    assert.notDeepEqual(filled, defaults, `${key}: the light preset changes nothing on the GPU`);
    assert.deepEqual(await run(candidate, {...base, ...explicit}, light), await run(candidate, {...base, ...explicit}), `${key}: explicit options must win over the preset`);
    row.calls += defaults.length; row[`presetCalls${samples}x`] = filled.length;
  }
}
// VFX: an explicit initialCount above the preset capacity keeps the default capacity instead of throwing.
{
  const {candidate} = await versions('vfx', ref), options = {initialCount: 500_000};
  assert.deepEqual(await story(() => [new candidate.VFX(options)], 1, light), await story(() => [new candidate.VFX(options)], 1), 'vfx: explicit initialCount over the preset capacity');
  report.packages.vfx.initialCountOverPreset = 'identical to no preset';
}
const out = resolve(import.meta.dirname, 'results/quality-presets.json');
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.packages).map(([k, v]) => [k, v.calls]))), 'recorded calls identical to', ref, 'without a preset; wrote', out);
