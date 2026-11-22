// Regression (KB3240b, 2026-11-12): the clustered light loop weighted its Lambert lobe by 1 minus the Fresnel at the
// metal-mixed F0, so every part-metal surface came out darker than glTF 2.0 Appendix B's metal/dielectric mix (gltf/pbr's
// sun was fixed for this in KB3240). The loop's per-light BRDF (shared clusterBrdf, which materials, shader, rigging and
// voxel also key on) now weights the diffuse by 1 minus the dielectric Fresnel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clusteredSampling } from '../dist/index.js';
// The shaders write pi as 3.14159265 (1.1e-9 relative), so the closed forms hold to 1e-8 relative.
import {
  directLightSite,
  headOn,
  metalMixCases,
  metalMixReference,
  normalize,
} from '../../../tests/support/metal-mix.js';

// The extra directional lights' loop (Clustered.directional) and the point/spot loop share one BRDF text.
const code = clusteredSampling(0, undefined, undefined, false, false, false, {
    directional: { declarations: () => '' },
  }),
  site = directLightSite(code.slice(code.indexOf('clusterDirectional.count.x')), {
    start: 'let h=(v+l)/max(length(v+l),0.0001);',
    marker: 'result+=',
    params: 'n:vec3f,v:vec3f,l:vec3f,base:vec3f,roughness:f32,metal:f32,dielectricF0:vec3f,dielectricF90:f32',
    prefix: /let nv=clamp\(dot\(n,v\)[^;]*;let a=[^;]*;let a2=a\*a;/.exec(code)[0],
  });

test('a clustered light on a part-metal surface is the specification metal/dielectric mix', () => {
  for (const c of metalMixCases()) {
    const actual = site.call(c.n, c.v, c.l, c.base, c.roughness, c.metal, [0.04, 0.04, 0.04], 1),
      expected = metalMixReference(c);
    actual.forEach((value, i) =>
      assert.ok(
        Math.abs(value - expected[i]) < 1e-9 * Math.max(1, expected[i]),
        `${c.metal} ${c.roughness}: ${actual} != ${expected}`,
      ),
    );
  }
});

test('head on at metal 0.5 the clustered BRDF is ((1 - metal) 0.96 base + F0 / 4) / pi, not the metal-mixed weight', () => {
  const n = normalize([0, 0, 1]),
    [r] = site.call(n, n, n, headOn.base, headOn.roughness, headOn.metal, [0.04, 0.04, 0.04], 1);
  assert.ok(
    Math.abs(r - headOn.expected) < 1e-8 * headOn.expected,
    `${r} != ${headOn.expected} (old weight gives ${headOn.old})`,
  );
});

test("KHR_materials_specular's coloured F0 weighs the diffuse by its largest channel, as gltf/pbr's physical shader", () => {
  const n = normalize([0, 0, 1]),
    f0 = [0.02, 0.08, 0.05],
    [r, g, b] = site.call(n, n, n, [0.5, 0.5, 0.5], 1, 0, f0, 1);
  // Head on, metal 0: diffuse (1 - 0.08) 0.5 / pi, specular F0 / (4 pi) per channel.
  [r, g, b].forEach((value, i) =>
    assert.ok(Math.abs(value - (0.46 + f0[i] / 4) / Math.PI) < 1e-8 * value, `${i}: ${value}`),
  );
});
