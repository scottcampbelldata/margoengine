// Regression (KB5875a, 2026-11-11): gltf-pro's direct light (the base shader, the physical shader's coat lobe and the
// extended materials' isotropic path) used the separable Smith G of the 2021 glTF Appendix B; it now evaluates the
// height-correlated G2 of Heitz 2014 eq. 99, as core's direct light does, so a plain material shades the same in both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { directWgsl, pbrShader, physicalShader } from '../src/shader.ts';
import { correlatedG2, shaderExpression, smithGrid } from '../../../tests/support/smith-reference.js';
import { wgsl as coreWgsl } from '../../core/src/shaders.ts';

const names = ['nl', 'nv', 'a2'];
const g = (code, label) => {
  const match = /let g=([^;]+);/.exec(code);
  assert.ok(match, `${label} declares g`);
  return shaderExpression(match[1], names);
};

test("gltf-pro's direct light and coat lobe use the height-correlated Smith G2, as core does", () => {
  const core = g(coreWgsl, 'core');
  const coat = /fn ggx\([\s\S]*?\n\}/.exec(physicalShader())[0];
  for (const [label, evaluate] of [
    ['base', g(/fn direct_light[\s\S]*?\n\}/.exec(pbrShader)[0], 'base')],
    ['coat', g(coat, 'coat')],
  ])
    for (const [nl, nv, a2] of smithGrid()) {
      const want = correlatedG2(nl, nv, a2);
      assert.ok(Math.abs(evaluate(nl, nv, a2) - want) < 1e-12, `${label} G at nl ${nl}, nv ${nv}, a2 ${a2}`);
      assert.ok(Math.abs(evaluate(nl, nv, a2) - core(nl, nv, a2)) < 1e-12, `${label} matches core`);
    }
});

test("the extended isotropic path's D V is GGX D times G2 / (4 nl nv)", () => {
  const text = /let a2=a\*a; let spec=([^;]+);/.exec(directWgsl(false))[1],
    spec = shaderExpression(text, ['nl', 'nv', 'nh', 'a2']);
  for (const [nl, nv, a2] of smithGrid()) {
    const nh = 0.9,
      d = a2 / (Math.PI * (nh * nh * (a2 - 1) + 1) ** 2),
      want = (d * correlatedG2(nl, nv, a2)) / (4 * nl * nv);
    assert.ok(Math.abs(spec(nl, nv, nh, a2) / want - 1) < 1e-6, `spec at nl ${nl}, nv ${nv}, a2 ${a2}`);
  }
});
