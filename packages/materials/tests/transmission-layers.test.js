// glTF layers what is above the transmitted light over it: the transmitted light is in fresnel_mix's base
// (KHR_materials_transmission), so it is scaled by 1 - specular * max(F) (KHR_materials_specular), then by the sheen's
// 1 - max(sheen colour) * E(n.v) (KHR_materials_sheen) and the coat's 1 - clearcoat * F(v.Nc) (KHR_materials_clearcoat).
// Each case below states the number the Khronos formulas give for a white, fully transmissive dielectric, and runs the
// shader text itself on the CPU. Before the fix, the extension path (materials `install`) drew 0.96 for all of them at
// normal incidence and the native tint path drew 1.0. scripts/materials-transmission-tests.js measures the same numbers
// on the GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbrShader, transmissiveShader } from '../../gltf-pro/src/shader.ts';
import { materialExtensionShader } from '../../gltf-pro/src/material-extension.ts';
import { sheenAlbedoWGSL } from '../../shared/sheen.js';
import { clearcoat, materialLobes, nodeMaterial } from '../dist/index.js';
import { createTransmission, transmission } from '../dist/transmission.js';
import { wgslModule } from './support/wgsl-subset.js';

const f32 = Math.fround;
const any = (v) => (Array.isArray(v) ? v.some(Boolean) : !!v);
/** Margo's sheen albedo, itself checked against an independent integration (test/sheen-albedo-fit.test.js). */
const albedo = wgslModule(sheenAlbedoWGSL('E'), { exp: (x) => f32(Math.exp(x)) });
const E = (mu, roughness) => albedo.call('E', mu, roughness);
/** Fifth power of 1 - n.v, the Schlick weight. */
const schlick = (nv) => (1 - nv) ** 5;

/** The share of light behind the spec gives: dielectric only, with white base and transmission 1. */
function spec({ nv = 1, ior = 1.5, factor = 1, color = [1, 1, 1], sheen, sheenRoughness = 0, coat = 0, metal = 0 }) {
  const iorF0 = ((ior - 1) / (ior + 1)) ** 2,
    fr = Math.max(...color.map((c) => Math.min(iorF0 * c, 1) + (1 - Math.min(iorF0 * c, 1)) * schlick(nv)));
  return (
    (1 - metal) *
    (1 - factor * fr) *
    (sheen ? 1 - Math.max(...sheen) * E(nv, sheenRoughness) : 1) *
    (1 - coat * (0.04 + 0.96 * schlick(nv)))
  );
}
const CASES = [
  ['specular factor 0: no reflection, so everything passes', { factor: 0 }],
  ['specular factor 0 at a grazing view', { factor: 0, nv: 0.25 }],
  ['specular factor 0.5', { factor: 0.5 }],
  ['specular factor 0.5 at a grazing view', { factor: 0.5, nv: 0.25 }],
  ['specular colour takes the largest channel', { color: [2, 1, 1] }],
  ['specular colour black', { color: [0, 0, 0] }],
  ['specular colour black at a grazing view', { color: [0, 0, 0], nv: 0.25 }],
  ['specular colour saturating F0 reflects everything', { color: [25, 25, 25] }],
  ['specular with IOR 1 has F0 0', { factor: 0.5, ior: 1 }],
  ['sheen white, roughness 0.5', { sheen: [1, 1, 1], sheenRoughness: 0.5 }],
  ['sheen white, roughness 0.5, grazing', { sheen: [1, 1, 1], sheenRoughness: 0.5, nv: 0.25 }],
  ['sheen scales by its largest channel', { sheen: [0.5, 0.25, 0], sheenRoughness: 0.3, nv: 0.25 }],
  ['sheen over specular 0', { sheen: [1, 1, 1], sheenRoughness: 0.5, factor: 0, nv: 0.25 }],
  ['IOR 1 with a sheen still loses what the sheen takes', { sheen: [0.5, 0.5, 0.5], sheenRoughness: 0.5, ior: 1 }],
  ['half metal', { metal: 0.5, factor: 0.5 }],
];
const lobesOf = (c) => ({
  ior: c.ior ?? 1.5,
  ...(c.factor !== undefined || c.color
    ? {
        specular: {
          ...(c.factor !== undefined ? { factor: c.factor } : {}),
          ...(c.color ? { colorFactor: c.color } : {}),
        },
      }
    : {}),
  ...(c.sheen ? { sheen: { colorFactor: c.sheen, roughnessFactor: c.sheenRoughness } } : {}),
});
/** Runs the composed extension's lobes share and the weight it feeds, for a surface facing the view at cosine `nv`. */
function weight(extension, c) {
  const nv = c.nv ?? 1,
    iorF0 = ((c.ior ?? 1.5) - 1) / ((c.ior ?? 1.5) + 1),
    rows = [];
  for (let k = 0; k < extension.factors.length; k += 4) rows.push([...extension.factors.slice(k, k + 4)]);
  const view = [Math.sqrt(1 - nv * nv), 0, nv],
    s = {
      n: [0, 0, 1],
      base: [1, 1, 1, 1],
      metal: c.metal ?? 0,
      tr: 1,
      f0: [iorF0 * iorF0, iorF0 * iorF0, iorF0 * iorF0],
    };
  const shader = wgslModule(
    extension.declarations +
      `\nfn run(s:Surface,material:MaterialLobeInputs,v:vec3f,n:vec3f)->vec3f {materialTransmissionLobes=materialLobesTransmitted(s,material);return materialTransmissionWeight(s,v,n,1.0);}`,
    { materialFactors: rows, any, exp: (x) => f32(Math.exp(x)), f: { eye: [view[0] * 3, 0, view[2] * 3, 1] } },
  );
  const sheenRow = c.sheen
      ? rows.find((r) => r[0] === f32(c.sheen[0]) && r[3] === f32(c.sheenRoughness))
      : [0, 0, 0, 0],
    specularRow =
      c.factor !== undefined || c.color
        ? rows.find((r) => r !== sheenRow && r !== rows[0] && r !== rows[1])
        : [1, 1, 1, 1],
    material = { sheen: sheenRow, specular: specularRow, iridescence: [0, 1.3, 0, 0], anisotropy: 0, viewCos: nv };
  return shader.call('run', s, material, view, s.n);
}

for (const [name, c] of CASES)
  test(`transmitted share over lobes matches the spec: ${name}`, () => {
    const extension = materialLobes(lobesOf(c), transmission({ opaqueColor: {}, factor: 1, ior: c.ior ?? 1.5 })),
      expected = spec(c),
      actual = weight(extension, c);
    for (const channel of actual)
      assert.ok(Math.abs(channel - expected) < 2e-5, `${name}: ${actual} vs the spec's ${expected}`);
  });

test('the numbers the spec gives, written out', () => {
  assert.ok(Math.abs(spec({ factor: 0 }) - 1) < 1e-9);
  assert.ok(Math.abs(spec({ factor: 0.5 }) - 0.98) < 1e-9);
  assert.ok(Math.abs(spec({ color: [2, 1, 1] }) - 0.92) < 1e-9);
  assert.ok(Math.abs(spec({ color: [25, 25, 25] })) < 1e-9);
  assert.ok(Math.abs(spec({ coat: 1 }) - 0.96 * 0.96) < 1e-9);
});

test('lobes set the share in the output hook, before the composite that reads it', () => {
  const base = transmission({ opaqueColor: {}, factor: 1 }),
    extension = materialLobes({ sheen: { colorFactor: [1, 1, 1] } }, base);
  assert.equal(
    extension.output,
    'materialTransmissionLobes=materialLobesTransmitted(s,materialLobeInputs);' + base.output,
  );
  assert.ok(materialExtensionShader(pbrShader, extension).includes(extension.output));
  // Without the composite (no transmission, or a caller's own) the lobes keep their hooks and text.
  assert.equal(materialLobes({ sheen: { colorFactor: [1, 1, 1] } }).output, undefined);
  assert.ok(!materialLobes({ sheen: { colorFactor: [1, 1, 1] } }).declarations.includes('materialLobesTransmitted'));
  const own = materialLobes({ sheen: { colorFactor: [1, 1, 1] } }, { transmission: '1.0', output: 'color=vec3f(0);' });
  assert.equal(own.output, 'color=vec3f(0);');
  assert.ok(!own.declarations.includes('materialLobesTransmitted'));
});

test('lobes over transmission take their dielectric F0 from the host IOR, not their own default', () => {
  const extension = materialLobes({ specular: { factor: 0.5 } }, transmission({ opaqueColor: {}, factor: 1, ior: 1 }));
  assert.match(extension.declarations, /return min\(s\.f0\*material\.specular\.rgb,vec3f\(1\)\)/);
  assert.equal(extension.ior, 'materialFactors[0].y');
});

test('a clearcoat under transmission scales the transmitted light by 1 - clearcoat x F(v.Nc)', () => {
  for (const nv of [1, 0.25]) {
    const extension = createTransmission({ opaqueColor: {}, factor: 1 }, clearcoat({ factor: 1 })),
      rows = [];
    for (let k = 0; k < extension.factors.length; k += 4) rows.push([...extension.factors.slice(k, k + 4)]);
    assert.match(
      extension.declarations,
      /return factor\*\(1\.0-s\.metal\)\*\(1\.0-\(f0\+\(1\.0-f0\)\*q2\*q2\*q\)\)\*materialCoatKeep;/,
    );
    const view = [Math.sqrt(1 - nv * nv), 0, nv],
      n = [0, 0, 1],
      s = { n, base: [1, 1, 1, 1], metal: 0, tr: 1 },
      keep = 1 - (0.04 + 0.96 * schlick(nv));
    const shader = wgslModule(
      extension.declarations +
        `\nfn run(s:Surface,v:vec3f,n:vec3f,keep:f32)->vec3f {materialCoatKeep=keep;materialTransmissionF0=0.04;return materialTransmissionWeight(s,v,n,1.0);}`,
      { materialFactors: rows, f: { eye: [0, 0, 3, 1] } },
    );
    const expected = spec({ coat: 1, nv });
    for (const channel of shader.call('run', s, view, n, keep))
      assert.ok(Math.abs(channel - expected) < 2e-5, `coat at ${nv}: ${channel} vs ${expected}`);
    // The coat stores what it keeps, with its own normal.
    assert.ok(
      extension.declarations.includes(
        'materialCoatKeep=1.0-factor*(0.04+0.96*pow(1.0-clamp(dot(coatNormal,v),0.0,1.0),5.0));',
      ),
    );
  }
  // Without a coat, no reference to a coat that is not declared.
  assert.ok(!transmission({ opaqueColor: {}, factor: 1 }).declarations.includes('materialCoatKeep'));
});

test('a node material with a clearcoat and transmission composes the coat share too', () => {
  const graph = {
    nodes: [
      {
        type: 'emit',
        color: { type: 'color', value: [1, 1, 1, 1] },
        clearcoat: { type: 'clearcoat', factor: { type: 'scalar', value: 1 } },
        transmission: { type: 'transmission', factor: { type: 'scalar', value: 1 } },
      },
    ],
  };
  const extension = nodeMaterial(graph, { opaqueColor: {} });
  assert.ok(extension.declarations.includes('var<private> materialCoatKeep'));
  assert.ok(extension.declarations.includes('*materialCoatKeep;'));
});

test('the transmitted share is applied in linear light on a display-encoded target', () => {
  assert.ok(
    transmission({ opaqueColor: {}, factor: 1 }).declarations.includes(
      'return color+materialTransmissionFilter(transmitted,materialTransmissionWeight(s,v,n,factor));',
    ),
  );
});

/** gltf-pro's native tint draw (no materials install) with the same layers, from the material's factors. */
function tint({ nv = 1, ior = 1.5, factor = 1, color = [1, 1, 1], sheen, sheenRoughness = 0, coat = 0, hdr = true }) {
  const code = transmissiveShader(),
    start = code.indexOf('fn margoTintShare('),
    end = code.indexOf('@fragment fn margoTint(');
  assert.ok(start >= 0 && end > start, 'the tint share is in the transmissive shader');
  const shader = wgslModule(sheenAlbedoWGSL('margoSheenAlbedo') + code.slice(start, end), {
    exp: (x) => f32(Math.exp(x)),
    f: {
      eye: [Math.sqrt(1 - nv * nv) * 3, 0, nv * 3, 1],
      ext: [0, ior, 0, 0],
      specular: [...color, factor],
      sheen: [...(sheen ?? [0, 0, 0]), sheenRoughness],
      coat: [coat, 0, 0, 0],
      // metallicFactor 1 with the real value in a map (FlightHelmet's lenses): the tint must not read it.
      factors: [1, 1, 1, 1],
      settings: [0, 0, 0, hdr ? 1 : 0],
    },
  });
  return shader.call('margoTintShare', { normal: [0, 0, 1], position: [0, 0, 0] }, [1, 1, 1]);
}

for (const [name, c] of [...CASES.filter(([, c]) => !c.metal), ['clearcoat 1, grazing', { coat: 1, nv: 0.25 }]])
  test(`native tint draw matches the spec: ${name}`, () => {
    // The tint reads factors; sheen roughness keeps the physical shader's floor of 0.03.
    const expected = spec(c),
      actual = tint(c);
    for (const channel of actual.slice(0, 3))
      assert.ok(Math.abs(channel - expected) < 2e-5, `${name}: ${actual} vs the spec's ${expected}`);
    assert.equal(actual[3], 1);
  });

test('native tint on a display-encoded target multiplies encoded light by the encoded share', () => {
  const linear = tint({ factor: 0.5, nv: 0.25 }),
    encoded = tint({ factor: 0.5, nv: 0.25, hdr: false });
  const encode = (x) => (x < 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(encoded[c] - encode(linear[c])) < 2e-5);
});
