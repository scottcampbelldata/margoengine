// Proof for @margoengine/splats: the per-frame uniform packing, the 33 compute dispatches and the draw pass no longer
// allocate arrays, closures, key strings or descriptors. (The depth sort itself runs on the GPU and is untouched.)
// Run: node examples/package-benchmarks/proofs/splats.proof.js
import assert from 'node:assert/strict';
import {versions, time, record} from './compare.js';
import {mockGPU, passes, context} from './gpu-recorder.js';

const ref = 'f05414a', {baseline, candidate} = await versions('splats', ref);

function cloud(count, bands) {
  const positions = new Float32Array(count * 3), covariances = new Float32Array(count * 6), colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    positions.set([Math.sin(i) * 5, Math.cos(i * 1.3) * 2, Math.sin(i * 0.7) * 5], i * 3);
    covariances.set([0.02 + i % 7 * 0.001, 0, 0, 0.03, 0, 0.01], i * 6); colors.set([i % 5 / 4, i % 3 / 2, 0.5, 0.25 + i % 4 / 8], i * 4);
  }
  return {positions, covariances, colors, sphericalHarmonics: bands ? Float32Array.from({length: count * 3 * bands}, (_, i) => Math.sin(i) * 0.1) : undefined};
}

function scene(module, samples, count, bands) {
  const gpu = mockGPU(), engine = {gpu: gpu.device, stats: {drawCalls: 0}, removePlugin() {}}, splats = new module.Splats(cloud(count, bands)); splats.setup(engine);
  const run = passes(splats), view = context(gpu, {samples});
  function frame(index) {
    view.begin(index);
    try {run(view.c);} catch (error) {gpu.note('throw', error.constructor.name, error.message);}
    view.end(); gpu.note('stats', engine.stats.drawCalls);
  }
  return {gpu, engine, splats, state: view.state, camera: view.camera, frame};
}

function story(module, samples, bands) {
  const s = scene(module, samples, 1000, bands);
  return s.gpu.record(() => {
    for (let i = 0; i < 24; i++) {
      if (i === 4) {s.state.width = 1920; s.state.height = 1080;}        // resize: focal length and viewport change
      if (i === 7) s.camera.fov = 40;
      if (i === 9) s.state.depthFormat = 'depth32float';                  // no stencil aspect: different pipeline and depth attachment
      if (i === 12) s.state.depthFormat = 'depth24plus-stencil8';         // back to a cached pipeline
      if (i === 14) s.state.format = 'bgra8unorm'; if (i === 16) s.state.format = 'rgba16float';
      if (i === 18) s.camera.target = s.camera.position;                  // zero-length view throws, the next frame recovers
      if (i === 19) s.camera.target = [0, 0, 0];
      if (i === 21) s.splats.onDeviceRestored(s.engine);                  // device restoration
      s.frame(i);
    }
    s.splats.dispose();
  });
}
for (const [samples, bands] of [[1, 0], [4, 4], [4, 16]]) {
  const expected = story(baseline, samples, bands), actual = story(candidate, samples, bands);
  assert.ok(expected.length > 3000 && expected.some(entry => entry[0] === 'throw'), 'story must exercise the GPU and the error path'); assert.deepEqual(actual, expected, `Splats GPU calls differ at ${samples}x, ${bands} SH bands`);
}

const cases = [], frames = 2000;
for (const [label, samples, count, bands] of [['100,000 splats with SH, 4x MSAA', 4, 100000, 4], ['20,000 splats, 1x', 1, 20000, 0]]) {
  const a = scene(baseline, samples, count, bands), b = scene(candidate, samples, count, bands); let ia = 0, ib = 0;
  cases.push({case: label, frames, ...time(() => {for (let i = 0; i < frames; i++) a.frame(ia++);}, () => {for (let i = 0; i < frames; i++) b.frame(ib++);})});
}
await record('splats', ref, cases, 'Mock WebGPU device: identical call sequence, descriptors and buffer bytes over a 24-frame story (resize, projection/format changes, error, device restoration). Times are CPU-side JavaScript only; the GPU radix sort is not measured.');
