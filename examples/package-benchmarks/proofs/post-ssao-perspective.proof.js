// Proof that orthographic SSAO and the margoAmbient (IBL) replay leave perspective SSAO unchanged: every GPU call,
// descriptor and buffer write of a 30-frame story (resize, option changes, toggles, MSAA, depth format, shader
// variants, a rejected shader, a singular camera, device restore) matches the package at `ref`. The only accepted
// difference is the occlusion shader's no-surface test (w<=0 -> w==0, neighbour >0 -> !=0), equivalent under a
// perspective camera because every written w is the view depth beyond a positive near plane.
// Run: node examples/package-benchmarks/proofs/post-ssao-perspective.proof.js [ref]
import assert from 'node:assert/strict';
import {versions} from './compare.js';
import {mockGPU, passes, context} from './gpu-recorder.js';
import {wgsl} from '../../../packages/core/src/shaders.ts';

const ref = process.argv[2] ?? '12bf774', {baseline, candidate} = await versions('post', ref);
const signed = code => code.replace('if(data.w<=0||', 'if(data.w==0||').replace('if(neighbor>0){', 'if(neighbor!=0){');

function story(module, samples) {
  const gpu = mockGPU(), engine = {gpu: gpu.device, hasPlugin: () => false, removePlugin() {}};
  const ssao = new module.SSAO({radius: 0.5}); ssao.setup(engine);
  for (let i = 0; i < 2; i++) ssao.add({draw(c, mode, color, depth) {gpu.note('source', i, mode, color, depth);}});
  const run = passes(ssao), view = context(gpu, {samples, shader: wgsl}), taa = {binding: 8, resource: {buffer: gpu.device.createBuffer({size: 64, usage: GPUBufferUsage.UNIFORM})}};
  return gpu.record(() => {
    for (let i = 0; i < 30; i++) {
      if (i === 4) {view.state.width = 1920; view.state.height = 1080;}
      if (i === 7) ssao.options.radius = 1.5;
      if (i === 9) ssao.enabled = false; if (i === 11) ssao.enabled = true;
      if (i === 13) ssao.options.samples = 16;
      if (i === 15) view.state.depthFormat = 'depth32float';
      if (i === 17) view.state.shader = wgsl + '\n// variant';
      if (i === 19) view.state.shader = wgsl;
      if (i === 21) view.state.shader = 'not the core shader';
      if (i === 22) view.state.shader = wgsl;
      view.state.singular = i === 24;
      if (i === 26) ssao.onDeviceRestored(engine);
      view.begin(i); view.c.bindings.push({binding: 1, resource: taa.resource}, taa);
      try {run(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);}
      view.end();
    }
    ssao.dispose();
  });
}
let entries = 0, shaders = 0;
for (const samples of [1, 4]) {
  const expected = story(baseline, samples), actual = story(candidate, samples);
  assert.ok(expected.length > 500 && expected.filter(entry => entry[0] === 'throw').length === 2, 'story must exercise the GPU and both error paths');
  for (const entry of expected) if (entry[0] === 'module' && entry[2].code !== signed(entry[2].code)) {entry[2] = {...entry[2], code: signed(entry[2].code)}; shaders++;}
  assert.deepEqual(actual, expected, `SSAO GPU calls differ at ${samples}x`);
  entries += expected.length;
}
assert.ok(shaders > 0, 'the occlusion shader was compared');
console.log(JSON.stringify({package: 'post', baseline: ref, identicalCalls: entries, writes: 'byte-identical', normalizedShaderModules: shaders}));
