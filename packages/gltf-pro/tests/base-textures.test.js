import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { packBaseTextures } from '../src/base-textures.ts';

test('packed arrays share per device/view/mip/sampler set and release exactly at the last owner', () => {
  const gpu = mockGPU(),
    device = gpu.device;
  const sources = Array.from({ length: 5 }, () => ({ view: {}, width: 1, height: 1, levels: 1, sampler: {} }));
  let first, second;
  const log = gpu.record(() => {
    first = packBaseTextures(device, sources);
    second = packBaseTextures(
      device,
      sources.map((s) => ({ ...s, sampler: {} })),
    );
  });
  assert.equal(first.texture, second.texture);
  assert.equal(first.params, second.params);
  assert.equal(log.filter((e) => e[0] === 'texture').length, 1);
  let released = 0;
  for (const resource of [first.texture, first.params]) {
    const original = resource.destroy;
    resource.destroy = () => {
      released++;
      original.call(resource);
    };
  }
  first.destroy();
  first.destroy();
  assert.equal(released, 0);
  second.destroy();
  second.destroy();
  assert.equal(released, 2);
  const replacement = packBaseTextures(device, sources);
  assert.notEqual(replacement.texture, first.texture);
  const different = packBaseTextures(
    device,
    sources.map((s, i) => (i ? s : { ...s, sampler: { minFilter: 9728 } })),
  );
  assert.notEqual(different.texture, replacement.texture);
  replacement.destroy();
  different.destroy();
});
