// Regression (KB3240b, 2026-11-12): material decals' relight of core's direct light (packages/post/src/material-decals.ts) weighted its Lambert lobe by 1 minus the Fresnel at the metal-mixed F0,
// so every part-metal surface came out darker than glTF 2.0 Appendix B's metal/dielectric mix (gltf/pbr's sun was fixed
// for this in KB3240). It now weights the diffuse by 1 minus the dielectric Fresnel. The shipped text of material-decals.ts runs
// on the CPU (tests/support/wgsl-eval.js); the shaders write pi as 3.14159265, so closed forms hold to 1e-8 relative.
import test from 'node:test';
import assert from 'node:assert/strict';
import { directLightSite, headOn, metalMixCases, metalMixReference, normalize, shaderSource } from '../../../tests/support/metal-mix.js';

const check = (actual, expected, label) =>
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) < 1e-8 * Math.max(1e-3, Math.abs(expected[i])), `${label}: ${actual} != ${expected}`),
  );
const decal = directLightSite(shaderSource('packages/post/src/material-decals.ts'), {
    start: 'let h=(v+l)/max(length(v+l),0.0001);',
    marker: 'let direct=',
    params: 'n:vec3f,v:vec3f,l:vec3f,c:vec3f,r:f32,m:f32',
  }),
  sites = [['decal', (c) => decal.call(c.n, c.v, c.l, c.base, c.roughness, c.metal)]];

test('a material decal on a part-metal surface is the specification metal/dielectric mix', () => {
  for (const c of metalMixCases()) for (const [name, run] of sites) check(run(c), metalMixReference(c), `${name} ${c.metal} ${c.roughness}`);
});

test('a material decal head on at metal 0.5 is ((1 - metal) 0.96 base + F0 / 4) / pi, not the metal-mixed weight', () => {
  const n = normalize([0, 0, 1]);
  for (const [name, run] of sites) {
    const [r] = run({ ...headOn, n, v: n, l: n });
    assert.ok(Math.abs(r - headOn.expected) < 1e-8 * headOn.expected, `${name}: ${r} != ${headOn.expected} (old weight gives ${headOn.old})`);
  }
});
