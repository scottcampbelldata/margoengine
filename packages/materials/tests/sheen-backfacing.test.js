// KB3297d: the lobe shader's direct sheen run on the CPU through tests/support/wgsl-eval.js, with a shading normal that
// faces away from the viewer, as an interpolated normal does on the silhouette of a coarse sphere (n.v < 0). n.v is
// raised to 1e-4 for the BRDF; n.h was dot(n, h), which is 0 where n.v = -n.l, the peak of the Charlie distribution:
// about 1e7 at sheen roughness 0, a white pixel. The lobe now takes n.h from the clamped cosines (shared/sheen.js
// sheenHalfWGSL), the configuration they describe; where the normal faces the viewer that is dot(n, h) itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anisotropy } from '../dist/index.js';
import { wgslConst, wgslFunction, wgslModule } from '../../../tests/support/wgsl-eval.js';

const unit = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const code = anisotropy({ strength: 0.6 }).declarations,
  names = [
    'materialLobesMax',
    'materialLobesSpecularActive',
    'materialLobesFilmActive',
    'materialLobesDielectricF0',
    'materialLobesSheenBRDFL',
    'materialLobesSheenBRDFLambda',
    'materialLobesSheenBRDF',
    'materialLobesSheenHalf',
    'materialLobesSheenAlbedo',
    'materialLobesDirect',
  ],
  eye = [0, 0, 2],
  l = unit([0.4, 0.7, 0.6]),
  shader = wgslModule(
    [wgslConst(code, 'materialLobesSheenAlbedoTable'), ...names.map((n) => wgslFunction(code, n))].join('\n'),
    {
      f: { eye: [...eye, 1], light: [...l, 1], radiance: [1, 1, 1, 0] },
    },
  ),
  v = [0, 0, 1],
  i = { position: [0, 0, 0] },
  inputs = (sheen, n) => ({
    sheen,
    specular: [1, 1, 1, 1],
    iridescence: [0, 1.3, 0, 0],
    anisotropy: 0,
    tangent: [1, 0, 0],
    bitangent: [0, 1, 0],
    viewCos: dot(n, v),
  }),
  direct = (n, sheen) =>
    shader.call(
      'materialLobesDirect',
      i,
      { n, base: [0, 0, 0.5, 1], metal: 0, roughness: 0.75 },
      [0, 0, 0],
      inputs(sheen, n),
    );

/** A unit normal with n.v = nv and n.l = nl. */
function normal(nv, nl) {
  const vl = dot(v, l),
    b = (nl - nv * vl) / (1 - vl * vl),
    a = nv - b * vl,
    p = v.map((x, c) => a * x + b * l[c]),
    w = unit([v[1] * l[2] - v[2] * l[1], v[2] * l[0] - v[0] * l[2], v[0] * l[1] - v[1] * l[0]]);
  assert.ok(Math.hypot(...p) <= 1, `no unit normal has n.v ${nv} and n.l ${nl}`);
  return p.map((x, c) => x + Math.sqrt(1 - Math.hypot(...p) ** 2) * w[c]);
}

test('a sheen of roughness 0 over a normal facing away from the viewer adds no Charlie peak', () => {
  for (const [nv, nl] of [
    [-0.02, 0.02],
    [-0.05, 0.05],
    [-0.01, 0.03],
  ]) {
    const n = normal(nv, nl),
      lit = direct(n, [1, 1, 1, 0]),
      black = direct(n, [0, 0, 0, 0]);
    for (let c = 0; c < 3; c++)
      assert.ok(Math.abs(lit[c] - black[c]) < 1e-6, `(${nv}, ${nl}) channel ${c}: sheen adds ${lit[c] - black[c]}`);
  }
});

test('where the normal faces the viewer the sheen half cosine is dot(n, h)', () => {
  const h = unit(v.map((x, c) => x + l[c]));
  for (const [nv, nl] of [
    [0.5, 0.5],
    [0.95, 0.5],
    [0.2, 0.7],
    [0.05, 0.6],
  ]) {
    const n = normal(nv, nl);
    const got = shader.call('materialLobesSheenHalf', nv, nl, v, l);
    assert.ok(Math.abs(got - dot(n, h)) < 1e-12, `(${nv}, ${nl}): ${got} against ${dot(n, h)}`);
  }
});
