// MaterialX in USD. fixtures/real/usd-wg holds real .mtlx files and the stages that use them; fixtures/materialx/openusd.json
// is what OpenUSD's public API reads from them, with the published defaults of each surface shader, from its shader registry.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeUSDFiles, parseUSDFiles } from '../dist/compose.js';
import { materialGraph, materialX } from '../dist/materialx.js';

const here = dirname(fileURLToPath(import.meta.url)),
  real = join(here, 'fixtures', 'real', 'usd-wg'),
  truth = JSON.parse(readFileSync(join(here, 'fixtures', 'materialx', 'openusd.json'), 'utf8')),
  encode = (text) => new TextEncoder().encode(text),
  image = encode('stands in for an image, which is only decoded in a browser');
/** Reads a real file's folder. Images are not stored here, so `images` says whether they count as present. */
const reader = (folder, images = true, extra = {}) => (id) => {
  if (extra[id] !== undefined) return encode(extra[id]);
  if (/\.(png|jpe?g|exr)$/i.test(id)) return images ? image : undefined;
  const at = resolve(folder, id);
  return existsSync(at) ? new Uint8Array(readFileSync(at)) : undefined;
};
const mesh = (material) => `def Mesh "Mesh" (prepend apiSchemas = ["MaterialBindingAPI"])
{
    rel material:binding = <${material}>
    uniform token subdivisionScheme = "none"
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)] (interpolation = "vertex")
    texCoord2f[] primvars:second = [(0, 1), (1, 1), (0, 0)] (interpolation = "vertex")
}
`;
/** The material a real .mtlx gives a mesh bound to it. */
const bound = async (file, name, { images = true, over = '' } = {}) => {
  const stage = `#usda 1.0
def Scope "MaterialX" (references = @./${basename(file)}@</MaterialX>)
{
${over}
}
${mesh(`/MaterialX/Materials/${name}`)}`,
    asset = await parseUSDFiles('stage.usda', reader(join(real, dirname(file)), images, { 'stage.usda': stage }), { extensions: [materialX()] });
  return { asset, material: asset.document.materials[asset.meshes[0].material] };
};
/** A stage that holds its network in USD. */
const inline = async (network, name = '/Look') => {
  const asset = await parseUSDFiles('stage.usda', reader(here, true, { 'stage.usda': `#usda 1.0\n${network}\n${mesh(name)}` }), { extensions: [materialX()] });
  return { asset, material: asset.document.materials[asset.meshes[0].material] };
};
const near = (a, b, message) => {
  assert.equal(a.length, b.length, message);
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-5, `${message}: ${a} is not ${b}`));
};

/** What feeds an input, read from the composed specs alone, as OpenUSD's GetValueProducingAttributes answers. */
function producer(specs, prim, name) {
  let at = `${prim}.inputs:${name}`;
  for (let hops = 0; hops < 32; hops++) {
    const next = specs[at]?.fields.connectionPaths?.[0];
    if (!next) break;
    at = next;
  }
  const owner = at.slice(0, at.lastIndexOf('.'));
  if (at.includes('.outputs:')) return { node: specs[owner + '.info:id'].fields.default, prim: owner.split('/').at(-1) };
  return { value: specs[at]?.fields.default };
}
const kind = (id) => id.replace(/^ND_/, '').replace(/_(?:float|integer|boolean|color[34]|vector[234]|surfaceshader).*$/, '');

for (const [file, want] of Object.entries(truth.files)) {
  if (!Object.keys(want).length || !existsSync(join(real, file.replace('usd-wg/', '')))) continue;
  test(`the network reads as OpenUSD reads it: ${file}`, async () => {
    const local = join(real, file.replace('usd-wg/', '')),
      { specs } = await composeUSDFiles(basename(local), reader(dirname(local)), { extensions: [materialX()] });
    for (const [path, material] of Object.entries(want)) {
      let target = specs[path + '.outputs:mtlx:surface']?.fields.connectionPaths?.[0];
      assert.ok(target, `${path} has a surface`);
      // A surface may come out of a node graph, through its outputs.
      while (!specs[target.slice(0, target.lastIndexOf('.')) + '.info:id']) target = specs[target].fields.connectionPaths[0];
      const shader = target.slice(0, target.lastIndexOf('.'));
      assert.equal(shader.split('/').at(-1), material.shader);
      assert.equal(kind(specs[shader + '.info:id'].fields.default), kind(material.id));
      for (const [name, input] of Object.entries(material.inputs)) {
        const got = producer(specs, shader, name);
        if (input.node) {
          assert.equal(kind(got.node ?? ''), kind(input.node), `${path} ${name}`);
          assert.equal(got.prim, input.prim, `${path} ${name}`);
        } else if (Array.isArray(input.value)) near(got.value.flat?.() ?? Array.from(got.value), input.value, `${path} ${name}`);
        else if (typeof input.value === 'number') assert.ok(Math.abs(got.value - input.value) < 1e-5, `${path} ${name}`);
        else if (typeof input.value === 'string' && typeof got.value === 'string') assert.equal(basename(got.value), input.value, `${path} ${name}`);
        // USD text writes a bool as 0 or 1, and the readers take both; OpenUSD's Python hands back a bool.
        else if (typeof input.value === 'boolean') assert.equal(Boolean(got.value), input.value, `${path} ${name}`);
        else assert.equal(got.value, input.value, `${path} ${name}`);
      }
    }
  });
}

test('a real chess piece opens with its colour, metal, rough and normal maps', async () => {
  const { asset, material } = await bound('full_assets/OpenChessSet/assets/Pawn/Pawn_mat.mtlx', 'M_Pawn_Body_B');
  assert.equal(material.name, '/MaterialX/Materials/M_Pawn_Body_B');
  assert.notEqual(material.pbrMetallicRoughness.baseColorTexture, undefined);
  assert.notEqual(material.pbrMetallicRoughness.metallicRoughnessTexture, undefined);
  assert.notEqual(material.normalTexture, undefined);
  assert.deepEqual(asset.issues.filter((issue) => /no PBR form|unsupported/.test(issue.message)), []);
  const [color, packed] = asset.sources;
  assert.match(color.path, /pawn_black_base_color\.jpg$/);
  assert.equal(color.linearColor, undefined);
  assert.match(packed.roughness.path, /pawn_shared_roughness\.jpg$/);
  assert.match(packed.metallic.path, /pawn_shared_metallic\.jpg$/);
});

test('an image with no colour space in a linear document is linear, so it is encoded for the sRGB base colour slot', async () => {
  const { asset } = await bound('test_assets/TextureCoordinateTest/TextureCoordinateTest.mtlx', 'BottomLeftMat');
  assert.equal(asset.sources[0].linearColor, true);
});

test('a missing image is listed, with the fileprefix as OpenUSD applies it', async () => {
  const { asset, material } = await bound('test_assets/MaterialXTest/standard_surface_brass_tiled.mtlx', 'Tiled_Brass', { images: false });
  assert.ok(asset.issues.some((issue) => /missing texture textures\/\.?\/?textures\/brass_color\.jpg/.test(issue.message)), JSON.stringify(asset.issues));
  assert.equal(material.pbrMetallicRoughness.baseColorTexture, undefined);
});

test('the colour of a full coat tints the metal under it, as an image of the base', async () => {
  const { asset, material } = await bound('test_assets/MaterialXTest/standard_surface_brass_tiled.mtlx', 'Tiled_Brass');
  assert.match(asset.sources[0].path, /brass_color\.jpg$/);
  assert.notEqual(material.pbrMetallicRoughness.baseColorTexture, undefined);
  assert.equal(material.pbrMetallicRoughness.metallicFactor, 1);
  assert.equal(material.extensions.KHR_materials_clearcoat.clearcoatFactor, 1);
  assert.notEqual(material.extensions.KHR_materials_clearcoat.clearcoatRoughnessTexture, undefined);
  assert.ok(asset.document.extensionsUsed.includes('KHR_materials_clearcoat'));
});

test('real glass transmits, tinted by its transmission colour', async () => {
  const file = readFileSync(join(real, 'full_assets/StandardShaderBall/example_materials/glass.mtlx'), 'utf8'),
    name = /<surfacematerial name="([^"]+)"/.exec(file)[1],
    { material } = await bound('full_assets/StandardShaderBall/example_materials/glass.mtlx', name);
  assert.ok(material.extensions.KHR_materials_transmission.transmissionFactor > 0);
});

test('a preview surface in MaterialX reads its own inputs', async () => {
  const { material } = await bound('test_assets/MaterialXTest/usd_preview_surface_plastic.mtlx', 'USD_Plastic');
  near(material.pbrMetallicRoughness.baseColorFactor, [0.10470402, 0.24188282, 0.818, 1], 'colour');
  assert.ok(Math.abs(material.pbrMetallicRoughness.roughnessFactor - 0.32467532) < 1e-6);
});

test('an input set on the material of a USD layer beats the .mtlx', async () => {
  const over = `    over "Materials" { over "USD_Plastic" {
        color3f inputs:diffuseColor = (1, 0, 0)
        float inputs:metallic = 1
    } }`,
    { material } = await bound('test_assets/MaterialXTest/usd_preview_surface_plastic.mtlx', 'USD_Plastic', { over });
  near(material.pbrMetallicRoughness.baseColorFactor, [1, 0, 0, 1], 'colour');
  assert.equal(material.pbrMetallicRoughness.metallicFactor, 1);
});

const look = (id, inputs = '', extra = '') => `def Material "Look"
{
    token outputs:mtlx:surface.connect = </Look/Shader.outputs:surface>
    def Shader "Shader"
    {
        uniform token info:id = "${id}"
${inputs}
        token outputs:surface
    }
${extra}
}`;

for (const [id, base, rough, metal] of [
  ['ND_standard_surface_surfaceshader', 'base_color', 'specular_roughness', 'metalness'],
  ['ND_open_pbr_surface_surfaceshader', 'base_color', 'specular_roughness', 'base_metalness'],
  ['ND_UsdPreviewSurface_surfaceshader', 'diffuseColor', 'roughness', 'metallic'],
  ['ND_gltf_pbr_surfaceshader', 'base_color', 'roughness', 'metallic'],
])
  test(`an empty ${id} takes the defaults OpenUSD's registry publishes`, async () => {
    const { material } = await inline(look(id)),
      want = truth.defaults[id],
      weight = want.base ?? want.base_weight ?? 1;
    near(material.pbrMetallicRoughness.baseColorFactor.slice(0, 3), want[base].map((x) => x * weight), 'colour');
    assert.ok(Math.abs(material.pbrMetallicRoughness.roughnessFactor - want[rough]) < 1e-6);
    assert.equal(material.pbrMetallicRoughness.metallicFactor, want[metal]);
  });

test('the layers of a standard surface reach their glTF extensions', async () => {
  const { asset, material } = await inline(
    look(
      'ND_standard_surface_surfaceshader',
      `float inputs:coat = 0.5
        float inputs:coat_roughness = 0.25
        color3f inputs:coat_color = (0.5, 1, 1)
        float inputs:emission = 2
        color3f inputs:emission_color = (1, 0.5, 0)
        float inputs:sheen = 0.5
        color3f inputs:sheen_color = (1, 0.5, 0.5)
        float inputs:sheen_roughness = 0.4
        float inputs:specular = 0.5
        color3f inputs:specular_color = (1, 0.8, 0.8)
        float inputs:specular_IOR = 1.8
        float inputs:transmission = 0.5
        color3f inputs:transmission_color = (0, 0, 1)
        float inputs:thin_film_thickness = 400
        float inputs:thin_film_IOR = 1.3
        color3f inputs:opacity = (0.5, 0.5, 0.5)
        float inputs:subsurface = 1`,
    ),
  );
  const { extensions: e } = material;
  // Base 0.8 tinted by the coat (1 + (c - 1) * 0.5), then half way to the transmission colour.
  near(material.pbrMetallicRoughness.baseColorFactor, [0.3, 0.4, 0.9, 0.5], 'base');
  assert.equal(material.alphaMode, 'BLEND');
  // Emission lies under the coat too: 2 * (1, 0.5, 0) tinted by (0.75, 1, 1) is (1.5, 1, 0).
  near(material.emissiveFactor, [1, 2 / 3, 0], 'emissive');
  assert.equal(e.KHR_materials_emissive_strength.emissiveStrength, 1.5);
  assert.equal(e.KHR_materials_clearcoat.clearcoatFactor, 0.5);
  assert.equal(e.KHR_materials_clearcoat.clearcoatRoughnessFactor, 0.25);
  near(e.KHR_materials_sheen.sheenColorFactor, [0.5, 0.25, 0.25], 'sheen');
  assert.ok(Math.abs(e.KHR_materials_sheen.sheenRoughnessFactor - 0.4) < 1e-6);
  assert.equal(e.KHR_materials_specular.specularFactor, 0.5);
  assert.ok(Math.abs(e.KHR_materials_ior.ior - 1.8) < 1e-6);
  assert.equal(e.KHR_materials_transmission.transmissionFactor, 0.5);
  assert.equal(e.KHR_materials_iridescence.iridescenceThicknessMaximum, 400);
  assert.ok(asset.issues.some((issue) => /input subsurface/.test(issue.message)));
});

test('coat_affect_color and coat_affect_roughness follow the Standard Surface formulas', async () => {
  const { material } = await inline(
    look(
      'ND_standard_surface_surfaceshader',
      `float inputs:coat = 0.5
        float inputs:coat_affect_color = 1
        float inputs:coat_affect_roughness = 1
        float inputs:coat_roughness = 0.5
        float inputs:specular_roughness = 0.2
        color3f inputs:base_color = (0.5, 0.25, 1)`,
    ),
  );
  near(material.pbrMetallicRoughness.baseColorFactor.slice(0, 3), [0.5 ** 1.5, 0.25 ** 1.5, 1], 'darkened');
  // lerp(roughness, 1, coat * coat_affect_roughness * coat_roughness)
  assert.ok(Math.abs(material.pbrMetallicRoughness.roughnessFactor - (0.2 + 0.8 * 0.25)) < 1e-6);
});

for (const [id, weight, color, depth] of [
  ['ND_standard_surface_surfaceshader', 'transmission', 'transmission_color', 'transmission_depth'],
  ['ND_open_pbr_surface_surfaceshader', 'transmission_weight', 'transmission_color', 'transmission_depth'],
])
  test(`with a depth the transmission colour of ${id} belongs to the medium, not the surface`, async () => {
    const { material } = await inline(look(id, `float inputs:${weight} = 1\n        color3f inputs:${color} = (0, 0.5, 1)\n        float inputs:${depth} = 2`));
    near(material.pbrMetallicRoughness.baseColorFactor.slice(0, 3), [0.8, 0.8, 0.8], 'surface');
    assert.deepEqual(material.extensions.KHR_materials_volume, { thicknessFactor: 2, attenuationDistance: 2, attenuationColor: [0, 0.5, 1] });
  });

test('OpenPBR gives its thin film in micrometres, with a weight, and its emission in nits', async () => {
  const on = await inline(
      look(
        'ND_open_pbr_surface_surfaceshader',
        `float inputs:thin_film_weight = 0.5
        float inputs:thin_film_thickness = 0.25
        float inputs:thin_film_ior = 1.3
        float inputs:emission_luminance = 500
        color3f inputs:emission_color = (1, 0, 0)`,
      ),
    ),
    film = on.material.extensions.KHR_materials_iridescence;
  assert.equal(film.iridescenceFactor, 0.5);
  assert.equal(film.iridescenceThicknessMaximum, 250);
  assert.ok(Math.abs(film.iridescenceIor - 1.3) < 1e-6);
  near(on.material.emissiveFactor, [0.5, 0, 0], 'a soft range of 1000 nits is 1');
  const off = await inline(look('ND_open_pbr_surface_surfaceshader', 'float inputs:thin_film_thickness = 0.25'));
  assert.equal(off.material.extensions, undefined);
});

test('gltf_pbr reads alpha by its alpha_mode', async () => {
  const read = async (inputs) => (await inline(look('ND_gltf_pbr_surfaceshader', inputs))).material;
  const opaque = await read('float inputs:alpha = 0.25');
  assert.equal(opaque.alphaMode, 'OPAQUE');
  assert.equal(opaque.pbrMetallicRoughness.baseColorFactor[3], 1);
  const mask = await read('float inputs:alpha = 0.25\n        int inputs:alpha_mode = 1');
  assert.equal(mask.alphaMode, 'MASK');
  assert.equal(mask.alphaCutoff, 0.5);
  assert.equal(mask.pbrMetallicRoughness.baseColorFactor[3], 0.25);
  const cut = await read('float inputs:alpha = 0.25\n        int inputs:alpha_mode = 1\n        float inputs:alpha_cutoff = 0.125');
  assert.equal(cut.alphaCutoff, 0.125);
  const blend = await read('float inputs:alpha = 0.25\n        int inputs:alpha_mode = 2');
  assert.equal(blend.alphaMode, 'BLEND');
  assert.equal(blend.pbrMetallicRoughness.baseColorFactor[3], 0.25);
});

test('gltf_pbr holds the extensions of glTF as they are', async () => {
  const { material } = await inline(
      look(
        'ND_gltf_pbr_surfaceshader',
        `color3f inputs:sheen_color = (0.5, 0.25, 0)
        float inputs:sheen_roughness = 0.5
        float inputs:iridescence = 0.5
        float inputs:thickness = 2
        float inputs:attenuation_distance = 3
        color3f inputs:attenuation_color = (1, 0.5, 0)
        float inputs:anisotropy_strength = 0.5
        float inputs:anisotropy_rotation = 1
        float inputs:dispersion = 0.25`,
      ),
    ),
    e = material.extensions;
  near(e.KHR_materials_sheen.sheenColorFactor, [0.5, 0.25, 0], 'sheen');
  assert.equal(e.KHR_materials_sheen.sheenRoughnessFactor, 0.5);
  assert.equal(e.KHR_materials_iridescence.iridescenceFactor, 0.5);
  assert.equal(e.KHR_materials_iridescence.iridescenceThicknessMaximum, 100);
  assert.ok(Math.abs(e.KHR_materials_iridescence.iridescenceIor - 1.3) < 1e-6);
  assert.deepEqual(e.KHR_materials_volume, { thicknessFactor: 2, attenuationDistance: 3, attenuationColor: [1, 0.5, 0] });
  assert.deepEqual(e.KHR_materials_anisotropy, { anisotropyStrength: 0.5, anisotropyRotation: 1 });
  assert.deepEqual(e.KHR_materials_dispersion, { dispersion: 0.25 });
  assert.equal((await inline(look('ND_gltf_pbr_surfaceshader'))).material.extensions, undefined);
});

test('colour spaces go by the names of the specification, old and new', async () => {
  const value = async (space) =>
    (await inline(look('ND_standard_surface_surfaceshader', `color3f inputs:base_color = (0.5, 0.5, 0.5) (colorSpace = "${space}")`))).material.pbrMetallicRoughness.baseColorFactor[0];
  assert.ok(Math.abs((await value('srgb_texture')) - 0.21404114) < 1e-6);
  assert.ok(Math.abs((await value('srgb_rec709_scene')) - 0.21404114) < 1e-6);
  assert.equal(await value('lin_rec709_scene'), 0.5);
  assert.equal(await value('data'), 0.5);
  const other = await inline(look('ND_standard_surface_surfaceshader', 'color3f inputs:base_color = (0.5, 0.5, 0.5) (colorSpace = "acescg")'));
  assert.ok(other.asset.issues.some((issue) => /colour space acescg/.test(issue.message)));
  const image = async (space) =>
    (await inline(look('ND_standard_surface_surfaceshader', 'color3f inputs:base_color.connect = </Look/Map.outputs:out>', `def Shader "Map"
    {
        uniform token info:id = "ND_image_color3"
        asset inputs:file = @map.png@ (colorSpace = "${space}")
        color3f outputs:out
    }`))).asset.sources[0].linearColor;
  assert.equal(await image('lin_rec709_scene'), true);
  assert.equal(await image('data'), true);
  assert.equal(await image('srgb_rec709_scene'), undefined);
});

test('a UsdUVTexture scales, and its colour space and fallback are its own inputs', async () => {
  const map = (extra) => `def Shader "Map"
    {
        uniform token info:id = "ND_UsdUVTexture"
        asset inputs:file = @${extra.file ?? 'map.png'}@
        token inputs:sourceColorSpace = "raw"
        ${extra.lines ?? ''}
        color3f outputs:rgb
    }`,
    read = (extra) => inline(look('ND_UsdPreviewSurface_surfaceshader', 'color3f inputs:diffuseColor.connect = </Look/Map.outputs:rgb>', map(extra)));
  const scaled = await read({ lines: 'float4 inputs:scale = (0.5, 0.25, 1, 1)' });
  near(scaled.material.pbrMetallicRoughness.baseColorFactor, [0.5, 0.25, 1, 1], 'scale');
  assert.equal(scaled.asset.sources[0].linearColor, true);
  const biased = await read({ lines: 'float4 inputs:bias = (0.5, 0, 0, 0)' });
  assert.ok(biased.asset.issues.some((issue) => /bias of \/Look\/Map/.test(issue.message)));
  const lost = await parseUSDFiles(
    'stage.usda',
    reader(here, false, {
      'stage.usda': `#usda 1.0\n${look('ND_UsdPreviewSurface_surfaceshader', 'color3f inputs:diffuseColor.connect = </Look/Map.outputs:rgb>', map({ lines: 'float4 inputs:fallback = (0, 1, 0, 1)' }))}\n${mesh('/Look')}`,
    }),
    { extensions: [materialX()] },
  );
  near(lost.document.materials[lost.meshes[0].material].pbrMetallicRoughness.baseColorFactor, [0, 1, 0, 1], 'fallback');
});

test('an image that cannot be read gives its default, which is zero when unset', async () => {
  const stage = (lines) => `#usda 1.0\n${look('ND_standard_surface_surfaceshader', 'color3f inputs:base_color.connect = </Look/Map.outputs:out>', `def Shader "Map"
    {
        uniform token info:id = "ND_image_color3"
        asset inputs:file = @map.png@
        ${lines}
        color3f outputs:out
    }`)}\n${mesh('/Look')}`,
    open = async (lines) => {
      const asset = await parseUSDFiles('stage.usda', reader(here, false, { 'stage.usda': stage(lines) }), { extensions: [materialX()] });
      return asset.document.materials[asset.meshes[0].material].pbrMetallicRoughness.baseColorFactor;
    };
  near(await open(''), [0, 0, 0, 1], 'unset');
  near(await open('color3f inputs:default = (0, 0, 1)'), [0, 0, 1, 1], 'set');
});

test('multiply takes zero for an unset in1 and one for an unset in2, by the Standard Nodes', async () => {
  const read = async (lines) =>
    (await inline(look('ND_standard_surface_surfaceshader', 'float inputs:metalness.connect = </Look/Times.outputs:out>', `def Shader "Times"
    {
        uniform token info:id = "ND_multiply_float"
        ${lines}
        float outputs:out
    }`))).material.pbrMetallicRoughness.metallicFactor;
  assert.equal(await read('float inputs:in2 = 0.5'), 0);
  assert.equal(await read('float inputs:in1 = 0.5'), 0.5);
});

test('a preview surface in the specular workflow is listed: glTF has no direct form of it', async () => {
  const { asset } = await inline(look('ND_UsdPreviewSurface_surfaceshader', 'int inputs:useSpecularWorkflow = 1'));
  assert.ok(asset.issues.some((issue) => /input useSpecularWorkflow/.test(issue.message)));
});

test('RealityKit surfaces and textures read by their published definitions', async () => {
  const { asset, material } = await inline(
    look(
      'ND_realitykit_pbr_surfaceshader',
      `color3f inputs:baseColor.connect = </Look/Map.outputs:out>
        float inputs:roughness = 0.7
        float inputs:metallic = 0.25
        float inputs:opacity = 0.5
        float inputs:opacityThreshold = 0.25
        float inputs:clearcoat = 1`,
      `def Shader "Map"
    {
        uniform token info:id = "ND_RealityKitTexture2D_color3"
        asset inputs:file = @map.png@ (colorSpace = "srgb_texture")
        string inputs:u_wrap_mode = "clamp_to_edge"
        string inputs:v_wrap_mode = "mirrored_repeat"
        color3f outputs:out
    }`,
    ),
  );
  assert.equal(asset.sources[0].path, 'map.png');
  assert.deepEqual(asset.document.samplers[0], { wrapS: 33071, wrapT: 33648 });
  assert.equal(material.pbrMetallicRoughness.roughnessFactor, 0.7);
  assert.equal(material.alphaMode, 'MASK');
  assert.equal(material.alphaCutoff, 0.25);
  assert.equal(material.extensions.KHR_materials_clearcoat.clearcoatFactor, 1);
});

test('an unlit surface is unlit', async () => {
  for (const [id, inputs] of [
    ['ND_surface_unlit', 'float inputs:emission = 0.5\n        color3f inputs:emission_color = (1, 0, 1)'],
    ['ND_realitykit_unlit_surfaceshader', 'color3f inputs:color = (0.5, 0, 0.5)'],
  ]) {
    const { material } = await inline(look(id, inputs));
    assert.deepEqual(material.extensions.KHR_materials_unlit, {});
    near(material.pbrMetallicRoughness.baseColorFactor, [0.5, 0, 0.5, 1], id);
  }
});

const chain = `def Shader "Map"
    {
        uniform token info:id = "ND_tiledimage_color3"
        asset inputs:file = @map.png@ (colorSpace = "srgb_texture")
        float2 inputs:uvtiling = (2, 4)
        float2 inputs:texcoord.connect = </Look/Coords.outputs:out>
        color3f outputs:out
    }
    def Shader "Coords"
    {
        uniform token info:id = "ND_geompropvalue_vector2"
        string inputs:geomprop = "second"
        float2 outputs:out
    }
    def Shader "Times"
    {
        uniform token info:id = "ND_multiply_color3FA"
        color3f inputs:in1.connect = </Look/Map.outputs:out>
        float inputs:in2 = 0.5
        color3f outputs:out
    }
    def Shader "Pick"
    {
        uniform token info:id = "ND_switch_color3"
        color3f inputs:in1 = (1, 0, 0)
        color3f inputs:in2.connect = </Look/Times.outputs:out>
        float inputs:which = 1.5
        color3f outputs:out
    }`;

test('a graph that comes to an image scaled by a constant is that image, tiled, on the primvar it names', async () => {
  const { asset, material } = await inline(look('ND_standard_surface_surfaceshader', 'color3f inputs:base_color.connect = </Look/Pick.outputs:out>', chain)),
    { baseColorTexture, baseColorFactor } = material.pbrMetallicRoughness;
  near(baseColorFactor, [0.5, 0.5, 0.5, 1], 'factor');
  assert.deepEqual(baseColorTexture.extensions.KHR_texture_transform, { offset: [0, -3], rotation: 0, scale: [2, 4] });
  // The texture reads `second`, which is v up in USD, so its first point is at v 1 - 1.
  assert.equal(asset.meshes[0].uvs[1], 1);
});

test('a constant graph folds, by the formulas of the Standard Nodes', async () => {
  const { material } = await inline(
    look(
      'ND_standard_surface_surfaceshader',
      'float inputs:metalness.connect = </Look/Second.outputs:out>\n        float inputs:specular_roughness.connect = </Look/Blend.outputs:out>',
      `def Shader "Second"
    {
        uniform token info:id = "ND_extract_vector3"
        float3 inputs:in = (0.1, 0.2, 0.3)
        int inputs:index = 1
        float outputs:out
    }
    def Shader "Blend"
    {
        uniform token info:id = "ND_mix_float"
        float inputs:fg = 1
        float inputs:bg = 0.5
        float inputs:mix = 0.25
        float outputs:out
    }`,
    ),
  );
  assert.ok(Math.abs(material.pbrMetallicRoughness.metallicFactor - 0.2) < 1e-6);
  assert.ok(Math.abs(material.pbrMetallicRoughness.roughnessFactor - 0.625) < 1e-6);
});

test('what a PBR material cannot hold is listed, and the rest still reads', async () => {
  const { asset, material } = await inline(
    look('ND_standard_surface_surfaceshader', 'color3f inputs:base_color.connect = </Look/Noise.outputs:out>\n        float inputs:metalness = 1', 'def Shader "Noise"\n    {\n        uniform token info:id = "ND_noise2d_color3"\n        color3f outputs:out\n    }'),
  );
  assert.equal(material.pbrMetallicRoughness.metallicFactor, 1);
  assert.ok(asset.issues.some((issue) => /ND_noise2d_color3 .* no PBR form/.test(issue.message)), JSON.stringify(asset.issues));
});

test('a material with both outputs takes the MaterialX one, and a plain preview surface stays as it was', async () => {
  const both = `def Material "Look"
{
    token outputs:surface.connect = </Look/Plain.outputs:surface>
    token outputs:mtlx:surface.connect = </Look/Rich.outputs:surface>
    def Shader "Plain"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor = (1, 0, 0)
        token outputs:surface
    }
    def Shader "Rich"
    {
        uniform token info:id = "ND_standard_surface_surfaceshader"
        color3f inputs:base_color = (0, 1, 0)
        token outputs:surface
    }
}`;
  near((await inline(both)).material.pbrMetallicRoughness.baseColorFactor, [0, 1, 0, 1], 'rich');
  const plain = both.replace(/ *token outputs:mtlx:surface.*\n/, '');
  near((await inline(plain)).material.pbrMetallicRoughness.baseColorFactor, [1, 0, 0, 1], 'plain');
});

test('a surface that comes out of a node graph reads', async () => {
  const { material } = await inline(`def Material "Look"
{
    token outputs:mtlx:surface.connect = </Look/Graph.outputs:out>
    def NodeGraph "Graph"
    {
        token outputs:out.connect = </Look/Graph/Shader.outputs:out>
        def Shader "Shader"
        {
            uniform token info:id = "ND_open_pbr_surface_surfaceshader"
            color3f inputs:base_color = (0, 1, 0)
            token outputs:out
        }
    }
}`);
  near(material.pbrMetallicRoughness.baseColorFactor, [0, 1, 0, 1], 'colour');
});

test('a .mtlx brings in what it includes', async () => {
  const stage = `#usda 1.0
def Scope "MaterialX" (references = @./top.mtlx@</MaterialX>) {}
${mesh('/MaterialX/Materials/Shared')}`,
    extra = {
      'stage.usda': stage,
      'top.mtlx': '<materialx version="1.39"><xi:include href="lib/shared.mtlx"/></materialx>',
      'lib/shared.mtlx': `<materialx version="1.39"><standard_surface name="S" type="surfaceshader"><input name="base_color" type="color3" value="0, 0, 1"/></standard_surface>
<surfacematerial name="Shared" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial></materialx>`,
    },
    asset = await parseUSDFiles('stage.usda', reader(here, true, extra), { extensions: [materialX()] });
  near(asset.document.materials[asset.meshes[0].material].pbrMetallicRoughness.baseColorFactor, [0, 0, 1, 1], 'included');
});

test('an included document takes the working colour space of the one that includes it, unless it names its own', async () => {
  const open = async (attribute) => {
    const stage = `#usda 1.0
def Scope "MaterialX" (references = @./top.mtlx@</MaterialX>) {}
${mesh('/MaterialX/Materials/Shared')}`,
      extra = {
        'stage.usda': stage,
        'top.mtlx': '<materialx version="1.39" colorspace="srgb_texture"><xi:include href="shared.mtlx"/></materialx>',
        'shared.mtlx': `<materialx version="1.39"${attribute}><standard_surface name="S" type="surfaceshader"><input name="base_color" type="color3" value="0.5, 0.5, 0.5"/></standard_surface>
<surfacematerial name="Shared" type="material"><input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial></materialx>`,
      },
      asset = await parseUSDFiles('stage.usda', reader(here, true, extra), { extensions: [materialX()] });
    return asset.document.materials[asset.meshes[0].material].pbrMetallicRoughness.baseColorFactor[0];
  };
  assert.ok(Math.abs((await open('')) - 0.21404114) < 1e-6);
  assert.equal(await open(' colorspace="lin_rec709"'), 0.5);
});

test('without the entry a .mtlx layer stays unsupported', async () => {
  const stage = `#usda 1.0\ndef Scope "MaterialX" (references = @./a.mtlx@</MaterialX>) {}\n${mesh('/MaterialX/Materials/A')}`,
    asset = await parseUSDFiles('stage.usda', reader(here, true, { 'stage.usda': stage, 'a.mtlx': '<materialx version="1.39"/>' }));
  assert.ok(asset.issues.some((issue) => issue.code === 'unsupported-layer'));
});

test('a .mtlx that cannot be read is listed, and the stage opens', async () => {
  const stage = `#usda 1.0\ndef Scope "MaterialX" (references = @./a.mtlx@</MaterialX>) {}\n${mesh('/MaterialX/Materials/A')}`,
    extra = { 'stage.usda': stage, 'a.mtlx': '<materialx version="1.39"><standard_surface name="S" type="surfaceshader"><input name="base" type="float" value="x"/></standard_surface></materialx>' },
    asset = await parseUSDFiles('stage.usda', reader(here, true, extra), { extensions: [materialX()] });
  assert.ok(asset.issues.some((issue) => issue.code === 'bad-layer' && /a\.mtlx/.test(issue.message)), JSON.stringify(asset.issues));
});

test('a node kind named after an Object member is an unknown kind', async () => {
  const { asset } = await inline(look('ND_constructor_surfaceshader'));
  assert.ok(asset.issues.some((issue) => /unsupported surface shader ND_constructor_surfaceshader/.test(issue.message)));
});

test('materialGraph gives the whole network as a node material graph', async () => {
  const { asset } = await bound('full_assets/OpenChessSet/assets/Pawn/Pawn_mat.mtlx', 'M_Pawn_Body_B'),
    asked = [],
    view = {},
    result = await materialGraph(asset, '/MaterialX/Materials/M_Pawn_Body_B', {
      texture(request) {
        asked.push(request);
        return { view };
      },
    }),
    [emit] = result.graph.nodes;
  assert.equal(emit.type, 'emit');
  assert.equal(emit.color.type, 'texture');
  assert.equal(emit.metalRough.roughness.type, 'texture');
  assert.equal(emit.normal.type, 'normalMap');
  assert.deepEqual(result.skipped, []);
  const color = asked.find((request) => /base_color/.test(request.file));
  assert.equal(color.colorspace, 'srgb_texture');
  assert.equal(await materialGraph(asset, '/No/Such/Material'), undefined);
});

test('materialGraph holds a RealityKit surface and lists an image it has no hook for', async () => {
  const { asset } = await inline(look('ND_realitykit_pbr_surfaceshader', 'color3f inputs:baseColor.connect = </Look/Map.outputs:out>\n        float inputs:roughness = 0.75', 'def Shader "Map"\n    {\n        uniform token info:id = "ND_image_color3"\n        asset inputs:file = @map.png@\n        color3f outputs:out\n    }')),
    result = await materialGraph(asset, 0);
  assert.equal(result.graph.nodes[0].metalRough.roughness.value, 0.75);
  assert.ok(result.skipped.some((item) => /needs options.texture/.test(item.reason)));
});
