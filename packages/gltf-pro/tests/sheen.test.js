// The physical shader's sheen layer (KHR_materials_sheen) run on the CPU through tests/support/wgsl-eval.js: the lobe
// against the Charlie distribution written out here, the albedo against a numerical integration of that lobe, and the
// layering identities (black sheen changes nothing, the result is affine in the layer underneath, sheen uses s.n).
import test from 'node:test';
import assert from 'node:assert/strict';
import { factorPhysicalShader, physicalShader } from '../src/shader.ts';
import { wgslFunction, wgslModule } from '../../../tests/support/wgsl-eval.js';

const code = physicalShader(),
  names = [
    'ggx',
    'margoLayerSky',
    'margoCoatAmbient',
    'margoSheenBRDF',
    'margoSheenAlbedo',
    'margoSheenAmbient',
    'layers',
  ],
  frame = { radiance: [1.2, 1, 0.8, 0.6], light: [0, 1, 0, 2.5] },
  shader = wgslModule(names.map((n) => wgslFunction(code, n)).join('\n'), { f: frame });
const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const surface = (overrides = {}) => ({
  n: [0, 1, 0],
  cn: [0, 1, 0],
  cc: 0,
  cr: 0.3,
  occlusion: 0.9,
  sh: [0.8, 0.5, 0.2, 0.5],
  ...overrides,
});

/** Charlie sheen distribution (Estevez and Kulla 2017) times the Neubelt visibility clamped to 1, alpha = r^2. */
function charlie(r, nl, nv, nh) {
  const alpha = r * r,
    sin2 = 1 - nh * nh;
  return (((2 + 1 / alpha) * sin2 ** (1 / (2 * alpha))) / (2 * Math.PI)) * Math.min(1, 1 / (4 * (nl + nv - nl * nv)));
}

test('the sheen lobe is the Charlie distribution with the clamped Neubelt visibility', () => {
  for (const r of [0.05, 0.3, 0.7, 1])
    for (const [nl, nv, nh] of [
      [0.2, 0.9, 0.5],
      [0.8, 0.1, 0.95],
      [1, 1, 1],
      [0.05, 0.05, 0.1],
    ]) {
      const actual = shader.call('margoSheenBRDF', r, nl, nv, nh),
        expected = charlie(r, nl, nv, nh);
      assert.ok(Math.abs(actual - expected) <= 1e-7 * Math.max(1, expected), `r ${r} (${nl},${nv},${nh})`);
    }
  // Roughness 0 stays finite.
  assert.ok(Number.isFinite(shader.call('margoSheenBRDF', 0, 0.5, 0.5, 0.99)));
});

test('the sheen albedo is the hemispherical integral of that lobe (within the fit error)', () => {
  const integral = (mu, r, n = 160) => {
    let sum = 0;
    const v = [Math.sqrt(1 - mu * mu), mu, 0];
    for (let i = 0; i < n; i++) {
      const nl = (i + 0.5) / n,
        sl = Math.sqrt(1 - nl * nl);
      for (let j = 0; j < n; j++) {
        const phi = (Math.PI * (j + 0.5)) / n,
          l = [sl * Math.cos(phi), nl, sl * Math.sin(phi)],
          h = unit([v[0] + l[0], v[1] + l[1], v[2] + l[2]]);
        sum += shader.call('margoSheenBRDF', r, nl, mu, h[1]) * nl;
      }
    }
    return (2 * Math.PI * sum) / (n * n);
  };
  for (const [mu, r] of [
    [1, 1],
    [0.5, 0.8],
    [0.3, 0.5],
    [0.8, 0.4],
    [0.6, 0.3],
  ]) {
    const expected = Math.min(1, integral(mu, r)),
      actual = shader.call('margoSheenAlbedo', mu, r);
    assert.ok(Math.abs(actual - expected) <= 0.015, `mu ${mu} r ${r}: fit ${actual} integral ${expected}`);
  }
});

test('black sheen and no clearcoat leave the layer underneath exactly as it was', () => {
  const v = unit([0.3, 0.8, 0.2]),
    l = unit([-0.5, 0.6, 0.1]),
    under = [0.31, 0.27, 0.05];
  for (const roughness of [0.03, 0.5, 1])
    assert.deepEqual(shader.call('layers', surface({ sh: [0, 0, 0, roughness] }), v, l, under), under);
});

test('layers is affine in the layer underneath, scaled by 1 - max(sheen) E(n.v) and the coat', () => {
  const s = surface({ cc: 0.6 }),
    v = unit([0.3, 0.8, 0.2]),
    l = unit([-0.5, 0.6, 0.1]),
    at = (under) => shader.call('layers', s, v, l, under),
    zero = at([0, 0, 0]),
    one = at([1, 1, 1]),
    some = at([0.2, 0.4, 0.6]);
  for (let c = 0; c < 3; c++)
    assert.ok(Math.abs(some[c] - (zero[c] + (one[c] - zero[c]) * [0.2, 0.4, 0.6][c])) < 1e-12);
  const fc = 0.04 + 0.96 * (1 - v[1]) ** 5,
    expected = (1 - 0.8 * shader.call('margoSheenAlbedo', v[1], 0.5)) * (1 - 0.6 * fc);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(one[c] - zero[c] - expected) < 1e-12);
});

test('the default sheen ambient is E(n.v) times the sky at the base normal, not the coat normal', () => {
  const v = unit([0, 1, 0.4]),
    s = surface({ n: [0, 1, 0], cn: [0, -1, 0] }),
    expected = shader.call('margoSheenAlbedo', v[1], 0.5) * frame.radiance[3] * 0.9;
  for (const value of shader.call('margoSheenAmbient', s, v)) assert.ok(Math.abs(value - expected) < 1e-12);
});

test('factor-only physical materials keep the sheen terms with neutral maps', () => {
  const factors = factorPhysicalShader();
  assert.match(
    factors,
    /s\.sh=vec4f\(f\.sheen\.rgb\*vec4f\(1\)\.rgb,clamp\(f\.sheen\.w\*vec4f\(1\)\.a,0\.03,1\.0\)\);/,
  );
  for (const name of ['margoSheenBRDF', 'margoSheenAlbedo', 'margoSheenAmbient'])
    assert.ok(factors.includes(`fn ${name}(`));
  assert.ok(!/0\.157/.test(code), 'no constant albedo remains');
});
