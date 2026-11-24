// The physical shader's sheen layer (KHR_materials_sheen) run on the CPU through tests/support/wgsl-eval.js: the lobe
// against the Charlie distribution written out here, the albedo against a numerical integration of that lobe, and the
// layering identities (black sheen changes nothing, the result is affine in the layer underneath, sheen uses s.n).
import test from 'node:test';
import assert from 'node:assert/strict';
import { factorPhysicalShader, physicalShader, transmissiveShader } from '../src/shader.ts';
import { wgslConst, wgslFunction, wgslModule } from '../../../tests/support/wgsl-eval.js';

const code = physicalShader(),
  names = [
    'ggx',
    'margoLayerSky',
    'margoCoatAmbient',
    'margoSheenBRDFL',
    'margoSheenBRDFLambda',
    'margoSheenBRDF',
    'margoSheenHalf',
    'margoSheenAlbedo',
    'margoSheenAmbient',
    'layers',
  ],
  frame = { radiance: [1.2, 1, 0.8, 0.6], light: [0, 1, 0, 2.5] },
  source = [wgslConst(code, 'margoSheenAlbedoTable'), ...names.map((n) => wgslFunction(code, n))].join('\n'),
  shader = wgslModule(source, {
    f: frame,
    margoDirectVisible: [1, 1, 1],
    margoSheenSun: [0, 0, 0],
  });
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

/**
 * Estevez and Kulla 2017 ("Production Friendly Microfacet Sheen BRDF", eq. 3, Table 1), written out from the paper:
 * Lambda(c) = exp(L(c)) for c < 0.5, else exp(2 L(0.5) - L(1 - c)); L(x) = a / (1 + b x^c) + d x + e with each
 * parameter (1 - alpha)^2 P(r = 0) + (1 - (1 - alpha)^2) P(r = 1), alpha = sheen roughness^2 (KHR_materials_sheen).
 */
function lambda(cos, alpha) {
  const t = (1 - alpha) ** 2,
    [a, b, c, d, e] = [
      [25.3245, 21.5473],
      [3.32435, 3.82987],
      [0.16801, 0.19823],
      [-1.27393, -1.9776],
      [-4.85967, -4.32054],
    ].map(([p0, p1]) => t * p0 + (1 - t) * p1),
    L = (x) => a / (1 + b * x ** c) + d * x + e;
  return Math.exp(cos < 0.5 ? L(cos) : 2 * L(0.5) - L(1 - cos));
}

/** Charlie sheen distribution times the paper's height-correlated visibility (KHR_materials_sheen), alpha = r^2. */
function charlie(r, nl, nv, nh) {
  const alpha = r * r,
    sin2 = 1 - nh * nh;
  return (
    ((2 + 1 / alpha) * sin2 ** (1 / (2 * alpha))) / (2 * Math.PI) / ((1 + lambda(nv, alpha) + lambda(nl, alpha)) * 4 * nl * nv)
  );
}

// Before 2026-11-15 the lobe used the Neubelt and Pettineo visibility clamped to 1, which the spec warns is not
// energy-conserving under albedo scaling and which shades a different lobe from the spec's Charlie form (at r 1,
// n.l = n.v = 0.2: 0.70 times this one; at r 0.3, n.l = n.v = 0.5: 1.63 times).
test('the sheen lobe is the Charlie distribution with Estevez and Kulla shadowing', () => {
  for (const r of [0.05, 0.3, 0.7, 1])
    for (const [nl, nv, nh] of [
      [0.2, 0.9, 0.5],
      [0.8, 0.1, 0.95],
      [1, 1, 1],
      [0.05, 0.05, 0.1],
      [0.3, 0.6, 0.7],
      [0.6, 0.4, 0.45],
    ]) {
      const actual = shader.call('margoSheenBRDF', r, nl, nv, nh),
        expected = charlie(r, nl, nv, nh);
      assert.ok(Math.abs(actual - expected) <= 1e-7 * Math.max(1, expected), `r ${r} (${nl},${nv},${nh})`);
    }
  // Roughness 0 stays finite.
  assert.ok(Number.isFinite(shader.call('margoSheenBRDF', 0, 0.5, 0.5, 0.99)));
});

// scripts/sheen-albedo-fit.mjs measured the table at most 0.01426 from min(E, 1) for roughness 0.03 and up and 0.04109
// below (packages/materials/test/sheen-albedo-fit.test.js), against its own tanh-sinh integration; the midpoint rule here
// is independent of it.
test('the sheen albedo table is the hemispherical integral of that lobe within its measured error', () => {
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
    [0.2, 0.15],
    [0.12, 0.05],
    [1, 0.05],
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
    /s\.sh=vec4f\(f\.sheen\.rgb\*vec4f\(1\)\.rgb,clamp\(f\.sheen\.w\*vec4f\(1\)\.a,0\.0,1\.0\)\);/,
  );
  for (const name of ['margoSheenBRDF', 'margoSheenHalf', 'margoSheenAlbedo', 'margoSheenAmbient'])
    assert.ok(factors.includes(`fn ${name}(`));
  assert.ok(!/0\.157/.test(code), 'no constant albedo remains');
});

// KB3297: KHR_materials_sheen "Albedo-scaling technique" scales punctual light by
// min(1 - max3(sheen) E(n.v), 1 - max3(sheen) E(n.l)) and the rest by its ambient form 1 - max3(sheen) E(n.v), as
// @margoengine/materials' lobe shader does for its direct light. The sun's part of the layer underneath is margoSheenSun.
test('the sun under the sheen takes the punctual albedo scaling, the rest the ambient form', () => {
  assert.ok(code.includes('margoSheenSun=direct;\n  color=layers(s,v,l,color);'), 'the fragment hands layers its sun light');
  const sun = [0.4, 0.3, 0.2],
    rest = [0.1, 0.2, 0.05],
    s = surface(),
    v = unit([0.1, 0.95, 0.2]),
    l = unit([-0.9, 0.2, 0.1]),
    lit = wgslModule(source, { f: frame, margoDirectVisible: [1, 1, 1], margoSheenSun: sun }),
    under = sun.map((x, c) => x + rest[c]),
    zero = shader.call('layers', s, v, l, [0, 0, 0]),
    got = lit.call('layers', s, v, l, under),
    ev = shader.call('margoSheenAlbedo', v[1], 0.5),
    el = shader.call('margoSheenAlbedo', l[1], 0.5);
  assert.ok(el > ev + 0.05, `grazing light has the larger albedo: ${el} against ${ev}`);
  for (let c = 0; c < 3; c++) {
    const expected = zero[c] + rest[c] * (1 - 0.8 * ev) + sun[c] * Math.min(1 - 0.8 * ev, 1 - 0.8 * el);
    assert.ok(Math.abs(got[c] - expected) < 1e-6, `channel ${c}: ${got[c]} against ${expected}`);
  }
  // Light at a smaller albedo than the view's keeps the ambient form: the min picks n.v.
  const steep = lit.call('layers', s, l, v, under),
    flat = shader.call('layers', s, l, v, under);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(steep[c] - flat[c]) < 1e-6);
});

// KB3297d: on SheenTestGrid (RTX A6000, 512 x 512) the largest error against the Sample Viewer sat on two silhouette
// pixels of the sheen roughness 0 spheres, where Margo drew a cyan sheen spike (74/173/174) and the viewer none. The
// pixels lie where the terminator crosses the silhouette (n.v 0.083 and 0.104, n.l 0.05 and 0.01). gltf/pbr raised the
// sheen roughness to 0.03 (alpha 9e-4), a floor neither KHR_materials_sheen nor @margoengine/materials nor
// voxel-pathtracer has: at roughness 0 the Charlie lobe and its albedo vanish away from exact grazing, and the pixel's
// footprint integral on the analytic sphere tends to the base alone as the roughness goes to 0.
test('sheen roughness 0 is not raised, so the spike at the terminator on the silhouette is gone', () => {
  for (const shader of [code, factorPhysicalShader()]) {
    const line = shader.match(/s\.sh=vec4f\([^;]*\);/)[0];
    assert.match(line, /,0\.0,1\.0\)\);$/, `no floor in ${line}`);
  }
  assert.match(transmissiveShader(), /margoSheenAlbedo\(nv,clamp\(f\.sheen\.w,0\.0,1\.0\)\)/, 'the tint share has no floor');
  const vl = Math.hypot(...unit([0.4, 0.7, 0.6]).map((x, c) => x + [0, 0, 1][c]));
  for (const [nv, nl] of [
    [0.083, 0.05],
    [0.104, 0.01],
  ]) {
    const nh = (nv + nl) / vl;
    assert.ok(shader.call('margoSheenBRDF', 0, nl, nv, nh) * nl * 3 < 1e-9, `roughness 0 at (${nv}, ${nl})`);
    // What the floor drew there: a bright cyan pixel.
    assert.ok(shader.call('margoSheenBRDF', 0.03, nl, nv, nh) * nl * 3 > 0.2, `the old floor at (${nv}, ${nl})`);
  }
});

// A shading normal interpolated across a coarse sphere can face away from the viewer on its silhouette (n.v < 0). n.v
// is then raised to 1e-4 but dot(n, h) was not: with n.v = -n.l it is 0, the Charlie peak, about 1e7 at roughness 0.
// margoSheenHalf takes n.h from the clamped cosines, the configuration they describe. The sun alone lights the surface
// here (no sky), so the difference is the direct sheen lobe.
test('a shading normal facing away from the viewer does not hit the Charlie peak', () => {
  const sun = wgslModule(source, { f: { ...frame, radiance: [1, 1, 1, 0] }, margoDirectVisible: [1, 1, 1], margoSheenSun: [0, 0, 0] }),
    v = [0, 0, 1],
    l = unit([0.4, 0.7, 0.6]),
    vl = l[2],
    w = unit([v[1] * l[2] - v[2] * l[1], v[2] * l[0] - v[0] * l[2], v[0] * l[1] - v[1] * l[0]]);
  for (const [rawNV, rawNL] of [
    [-0.02, 0.02],
    [-0.05, 0.05],
    [-0.01, 0.03],
  ]) {
    // n = a v + b l + c w with n.v = rawNV and n.l = rawNL.
    const b = (rawNL - rawNV * vl) / (1 - vl * vl),
      a = rawNV - b * vl,
      p = v.map((x, c) => a * x + b * l[c]),
      n = p.map((x, c) => x + Math.sqrt(1 - Math.hypot(...p) ** 2) * w[c]),
      lit = sun.call('layers', surface({ n, cn: n, sh: [1, 1, 1, 0] }), v, l, [0, 0, 0]),
      black = sun.call('layers', surface({ n, cn: n, sh: [0, 0, 0, 0] }), v, l, [0, 0, 0]);
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(lit[c] - black[c]) < 1e-6, `(${rawNV}, ${rawNL}) channel ${c}: sheen adds ${lit[c] - black[c]}`);
  }
  // Wherever the normal faces the viewer it is dot(n, h) itself.
  const d = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  for (const [n, vv, ll] of [
    [[0, 1, 0], [0.3, 0.8, 0.2], [-0.5, 0.6, 0.1]],
    [[0, 0, 1], [0.6, 0.1, 0.4], [0.1, -0.3, 0.9]],
    [unit([0.2, 0.9, 0.1]), [0.9, 0.05, 0], [-0.7, 0.2, 0.2]],
  ]) {
    const u = unit(vv),
      k = unit(ll),
      h = unit(u.map((x, c) => x + k[c])),
      got = shader.call('margoSheenHalf', Math.min(Math.max(d(n, u), 1e-4), 1), Math.min(Math.max(d(n, k), 0), 1), u, k);
    assert.ok(Math.abs(got - d(n, h)) < 1e-12, `${got} against ${d(n, h)}`);
  }
});
