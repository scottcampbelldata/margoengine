// The probe checks' CPU mirror of core's display line (examples/package-benchmarks/probes-gpu.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { wgsl } from '../packages/core/src/shaders.ts';
import { pbrNeutral } from '../packages/shared/display.js';
import { materialRoughness, output, srgb } from '../examples/package-benchmarks/parts/display.mjs';

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

// Core clamps every PbrMaterial roughness to at least 0.045 (geometry.ts), so the probe check's "roughness 0" mirror floor
// shades at 0.045: lod 0.225 into the 0.2 level and a split-sum weight of 0.975. The mirror shaded it at 0, a gap the
// Reinhard curve hid (median 1/255) and b4675ba36's PBR Neutral showed (p95 4/255).
test('the mirror shades core materials at the roughness core uploads', async () => {
  const { PbrMaterial } = await import('../packages/core/src/geometry.ts');
  for (const roughness of [0, 0.01, 0.045, 0.5, 1])
    assert.equal(materialRoughness(roughness), Math.fround(new PbrMaterial({ roughness }).data[4]), String(roughness));
});
