// Regression (KB5875a, 2026-11-11): core's direct light used the separable Smith G of the 2021 glTF Appendix B, which
// counts a microfacet hidden from both the light and the eye twice and darkens rough surfaces at grazing angles (Heitz
// 2014, section 6.2). It now evaluates the height-correlated G2 of Heitz 2014 eq. 99, as glTF Appendix B.3.2 does today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wgsl } from '../src/shaders.ts';
import { smithGCorrelated, smithGCorrelatedFloat } from '../../shared/light-terms.js';
import {
  correlatedG2,
  separableG2,
  shaderExpression,
  shaderStatements,
  smithGrid,
} from '../../../tests/support/smith-reference.js';

const names = ['nl', 'nv', 'a2'];
// The separable G1 G1 text the shaders wrote before KB5875a and KB6016 (Walter et al. 2007, eq. 34).
const SEPARABLE = '2*nv/(nv+sqrt(a2+(1-a2)*nv*nv))*2*nl/max(nl+sqrt(a2+(1-a2)*nl*nl),0.0001)';
const coreG = shaderExpression(/let g=([^;]+);/.exec(wgsl)[1], names);

test("core's direct light evaluates the height-correlated Smith G2 (Heitz 2014, eq. 99)", () => {
  for (const [nl, nv, a2] of smithGrid()) {
    const want = correlatedG2(nl, nv, a2);
    assert.ok(
      Math.abs(coreG(nl, nv, a2) - want) < 1e-12,
      `G at nl ${nl}, nv ${nv}, a2 ${a2}: ${coreG(nl, nv, a2)} vs ${want}`,
    );
  }
});

test('the shared height-correlated text is the same G2, and never below the separable form', () => {
  const shared = shaderExpression(smithGCorrelated, names),
    float = shaderExpression(smithGCorrelatedFloat, names),
    separable = shaderExpression(SEPARABLE, names);
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

// Regression (KB6016c, 2026-11-11): the float32-safe denominator |n x h|^2 + a2 nh^2 equals nh^2 (a2 - 1) + 1 only
// where dot(n, h) >= 0. The shader clamps nh to 0 when the half vector faces away (a shading normal turned from the
// eye, lit from the front), but |n x h|^2 = 1 - dot(n, h)^2 stays below 1 there and reaches 0 as h turns to -n, so D
// grew without bound and back-facing bump slivers on terrain turned bright on the WebGL2 layer. With
// max(|n x h|^2, step(nh, 0)) the denominator is 1 there, D = a2 / pi, as the nh form always gave.
test("core's GGX D keeps a2 / pi where the half vector faces away from the normal", () => {
  const statements = /let a2=a\*a;(.*?)let g=/s.exec(wgsl)[1],
    d = shaderStatements(statements, ['n', 'h', 'nh', 'a2'], 'd'),
    n = [0, 0, 1];
  for (const c of [-0.999, -0.9, -0.5, -0.1, -1e-6])
    for (const roughness of [0.03, 0.2, 0.5, 1]) {
      const a2 = roughness ** 4,
        h = [Math.sqrt(1 - c * c), 0, c],
        want = a2 / 3.14159265; // the shader's pi literal
      assert.ok(Math.abs(d(n, h, 0, a2) / want - 1) < 1e-12, `D at dot(n, h) ${c}, roughness ${roughness}: ${d(n, h, 0, a2)} vs ${want}`);
    }
  // Facing half vectors keep the precise form: the textbook D at nh = 0.9.
  const a2 = 0.2 ** 4,
    h = [Math.sqrt(1 - 0.81), 0, 0.9];
  assert.ok(Math.abs(d(n, h, 0.9, a2) / (a2 / (3.14159265 * (0.81 * (a2 - 1) + 1) ** 2)) - 1) < 1e-9);
});
