// toGraph against MaterialX itself (KB3108). Two parts:
// 1. Eight of our own MaterialX documents (fixtures/materialx-reference, rebuilt by oracle/materialx-bake.py) were baked
//    to textures by MaterialX 1.39.5's GLSL baker. Each converted graph is evaluated here per texel with the node
//    material's own semantics (a texture is linear RGBA after its colour space; add, mul and mix broadcast a scalar and
//    mix component-wise) and compared with the converted baked document, 8-bit sRGB code for code.
// 2. The 26 example materials of MaterialX v1.39.5 (fixtures/materialx-examples, Apache-2.0) all convert, and each one
//    skips exactly the inputs named below: shader inputs the node material has no slot for.
// The GPU side of part 1 is materialx-reference-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseMaterialX } from '../dist/materialx.js';
import { decodePNG } from '../../../tests/support/png.js';

const here = new URL('./fixtures/', import.meta.url);
const read = (path) => readFileSync(new URL(path, here));
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toCode = (v) => {
  const c = Math.min(1, Math.max(0, v));
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
};

/** Converts `folder/name` with images decoded on the CPU; returns the emit node and what was skipped. */
async function convert(folder, name) {
  const url = new URL(`materialx-reference/${folder}/`, here);
  const { graph, skipped } = await parseMaterialX(readFileSync(new URL(name, url), 'utf8')).toGraph(undefined, {
    texture: async ({ file, colorspace }) => {
      const image = await decodePNG(new Uint8Array(readFileSync(new URL(file, url))));
      return { view: { image, srgb: colorspace === 'srgb_texture' } };
    },
  });
  return { emit: graph.nodes.find((node) => node.type === 'emit'), skipped };
}

/** One value node at texel (x, y), as the node material shader computes it: an array of 1 or 4 numbers. */
function evaluate(node, x, y) {
  switch (node.type) {
    case 'scalar':
      return [node.value];
    case 'color':
      return [...node.value];
    case 'texture': {
      const { image, srgb } = node.texture.view,
        o = (y * image.width + x) * 4,
        channel = (c) => image.data[o + c] / 255;
      const rgba = [0, 1, 2].map((c) => (srgb ? toLinear(channel(c)) : channel(c))).concat(channel(3));
      return node.channel === undefined ? rgba : [rgba[node.channel]];
    }
    case 'add':
    case 'mul':
    case 'mix': {
      const a = evaluate(node.a, x, y),
        b = evaluate(node.b, x, y),
        f = node.type === 'mix' ? evaluate(node.factor, x, y) : [0],
        width = Math.max(a.length, b.length),
        at = (v, i) => v[v.length === 1 ? 0 : i];
      return Array.from({ length: width }, (_, i) =>
        node.type === 'add'
          ? at(a, i) + at(b, i)
          : node.type === 'mul'
            ? at(a, i) * at(b, i)
            : at(a, i) + (at(b, i) - at(a, i)) * at(f, i),
      );
    }
    default:
      throw new Error(`no evaluator for ${node.type}`);
  }
}

const cases = readdirSync(new URL('materialx-reference/', here), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test('KB3108: the reference fixtures hold the eight documents the bake script writes', () => {
  assert.deepEqual(cases, [
    'add-subtract',
    'gltf-image',
    'image-linear',
    'image-srgb',
    'mix',
    'multiply',
    'preview-image',
    'weight',
  ]);
});

for (const name of cases)
  test(`KB3108: toGraph of ${name} matches its MaterialX 1.39.5 bake on every texel`, async () => {
    const source = await convert(name, 'source.mtlx'),
      baked = await convert(name, 'baked.mtlx');
    assert.deepEqual(source.skipped, []);
    assert.deepEqual(baked.skipped, []);
    let worst = 0;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const ours = evaluate(source.emit.color, x, y),
          theirs = evaluate(baked.emit.color, x, y);
        for (let c = 0; c < 3; c++) {
          // Every fixture stays within 0 to 1, so no comparison rests on the clamp an 8-bit bake applies.
          assert.ok(ours[c] >= 0 && ours[c] <= 1, `${name}: texel ${x},${y} channel ${c} is ${ours[c]}`);
          worst = Math.max(worst, Math.abs(toCode(ours[c]) - toCode(theirs[c])));
        }
      }
    // The bake stores 8-bit sRGB, so one code of rounding is the most that can differ.
    assert.ok(worst <= 1, `${name}: ${worst} sRGB codes apart`);
  });

/** Inputs each example skips: the node material has no specular weight or colour, anisotropy, sheen, subsurface,
 * emission, opacity, thin film, dispersion or occlusion slot (docs/limits.md, MaterialX row). */
const SKIPS = {
  gltf_pbr_carpaint: [],
  gltf_pbr_default:
    'occlusion specular specular_color alpha alpha_mode alpha_cutoff iridescence iridescence_ior iridescence_thickness sheen_color sheen_roughness clearcoat_normal emissive emissive_strength thickness attenuation_distance attenuation_color',
  gltf_pbr_glass: [],
  gltf_pbr_gold: [],
  gltf_pbr_plastic: [],
  open_pbr_aluminum_brushed: 'specular_color specular_roughness_anisotropy',
  open_pbr_carpaint: 'coat_ior',
  open_pbr_default:
    'base_diffuse_roughness specular_weight specular_color specular_roughness_anisotropy transmission_color transmission_depth transmission_scatter transmission_scatter_anisotropy transmission_dispersion_scale transmission_dispersion_abbe_number subsurface_weight subsurface_color subsurface_radius subsurface_radius_scale subsurface_scatter_anisotropy fuzz_weight fuzz_color fuzz_roughness coat_color coat_roughness_anisotropy coat_ior coat_darkening thin_film_weight thin_film_thickness thin_film_ior emission_luminance emission_color geometry_opacity geometry_thin_walled',
  open_pbr_glass: 'transmission_dispersion_abbe_number transmission_dispersion_scale',
  open_pbr_pearl:
    'subsurface_weight subsurface_color subsurface_radius_scale coat_ior thin_film_weight thin_film_thickness thin_film_ior',
  standard_surface_carpaint: 'specular specular_color specular_anisotropy',
  standard_surface_chrome: 'specular specular_color',
  standard_surface_copper: 'specular coat_color',
  standard_surface_default:
    'diffuse_roughness specular specular_color specular_anisotropy specular_rotation transmission_color transmission_depth transmission_scatter transmission_scatter_anisotropy transmission_dispersion transmission_extra_roughness subsurface subsurface_color subsurface_radius subsurface_scale subsurface_anisotropy sheen sheen_color sheen_roughness thin_walled coat_color coat_anisotropy coat_rotation coat_IOR coat_affect_color coat_affect_roughness thin_film_thickness thin_film_IOR emission emission_color opacity',
  standard_surface_glass:
    'specular specular_color transmission_color transmission_depth transmission_scatter transmission_scatter_anisotropy transmission_dispersion transmission_extra_roughness opacity',
  standard_surface_glass_tinted: 'specular specular_color transmission_color',
  standard_surface_gold: 'specular specular_color',
  standard_surface_greysphere: [],
  standard_surface_jade: 'specular_anisotropy subsurface subsurface_color',
  standard_surface_plastic: [],
  standard_surface_velvet: 'specular specular_color sheen sheen_color sheen_roughness',
  usd_preview_surface_carpaint: [],
  usd_preview_surface_default:
    'emissiveColor useSpecularWorkflow specularColor opacity opacityMode opacityThreshold displacement occlusion',
  usd_preview_surface_glass: 'useSpecularWorkflow opacity opacityThreshold',
  usd_preview_surface_gold: [],
  usd_preview_surface_plastic: [],
};

test('KB3108: all 26 MaterialX v1.39.5 example materials convert, skipping only the named inputs', async () => {
  const dir = new URL('materialx-examples/', here),
    files = readdirSync(dir).filter((file) => file.endsWith('.mtlx'));
  assert.deepEqual(files.map((file) => file.slice(0, -5)).sort(), Object.keys(SKIPS).sort());
  for (const file of files) {
    const doc = parseMaterialX(read(`materialx-examples/${file}`).toString('utf8'));
    assert.equal(doc.materials.length, 1, file);
    const [material] = doc.materials,
      { graph, skipped } = await doc.toGraph();
    const expected = SKIPS[file.slice(0, -5)];
    assert.deepEqual(
      skipped.map((skip) => skip.input),
      typeof expected === 'string' ? expected.split(' ') : expected,
      file,
    );
    // Every skipped name is an input the document sets, never a made-up one.
    for (const { input } of skipped) assert.ok(input in material.shader.inputs, `${file}: ${input}`);
    const emit = graph.nodes.find((node) => node.type === 'emit');
    assert.ok(emit?.metalRough, file);
  }
});
