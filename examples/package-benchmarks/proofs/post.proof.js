// Proof for @margoengine/post (SSAO): the two shader patches are cached per source string, and pass descriptors and
// uniform packing are reused instead of rebuilt each frame. Bloom and SceneFade are unchanged.
// Run: node examples/package-benchmarks/proofs/post.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/post.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import {refs, versions, time, record} from './compare.js';
import {mockGPU, passes, context} from './gpu-recorder.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';

const {ref, pin} = refs('f05414a', 'f47ff3f'), {baseline, candidate} = await versions('post', ref, undefined, pin);

function scene(module, samples, sources) {
  const gpu = mockGPU(), engine = {gpu: gpu.device, hasPlugin: () => false, removePlugin() {}};
  const ssao = new module.SSAO({radius: 0.5}); ssao.setup(engine);
  for (let i = 0; i < sources; i++) ssao.add({draw(c, mode, color, depth) {gpu.note('source', i, mode, color, depth);}});
  const run = passes(ssao), view = context(gpu, {samples, shader: wgsl}), taaCamera = {binding: 8, resource: {buffer: gpu.device.createBuffer({size: 64, usage: GPUBufferUsage.UNIFORM})}};
  function frame(index) {
    view.begin(index); view.c.bindings.push({binding: 1, resource: taaCamera.resource}, taaCamera);
    try {run(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);}
    view.end();
  }
  return {gpu, engine, ssao, camera: view.camera, state: view.state, frame};
}

function story(module, samples) {
  const s = scene(module, samples, 2);
  return s.gpu.record(() => {
    for (let i = 0; i < 30; i++) {
      if (i === 4) {s.state.width = 1920; s.state.height = 1080;}        // resize
      if (i === 7) s.ssao.options.radius = 1.5;                           // option changes
      if (i === 9) s.ssao.enabled = false; if (i === 11) s.ssao.enabled = true;
      if (i === 13) s.ssao.options.samples = 16;
      if (i === 15) s.state.depthFormat = 'depth32float';                 // new capture targets
      if (i === 17) s.state.shader = wgsl + '\n// variant';               // another plugin changed the shader: new ambient pipeline
      if (i === 19) s.state.shader = wgsl;
      if (i === 21) s.state.shader = 'not the core shader';               // rejected with the same error
      if (i === 22) s.state.shader = wgsl;
      s.state.singular = i === 24;                                        // capture throws, the next frame recovers
      if (i === 26) s.ssao.onDeviceRestored(s.engine);                    // device restoration
      s.frame(i);
    }
    s.ssao.dispose();
  });
}
for (const samples of [1, 4]) {
  const expected = story(baseline, samples), actual = story(candidate, samples);
  assert.ok(expected.length > 500 && expected.filter(entry => entry[0] === 'throw').length === 2, 'story must exercise the GPU and both error paths');
  assert.deepEqual(actual, expected, `SSAO GPU calls differ at ${samples}x`);
}

const cases = [], frames = 2000;
for (const [label, samples, sources] of [['SSAO frame, 4x MSAA', 4, 0], ['SSAO frame, 1x', 1, 0], ['SSAO frame with 4 replay sources, 4x MSAA', 4, 4]]) {
  const a = scene(baseline, samples, sources), b = scene(candidate, samples, sources); let ia = 0, ib = 0;
  cases.push({case: label, frames, ...time(() => {for (let i = 0; i < frames; i++) a.frame(ia++);}, () => {for (let i = 0; i < frames; i++) b.frame(ib++);})});
}
await record('post', ref, cases, 'SSAO only. Mock WebGPU device: identical call sequence, descriptors and buffer bytes over a 30-frame story (resize, option/shader changes, rejected shader, error recovery, device restoration) at 1x and 4x. Times are CPU-side JavaScript only.', pin);
