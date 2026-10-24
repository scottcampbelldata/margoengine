// gltf-pro's thin-film Fresnel (iridescenceWgsl, margoIridescence) run on the CPU through tests/support/wgsl-eval.js
// and compared with the double-precision spec reference in tests/support/khr-brdf.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extendedPlan, extendedShader, iridescenceWgsl } from '../src/shader.ts';
import { iridescentFresnel } from '../../../tests/support/khr-brdf.js';
import { wgslModule } from '../../../tests/support/wgsl-eval.js';

const film = wgslModule(iridescenceWgsl),
  evaluate = (f0, c1, thickness, ior) => film.call('margoIridescence', f0, c1, thickness, ior);

test('margoIridescence matches the KHR reference over random inputs', () => {
  let seed = 7;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let k = 0; k < 200; k++) {
    const f0 = [0.02 + random() * 0.98, 0.02 + random() * 0.98, 0.02 + random() * 0.98],
      c1 = random(),
      thickness = random() * 1200,
      ior = 1 + random() * 1.5,
      actual = evaluate(f0, c1, thickness, ior),
      expected = iridescentFresnel(f0, c1, thickness, ior);
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(actual[c] - expected[c]) < 1e-6, `case ${k} channel ${c}: ${actual[c]} vs ${expected[c]}`);
  }
});

test('margoIridescence: white metals stay finite, a film below the outside IOR can reflect totally', () => {
  for (const c1 of [0, 0.3, 1]) {
    const value = evaluate([1, 1, 1], c1, 400, 1.3);
    assert.ok(
      value.every((v) => Number.isFinite(v) && v >= 0),
      String(value),
    );
  }
  assert.deepEqual(evaluate([0.04, 0.04, 0.04], 0.1, 400, 0.8), [1, 1, 1]);
});

test('the extended shader declares the thin-film functions only when iridescence is used', () => {
  const on = extendedShader(extendedPlan([], { iridescence: true, anisotropy: false, diffuseTransmission: false })),
    off = extendedShader(extendedPlan([], { iridescence: false, anisotropy: false, diffuseTransmission: false }));
  assert.ok(on.includes(iridescenceWgsl) && on.includes('fn margoFilmSpectrum('));
  assert.ok(!off.includes('fn margoIridescence(') && !off.includes('fn margoFilmSpectrum('));
});
