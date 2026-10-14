// Proof that orthographic world-unit widths leave perspective lines unchanged: every GPU call, descriptor and buffer
// write of a 30-frame story (pixel and world widths, dashes, vertex colors, on-top, resize, MSAA, depth format, add,
// remove, device restore) matches the package at `ref`, byte for byte.
// Run: node examples/package-benchmarks/proofs/lines-perspective.proof.js [ref]
import assert from 'node:assert/strict';
import {versions} from './compare.js';
import {mockGPU, passes, context} from './gpu-recorder.js';

const ref = process.argv[2] ?? '96edc75', {baseline, candidate} = await versions('lines', ref);

function story(module, samples) {
  const gpu = mockGPU(), engine = {backend: 'webgpu', gpu: gpu.device, canvas: {clientWidth: 640}};
  const lines = new module.Lines(); lines.setup(engine);
  const strip = lines.add(new module.Line({positions: [-1, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, -1], width: 0.2, worldUnits: true, join: 'miter'}));
  const loop = lines.add(new module.Line({positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], mode: 'loop', colors: [1, 0, 0, 0, 1, 0, 0, 0, 1], width: 3, dashed: true, dashSize: 0.2, gapSize: 0.1}));
  const pairs = new module.Line({positions: [0, 0, 0, 0, 2, 0, 1, 0, 0, 1, 0, 3], mode: 'segments', width: 0.05, worldUnits: true, cap: 'square', onTop: true});
  const run = passes(lines), view = context(gpu, {samples});
  return gpu.record(() => {
    for (let i = 0; i < 30; i++) {
      if (i === 3) lines.add(pairs);
      if (i === 5) {view.state.width = 1920; view.state.height = 1080;}
      if (i === 8) strip.material.width = 0.5;
      if (i === 10) loop.material.set({worldUnits: true, width: 0.1, antialias: false});
      if (i === 12) strip.setPositions([0, 0, 0, 3, 0, 0, 3, 3, 0, 0, 3, 3, -2, 1, 0]);
      if (i === 14) view.state.depthFormat = 'depth32float';
      if (i === 16) lines.remove(loop);
      if (i === 18) pairs.material.onTop = false;
      if (i === 20) lines.onDeviceRestored(engine);
      if (i === 22) {strip.visible = false; lines.add(loop);}
      if (i === 25) strip.visible = true;
      view.begin(i); run(view.c); view.end();
      gpu.note('stats', {...lines.stats});
    }
    lines.dispose();
  });
}
let entries = 0;
for (const samples of [1, 4]) {
  const expected = story(baseline, samples), actual = story(candidate, samples);
  assert.ok(expected.length > 300 && expected.filter(entry => entry[0] === 'pass.draw').length > 60, 'story must draw');
  assert.deepEqual(actual, expected, `lines GPU calls differ at ${samples}x`);
  entries += expected.length;
}
console.log(JSON.stringify({package: 'lines', baseline: ref, identicalCalls: entries, writes: 'byte-identical'}));
