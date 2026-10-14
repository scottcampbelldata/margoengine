// Proof for the PostStack change: every effect used alone (post Bloom and SSAO, dof, tonemap alone and DOF-sourced,
// creative PostProcessing) makes exactly the GPU calls it made before, over a story of resizes, option edits, format
// and sample-count changes, a rejected frame, device restoration and disposal at 1x and 4x.
// Run: node examples/package-benchmarks/proofs/post-stack.proof.js [ref]
import assert from 'node:assert/strict';
import {versions} from './compare.js';
import {mockGPU, context} from './gpu-recorder.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';

const ref = process.argv[2] ?? 'd81a279';
const post = await versions('post', ref), dof = await versions('dof', ref), tonemap = await versions('tonemap', ref), creative = await versions('creative', ref, 'src/post.ts');

/** Runs `effects` (made by `make(gpu)`) with the core main pass for 24 frames, applying `edit(frame, effects, state)` first. */
function story(make, samples, edit) {
  const gpu = mockGPU(), engine = {gpu: gpu.device, hasPlugin: () => false, removePlugin() {}}, view = context(gpu, {samples, shader: wgsl, format: 'bgra8unorm'});
  return gpu.record(() => {
    const effects = make(engine), list = [{order: 0, execute: c => c.draw()}];
    for (const effect of effects) {effect.setup(engine); effect.registerPasses({add: pass => list.push(pass)});}
    list.sort((a, b) => a.order - b.order);
    for (let i = 0; i < 24; i++) {
      if (i === 4) {view.state.width = 640; view.state.height = 360;}
      if (i === 9) view.state.depthFormat = 'depth32float';
      if (i === 12) view.state.samples = samples === 4 ? 1 : 4;
      if (i === 14) view.state.format = 'rgba8unorm';
      if (i === 18) for (const effect of effects) effect.onDeviceRestored(engine);
      edit(i, effects, view.state);
      view.begin(i);
      try {for (const pass of list) pass.execute(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);}
      view.end();
    }
    for (const effect of effects) effect.dispose();
  });
}
const cases = {
  'post Bloom': [m => [new m.Bloom({strength: 0.6})], (i, [e]) => {if (i === 6) e.options.threshold = 2; if (i === 16) e.options.strength = 9; if (i === 17) e.options.strength = 1;}, post],
  'post SSAO': [m => [new m.SSAO()], (i, [e]) => {if (i === 6) e.options.radius = 2; if (i === 8) e.enabled = false; if (i === 10) e.enabled = true; if (i === 16) e.options.samples = 0; if (i === 17) e.options.samples = 8;}, post],
  'dof DOF': [m => [new m.DOF({aperture: 2})], (i, [e]) => {if (i === 6) e.options.focalDistance = 8; if (i === 8) e.enabled = false; if (i === 16) e.options.aperture = -1; if (i === 17) e.options.aperture = 4;}, dof],
  'tonemap Tonemap': [m => [new m.Tonemap({curve: 'neutral'})], (i, [e]) => {if (i === 6) e.options.exposure = 1; if (i === 8) e.options.curve = 'acescg'; if (i === 16) e.options.contrast = 9; if (i === 17) e.options.contrast = 1;}, tonemap],
  'creative PostProcessing': [m => [new m.PostProcessing({bloom: 0.5, atmosphere: {sky: true, density: 0.1}})], (i, [e]) => {if (i === 6) e.options.bloom = 0; if (i === 8) e.options.bloom = 1; if (i === 16) e.options.grain = 2; if (i === 17) e.options.grain = 0.1;}, creative],
};
let calls = 0;
for (const [label, [make, edit, module]] of Object.entries(cases)) for (const samples of [1, 4]) {
  const expected = story(() => make(module.baseline), samples, edit), actual = story(() => make(module.candidate), samples, edit);
  assert.ok(expected.length > 300 && expected.some(entry => entry[0] === 'throw'), `${label} story must exercise the GPU and an error path`);
  assert.deepEqual(actual, expected, `${label} GPU calls differ at ${samples}x`); calls += expected.length;
}
// The documented DOF -> Tonemap({source}) chain, both packages at once.
for (const samples of [1, 4]) {
  const chain = side => story(() => {const d = new dof[side].DOF(); return [d, new tonemap[side].Tonemap({source: () => d.outputTexture})];}, samples, () => {});
  const expected = chain('baseline'); assert.deepEqual(chain('candidate'), expected, `DOF -> Tonemap chain differs at ${samples}x`); calls += expected.length;
}
console.log(`Single-effect GPU call sequences identical to ${ref}: ${calls} recorded calls across 12 stories.`);
