// The probe checks' CPU mirror of core's display line (examples/package-benchmarks/probes-gpu.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { wgsl } from '../packages/core/src/shaders.ts';
import { pbrNeutral } from '../packages/shared/display.js';
import { output, srgb } from '../examples/package-benchmarks/parts/display.mjs';

// b4675ba36 moved core's display curve from Reinhard to Khronos PBR Neutral; the mirror kept Reinhard, so every core pixel
// of probes-gpu read 45/255 brighter than the mirror (got 201,216,203, want 167,173,167) and four checks failed.
test('the core mirror is the curve core draws with', () => {
  assert.match(wgsl, /let mapped=pbrNeutral\(max\(linear,vec3f\(0\)\)\);/);
  for (const rgb of [
    [0.64, 0.7, 0.66],
    [0, 0, 0],
    [0.05, 0.02, 0.07],
    [0.9, 0.3, 0.1],
    [3, 2, 1],
    [-0.2, 0.5, 0.5],
  ])
    assert.deepEqual(output.core(rgb), pbrNeutral(rgb.map((c) => Math.max(c, 0))).map(srgb), String(rgb));
  assert.deepEqual(output.core([0.64, 0.64, 0.64]), [203, 203, 203]);
});
