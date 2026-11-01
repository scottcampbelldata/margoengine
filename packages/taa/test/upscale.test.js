import test from 'node:test';
import assert from 'node:assert/strict';
import { TAAUpscale } from '@margoengine/taa/upscale';
import * as root from '@margoengine/taa';

test('TAAUpscale checks its options when built', () => {
  for (const bad of [
    { scale: 0.1 },
    { scale: 1.5 },
    { historyWeight: 1 },
    { depthThreshold: -1 },
    { sharpen: 2 },
    { clampGamma: 0 },
    { temporal: 1 },
  ])
    assert.throws(() => new TAAUpscale(bad), RangeError);
  assert.doesNotThrow(() => new TAAUpscale({ scale: 0.25, sharpen: 0, temporal: false }));
});

test('TAAUpscale needs WebGPU, refuses TAA and refuses a disposed effect', () => {
  assert.throws(() => new TAAUpscale().setup({ gpu: undefined, hasPlugin: () => false }), /WebGPU/);
  assert.throws(() => new TAAUpscale().setup({ gpu: {}, hasPlugin: (name) => name === 'taa' }), /replaces TAA/);
  const effect = new TAAUpscale();
  effect.dispose();
  effect.dispose();
  assert.throws(() => effect.setup({ gpu: {}, hasPlugin: () => false }), /disposed/);
});

test('TAAUpscale stays out of the TAA root entry', () => {
  assert.equal(root.TAAUpscale, undefined);
});
