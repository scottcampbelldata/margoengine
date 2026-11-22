// iblPrefiltered (IBL_WGSL) mixes the two prefiltered mips around a roughness by GGX alpha, not by roughness, so a
// low-roughness lobe is not widened by the rougher mip (KB-A3e; LightProbes' probeRadiance does the same, KB-A3c).
import test from 'node:test';
import assert from 'node:assert/strict';
import { IBL_WGSL } from '../dist/index.js';

// The WGSL below in JS: mip m is prefiltered at roughness m / (mips - 1); top = mips - 1 (params.z).
const lod = (roughness, top) => {
  const x = Math.min(Math.max(roughness, 0), 1) * top,
    k = Math.min(Math.floor(x), Math.max(top - 1, 0));
  return k + (x * x - k * k) / (2 * k + 1);
};

test('iblPrefiltered reads the lod of the GGX alpha blend', () => {
  assert.ok(IBL_WGSL.includes('let x = clamp(roughness, 0.0, 1.0) * params.z;'));
  assert.ok(IBL_WGSL.includes('let k = min(floor(x), max(params.z - 1.0, 0.0));'));
  assert.ok(
    IBL_WGSL.includes(
      'textureSampleLevel(specular, s, iblRotate(r, params), k + (x * x - k * k) / (2.0 * k + 1.0)).rgb',
    ),
  );
  assert.ok(!IBL_WGSL.includes('clamp(roughness, 0.0, 1.0) * params.z).rgb'), 'the lod linear in roughness is gone');
});

test('each mip is read alone at its own roughness, and the two mips mix to the material alpha', () => {
  for (const mips of [1, 2, 5, 6, 8]) {
    const top = mips - 1;
    for (let m = 0; m < mips; m++) assert.equal(lod(top ? m / top : 0, top), m, `${mips} mips, mip ${m}`);
    let last = -1;
    for (let i = 0; i <= 1000; i++) {
      const r = i / 1000,
        l = lod(r, top),
        k = Math.min(Math.floor(l), Math.max(top - 1, 0)),
        w = l - k;
      assert.ok(l >= last - 1e-12 && l <= top + 1e-12 && w >= -1e-12 && w <= 1 + 1e-12, `${mips}: ${r}`);
      last = l;
      if (top === 0) continue;
      const a0 = (k / top) ** 2,
        a1 = ((k + 1) / top) ** 2;
      assert.ok(Math.abs(a0 + (a1 - a0) * w - r * r) < 1e-12, `${mips} mips at ${r}: mixed alpha`);
    }
  }
  // A 6-mip Environment at core's 0.045 roughness floor: 5.06% of the 0.2 mip, not 22.5%.
  assert.ok(Math.abs(lod(0.045, 5) - 0.050625) < 1e-12);
});
