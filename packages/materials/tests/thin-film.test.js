// The shipped thin-film WGSL (iridescenceWGSL, which the iridescence lobe declares) run on the CPU through
// tests/support/wgsl-eval.js and compared with the independent spectral quadrature in support/iridescence-reference.js,
// plus the guards the lobes rely on (exact Schlick without a film, total internal reflection, bounded output).
import test from 'node:test';
import assert from 'node:assert/strict';
import { iridescenceWGSL } from '../src/iridescence.ts';
import { iridescenceCases, iridescenceReference } from './support/iridescence-reference.js';
import { wgslModule } from '../../../tests/support/wgsl-eval.js';

const film = wgslModule(iridescenceWGSL),
  fresnel = ({ cosTheta, outsideIor = 1, filmIor = 1.3, thicknessNm = 400, baseF0 = [0.04, 0.04, 0.04] }) =>
    film.call('materialIridescenceFresnel', cosTheta, outsideIor, filmIor, thicknessNm, baseF0);
const schlick = (f0, c) => f0.map((v) => v + (1 - v) * (1 - c) ** 5);

test('the thin-film Fresnel matches the independent spectral quadrature', () => {
  for (const [index, input] of iridescenceCases.entries()) {
    const actual = fresnel(input),
      expected = iridescenceReference(input);
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(actual[c] - expected[c]) < 2e-5, `case ${index} channel ${c}: ${actual[c]} vs ${expected[c]}`);
  }
});

test('no film and a film matching the outside IOR return exactly the base Schlick Fresnel', () => {
  const f0 = [0.04, 0.2, 1];
  for (const cosTheta of [0, 0.1, 0.5, 1]) {
    assert.deepEqual(fresnel({ cosTheta, thicknessNm: 0, baseF0: f0 }), schlick(f0, cosTheta));
    assert.deepEqual(fresnel({ cosTheta, thicknessNm: -5, baseF0: f0 }), schlick(f0, cosTheta));
    assert.deepEqual(fresnel({ cosTheta, filmIor: 1, baseF0: f0 }), schlick(f0, cosTheta));
  }
});

test('a vanishing film fades continuously into the no-film result', () => {
  const f0 = [0.04, 0.3, 0.9],
    plain = schlick(f0, 0.6);
  let previous = Infinity;
  for (const thicknessNm of [0.04, 0.01, 0.001, 1e-6]) {
    const value = fresnel({ cosTheta: 0.6, thicknessNm, baseF0: f0 }),
      gap = Math.max(...value.map((v, c) => Math.abs(v - plain[c])));
    assert.ok(gap <= previous + 1e-12, `thickness ${thicknessNm}`);
    previous = gap;
  }
  assert.ok(previous < 1e-4);
});

test('total internal reflection in the film reflects everything', () => {
  assert.deepEqual(fresnel({ cosTheta: 0.2, outsideIor: 1.5, filmIor: 1, thicknessNm: 400 }), [1, 1, 1]);
});

test('results stay finite and in [0, 1] for extreme inputs', () => {
  for (const thicknessNm of [1e-12, 0.03, 100, 400, 1000, 49999, 1e5, 1e30, Infinity])
    for (const cosTheta of [-1, 0, 0.2, 1, 2])
      for (const filmIor of [1e-9, 1.3, 3, 1e12])
        for (const baseF0 of [
          [0, 0.04, 1],
          [2, -1, 0.5],
        ]) {
          const value = fresnel({ cosTheta, filmIor, thicknessNm, baseF0 });
          assert.ok(
            value.every((v) => Number.isFinite(v) && v >= 0 && v <= 1),
            `${JSON.stringify({ thicknessNm, cosTheta, filmIor, baseF0 })} -> ${value}`,
          );
        }
});

test('a real film colours the reflection and its colour depends on thickness', () => {
  const a = fresnel({ cosTheta: 0.9, thicknessNm: 250 }),
    b = fresnel({ cosTheta: 0.9, thicknessNm: 400 });
  assert.ok(Math.max(...a) - Math.min(...a) > 0.01);
  assert.ok(Math.max(...a.map((v, c) => Math.abs(v - b[c]))) > 0.01);
});

// 8a0f78eb6: `base<film` compared a vec3f with an f32, which WGSL rejects; the mock GPU and this file's evaluator do not
// type-check, so every iridescent material compiled nowhere but here. The compile itself is the khronos-IridescenceLamp view.
test('the film phase compares the base IOR per channel', async () => {
  assert.match(iridescenceWGSL, /filmBase<vec3f\(filmEta\)/);
  assert.doesNotMatch(iridescenceWGSL, /filmBase<filmEta\b/);
  const { iridescenceWgsl: pro } = await import('../../gltf-pro/src/shader.ts');
  assert.match(pro, /base<vec3f\(film\)/);
  assert.doesNotMatch(pro, /base<film\b/);
});
