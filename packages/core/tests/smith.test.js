// Regression (KB5875a, 2026-11-11): core's direct light used the separable Smith G of the 2021 glTF Appendix B, which
// counts a microfacet hidden from both the light and the eye twice and darkens rough surfaces at grazing angles (Heitz
// 2014, section 6.2). It now evaluates the height-correlated G2 of Heitz 2014 eq. 99, as glTF Appendix B.3.2 does today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wgsl } from '../src/shaders.ts';
import { smithG, smithGCorrelated, smithGCorrelatedFloat } from '../../shared/light-terms.js';
import { correlatedG2, separableG2, shaderExpression, smithGrid } from '../../../tests/support/smith-reference.js';

const names = ['nl', 'nv', 'a2'];
const coreG = shaderExpression(/let g=([^;]+);/.exec(wgsl)[1], names);

test("core's direct light evaluates the height-correlated Smith G2 (Heitz 2014, eq. 99)", () => {
  for (const [nl, nv, a2] of smithGrid()) {
    const want = correlatedG2(nl, nv, a2);
    assert.ok(Math.abs(coreG(nl, nv, a2) - want) < 1e-12, `G at nl ${nl}, nv ${nv}, a2 ${a2}: ${coreG(nl, nv, a2)} vs ${want}`);
  }
});

test('the shared height-correlated text is the same G2, and never below the separable form', () => {
  const shared = shaderExpression(smithGCorrelated, names),
    float = shaderExpression(smithGCorrelatedFloat, names),
    separable = shaderExpression(smithG, names);
  let gain = 0;
  for (const [nl, nv, a2] of smithGrid()) {
    const want = correlatedG2(nl, nv, a2);
    assert.ok(Math.abs(shared(nl, nv, a2) - want) < 1e-12);
    assert.ok(Math.abs(float(nl, nv, a2) - want) < 1e-12);
    assert.ok(Math.abs(separable(nl, nv, a2) - separableG2(nl, nv, a2)) < 1e-12, 'the separable text is G1 G1');
    assert.ok(want >= separableG2(nl, nv, a2) - 1e-15, `G2 >= G1 G1 at nl ${nl}, nv ${nv}, a2 ${a2}`);
    gain = Math.max(gain, want / separableG2(nl, nv, a2));
  }
  // Rough and grazing, the forms differ by more than a quarter: the change is visible, not rounding.
  assert.ok(gain > 1.25, `largest G2 / (G1 G1) ${gain}`);
  // Normal incidence (nl = nv = 1): both are 1 at any roughness.
  for (const a2 of [0.0001, 0.3, 1]) assert.ok(Math.abs(coreG(1, 1, a2) - 1) < 1e-12);
  // nl = 0 and a2 = 0 is guarded: 0, not NaN.
  assert.equal(coreG(0, 0.5, 0), 0);
});
