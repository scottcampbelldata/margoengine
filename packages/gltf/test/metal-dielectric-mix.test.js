// KB3240: glTF 2.0 Appendix B defines material = mix(dielectric_brdf, metal_brdf, metallic). The diffuse lobe belongs to
// the dielectric, weighted by 1 minus the dielectric Fresnel (F0 0.04); the specular sum is Schlick at the mixed F0. The
// shipped direct light weighted the diffuse by 1 minus the mixed Fresnel, which darkened every part-metal surface
// (MetalRoughSpheresNoTextures against the Sample Viewer: MAE 1.787, Margo darker on flat sphere interiors).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbrShader } from '../src/shader.ts';
import { physicalShader } from '../src/shader.ts';
import { wgslFunction, wgslModule } from '../../../tests/support/wgsl-eval.js';

const normalize = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
// The specification's mix, written from Appendix B (not from the shader): Lambert, GGX D, height-correlated Smith V.
function reference({ base, metal, roughness, n, v, l }) {
  const h = normalize(v.map((x, i) => x + l[i])),
    nl = Math.max(dot(n, l), 0),
    nv = Math.max(dot(n, v), 0.0001),
    nh = Math.max(dot(n, h), 0),
    vh = Math.max(dot(v, h), 0),
    a2 = roughness ** 4,
    d = a2 / (Math.PI * (nh * nh * (a2 - 1) + 1) ** 2),
    g = (2 * nl * nv) / (nl * Math.sqrt(a2 + (1 - a2) * nv * nv) + nv * Math.sqrt(a2 + (1 - a2) * nl * nl)),
    specular = (d * g) / (4 * nl * nv),
    w = (1 - vh) ** 5;
  return base.map((c) => {
    const dielectric = (1 - (0.04 + 0.96 * w)) * (c / Math.PI) + (0.04 + 0.96 * w) * specular,
      metallic = (c + (1 - c) * w) * specular;
    return ((1 - metal) * dielectric + metal * metallic) * nl;
  });
}
const view = normalize([0.4, 0.27, 0.87]),
  light = normalize([0.4, 0.7, 0.6]);

test('the compact direct light is the specification metal/dielectric mix at part-metal values', () => {
  const shader = wgslModule(wgslFunction(pbrShader, 'direct_light'), {
    f: { radiance: [1, 1, 1, 0], light: [...light, 1] },
  });
  for (const metal of [0, 1 / 6, 0.5, 5 / 6, 1])
    for (const roughness of [0.25, 0.5, 1]) {
      const base = [0.6038, 0.4397, 0.0123],
        n = normalize([0.3, 0.5, 0.8]),
        actual = shader.call('direct_light', { base: [...base, 1], n, roughness, metal }, view, light),
        expected = reference({ base, metal, roughness, n, v: view, l: light });
      actual.forEach((value, c) =>
        assert.ok(Math.abs(value - expected[c]) < 1e-9 * Math.max(1, expected[c]), `${metal} ${roughness}: ${actual} != ${expected}`),
      );
    }
});

test('the physical variant keeps its own dielectric Fresnel weight and drops the compact one', () => {
  const code = physicalShader();
  assert.match(code, /return \(\(1-margoFresnelPeak\(margoDielectricFresnel\(s\.f0,s\.sw,vh\)\)\)\*\(1-s\.metal\)/);
  assert.doesNotMatch(code, /1-\(dielectric\+\(1-dielectric\)/);
});
