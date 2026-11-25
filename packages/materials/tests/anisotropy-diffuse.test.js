// KB3240f: the lobe shader's direct light with anisotropy alone (no specular or film lobe) run on the CPU through
// tests/support/wgsl-eval.js. glTF 2.0 Appendix B defines material = mix(dielectric_brdf, metal_brdf, metallic): the
// diffuse lobe belongs to the dielectric and takes 1 minus the dielectric Fresnel (F0 0.04), while the specular parts sum
// to Schlick at the mixed F0. The branch weighted the diffuse by 1 minus the mixed Fresnel, which darkened part-metal
// surfaces, as gltf/pbr's base direct light did before KB3240 (packages/gltf/test/metal-dielectric-mix.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { anisotropy } from '../dist/index.js';
import { wgslFunction, wgslModule } from '../../../tests/support/wgsl-eval.js';

const normalize = (v) => {
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
  eye = [0.6, 0.5, 2],
  l = normalize([-0.4, 0.7, 0.6]),
  shader = wgslModule(names.map((n) => wgslFunction(code, n)).join('\n'), {
    f: { eye: [...eye, 1], light: [...l, 1], radiance: [1, 1, 1, 0] },
  }),
  n = [0, 0, 1],
  i = { position: [0, 0, 0] },
  v = normalize(eye),
  w = (1 - Math.max(dot(v, normalize(v.map((x, c) => x + l[c]))), 0)) ** 5,
  nl = Math.max(dot(n, l), 0),
  inputs = {
    sheen: [0, 0, 0, 0],
    specular: [1, 1, 1, 1],
    iridescence: [0, 1.3, 0, 0],
    anisotropy: 0.6,
    tangent: [1, 0, 0],
    bitangent: [0, 1, 0],
    viewCos: dot(n, v),
  },
  direct = (base, metal) =>
    shader.call('materialLobesDirect', i, { n, base: [...base, 1], metal, roughness: 0.5 }, [0, 0, 0], inputs);

test('anisotropy alone weights the diffuse by the dielectric Fresnel of the Appendix B mix', () => {
  // The specular BRDF does not depend on the base colour or metal: read it from a black dielectric.
  const dielectric = 0.04 + 0.96 * w,
    specular = direct([0, 0, 0], 0)[0] / (dielectric * nl);
  assert.ok(specular > 0 && Number.isFinite(specular));
  const base = [0.6038, 0.4397, 0.0123];
  for (const metal of [0, 1 / 6, 0.5, 5 / 6, 1]) {
    const actual = direct(base, metal);
    base.forEach((c, k) => {
      const mixed = (1 - metal) * dielectric + metal * (c + (1 - c) * w),
        expected = ((1 - dielectric) * (1 - metal) * (c / Math.PI) + mixed * specular) * nl;
      assert.ok(
        Math.abs(actual[k] - expected) < 1e-6 * Math.max(1, expected),
        `metal ${metal} channel ${k}: ${actual[k]} != ${expected}`,
      );
    });
  }
});
