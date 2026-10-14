// Proof for @margoengine/creative (PostProcessing): the linear-output shader patch is cached per source string instead of
// re-running a regular expression over the scene shader every frame. Particles, grass, planet and toon are unchanged.
// Run: node examples/package-benchmarks/proofs/creative.proof.js
import assert from 'node:assert/strict';
import {versions, time, record} from './compare.js';
import {mockGPU, passes, context} from './gpu-recorder.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';

// Built from post.ts: the package index also pulls in .wgsl?raw files, which the harness cannot load from a Git ref.
// The candidate is pinned to 3319317, the last commit before bloom and the sky backdrop left PostProcessing.
const ref = 'f05414a', {baseline, candidate} = await versions('creative', ref, 'src/post.ts', '3319317');

function scene(module, samples, options) {
  const gpu = mockGPU(), engine = {gpu: gpu.device}, post = new module.PostProcessing(options); post.setup(engine);
  const run = passes(post), view = context(gpu, {samples, shader: wgsl});
  function frame(index) {
    view.begin(index);
    try {run(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);}
    view.end();
  }
  return {gpu, engine, post, state: view.state, frame};
}

function story(module, samples) {
  const s = scene(module, samples, {bloom: 0.6, atmosphere: {sky: true, density: 0.02}});
  return s.gpu.record(() => {
    for (let i = 0; i < 26; i++) {
      if (i === 4) {s.state.width = 1920; s.state.height = 1080;}        // resize
      if (i === 7) s.post.options.exposure = 1;                           // option changes
      if (i === 9) s.post.options.bloom = 0; if (i === 11) s.post.options.bloom = 1;
      if (i === 13) s.state.depthFormat = 'depth32float';                 // new capture target
      if (i === 15) s.state.shader = wgsl + '\n// variant';               // another plugin changed the shader
      if (i === 17) s.state.shader = wgsl;
      if (i === 19) s.state.shader = 'not the core shader';               // passes through unpatched, as before
      if (i === 20) s.state.shader = wgsl;
      s.state.singular = i === 22;                                        // capture throws, the next frame recovers
      if (i === 24) s.post.onDeviceRestored(s.engine);                    // device restoration
      s.frame(i);
    }
    s.post.dispose();
  });
}
for (const samples of [1, 4]) {
  const expected = story(baseline, samples), actual = story(candidate, samples);
  assert.ok(expected.length > 400 && expected.some(entry => entry[0] === 'throw'), 'story must exercise the GPU and the error path');
  assert.deepEqual(actual, expected, `PostProcessing GPU calls differ at ${samples}x`);
}

const cases = [], frames = 10000;
for (const [label, samples, options] of [['PostProcessing with bloom and sky, 4x MSAA', 4, {bloom: 0.6, atmosphere: {sky: true, density: 0.02}}], ['PostProcessing grade only, 1x', 1, {}]]) {
  const a = scene(baseline, samples, options), b = scene(candidate, samples, options); let ia = 0, ib = 0;
  cases.push({case: label, frames, ...time(() => {for (let i = 0; i < frames; i++) a.frame(ia++);}, () => {for (let i = 0; i < frames; i++) b.frame(ib++);})});
}
await record('creative', ref, cases, 'PostProcessing only. Mock WebGPU device: identical call sequence, descriptors and buffer bytes over a 26-frame story (resize, option/shader changes, error recovery, device restoration) at 1x and 4x. Times are CPU-side JavaScript only.');
