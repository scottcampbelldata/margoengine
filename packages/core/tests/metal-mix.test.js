// Regression (KB3240b, core part, 2026-11-12): core's mesh shader (packages/core/src/shaders.ts) weighted its Lambert
// lobe by 1 minus the Fresnel at the metal-mixed F0, so every part-metal core mesh came out darker than glTF 2.0
// Appendix B's metal/dielectric mix (the packages outside core were fixed in 1fdb55908). It now weights the diffuse by
// 1 minus the dielectric Fresnel, 0.96 (1 - (1 - vh)^5). The shipped text runs on the CPU (tests/support/wgsl-eval.js);
// the shader writes pi as 3.14159265, so closed forms hold to 1e-8 relative.
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
// The fragment's per-mesh inputs as parameters: i.color is the base colour, i.material.x the roughness, .y the metal.
const text = shaderSource('packages/core/src/shaders.ts')
    .replaceAll('i.material.x', 'rough')
    .replaceAll('i.material.y', 'metal')
    .replaceAll('i.color', 'base'),
  core = directLightSite(text, {
    start: 'let nl=clamp(dot(n,l),0.0,1.0);',
    marker: 'let direct=',
    params: 'n:vec3f,v:vec3f,l:vec3f,base:vec3f,rough:f32,metal:f32',
    prefix: 'let h=(v+l)/max(length(v+l),0.0001);',
  }),
  run = (c) => core.call(c.n, c.v, c.l, c.base, c.roughness, c.metal);

test("core's direct light on a part-metal surface is the specification metal/dielectric mix", () => {
  for (const c of metalMixCases()) check(run(c), metalMixReference(c), `core ${c.metal} ${c.roughness}`);
});

test("core's direct light head on at metal 0.5 is ((1 - metal) 0.96 base + F0 / 4) / pi, not the metal-mixed weight", () => {
  const n = normalize([0, 0, 1]),
    [r] = run({ ...headOn, n, v: n, l: n });
  assert.ok(
    Math.abs(r - headOn.expected) < 1e-8 * headOn.expected,
    `core: ${r} != ${headOn.expected} (old weight gives ${headOn.old})`,
  );
});
