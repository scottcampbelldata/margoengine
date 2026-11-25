// Regression (KB3240b, 2026-11-12): the VAT crowd's direct light (packages/animation/src/vat.ts, unlit and lit shaders) weighted its Lambert lobe by 1 minus the Fresnel at the metal-mixed F0,
// so every part-metal surface came out darker than glTF 2.0 Appendix B's metal/dielectric mix (gltf/pbr's sun was fixed
// for this in KB3240). It now weights the diffuse by 1 minus the dielectric Fresnel. The shipped text of vat.ts runs
// on the CPU (tests/support/wgsl-eval.js); the shaders write pi as 3.14159265, so closed forms hold to 1e-8 relative.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  directLightSite,
  headOn,
  metalMixCases,
  metalMixReference,
  normalize,
  shaderSource,
} from '../../../tests/support/metal-mix.js';

const check = (actual, expected, label) =>
  actual.forEach((value, i) =>
    assert.ok(
      Math.abs(value - expected[i]) < 1e-8 * Math.max(1e-3, Math.abs(expected[i])),
      `${label}: ${actual} != ${expected}`,
    ),
  );
const text = shaderSource('packages/animation/src/vat.ts'),
  unlit = directLightSite(text, {
    start: 'let h=(v+l)/max(length(v+l),0.0001);',
    marker: 'var color=',
    params: 'nn:vec3f,v:vec3f,l:vec3f,albedo:vec3f,rough:f32,metal:f32',
  }),
  lit = directLightSite(text.slice(text.indexOf('const buildLit')), {
    start: 'let h=(v+l)/max(length(v+l),0.0001);',
    marker: 'let direct=',
    params: 's:Surface,v:vec3f,l:vec3f',
  }),
  sites = [
    ['unlit', (c) => unlit.call(c.n, c.v, c.l, c.base, c.roughness, c.metal)],
    ['lit', (c) => lit.call({ base: [...c.base, 1], n: c.n, roughness: c.roughness, metal: c.metal }, c.v, c.l)],
  ];

test('the VAT crowd on a part-metal surface is the specification metal/dielectric mix', () => {
  for (const c of metalMixCases())
    for (const [name, run] of sites) check(run(c), metalMixReference(c), `${name} ${c.metal} ${c.roughness}`);
});

test('the VAT crowd head on at metal 0.5 is ((1 - metal) 0.96 base + F0 / 4) / pi, not the metal-mixed weight', () => {
  const n = normalize([0, 0, 1]);
  for (const [name, run] of sites) {
    const [r] = run({ ...headOn, n, v: n, l: n });
    assert.ok(
      Math.abs(r - headOn.expected) < 1e-8 * headOn.expected,
      `${name}: ${r} != ${headOn.expected} (old weight gives ${headOn.old})`,
    );
  }
});
