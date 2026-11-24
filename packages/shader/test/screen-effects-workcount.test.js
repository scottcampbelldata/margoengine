import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { load } from '../../../examples/package-benchmarks/proofs/compare.js';
import * as Current from '../dist/effects.js';
const Parent = await load('shader', 'src/effects.ts', '960bb4f9b');
function story(E, samples) {
  const gpu = mockGPU(), view = context(gpu, { samples }), seen = new Set(),
    effects = [E.pixelate({size: 5}), E.rgbShift({amount: 0.01}), E.vignette({darkness: 0.5})],
    begin = gpu.encoder.beginRenderPass;
  gpu.encoder.beginRenderPass = (d) => { seen.add(d); return begin(d); };
  for (const e of effects) e.host = {};
  const log = gpu.record(() => {
    const texture = () => gpu.device.createTexture({size: [1280,720], format: 'rgba8unorm', usage: 20}).createView(),
      inputs = [texture(), texture(), texture(), texture()];
    for (let i = 0; i < 10; i++) {
      view.begin(i);
      if (i === 3) effects[0].uniforms.size.value = 7;
      if (i === 5) view.c.width = 641;
      if (i === 7) for (const e of effects) e.onDeviceRestored();
      for (let j = 0; j < effects.length; j++) effects[j].render(view.c, inputs[j], {
        view: inputs[j+1], format: i > 5 ? 'bgra8unorm' : 'rgba8unorm',
        multisample: {count: i === 6 ? 1 : samples}, hdr: false,
      });
    }
  });
  return {log, descriptors: seen.size};
}
for (const samples of [1,4]) test(`screen effects ${samples}x reuse descriptors with exact GPU commands`, () => {
  const old = story(Parent, samples), next = story(Current, samples);
  assert.equal(old.descriptors, 30);
  assert.equal(next.descriptors, 3, 'one descriptor per effect instead of one per render');
  assert.deepEqual(next.log, old.log, 'WGSL, uniform bytes, groups, passes, draws and intermediate formats stay exact');
});
