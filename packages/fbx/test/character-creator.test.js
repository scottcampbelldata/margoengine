// characterCreator: Character Creator's material json, built here in its own layout (Object > Meshes > Materials with
// Textures and a Custom Shader), read into small text FBX files whose material carries the json's names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePNG } from '@margoengine/decoders/png';
import { encodePNG } from '@margoengine/exporters/capture';
import { convertFBX } from '../dist/index.js';
import { pbrMaterials } from '../dist/pbr.js';
import { characterCreator, eyeOcclusionAlpha, microNormalVariance } from '../dist/character-creator.js';
import { rigFixture, readGLB } from './native-scene-helper.js';

const grey = (v, size = 2) => {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set([v, v, v, 255], i);
  return encodePNG({ width: size, height: size, data });
};
function fbx(name) {
  const source = rigFixture({
    skin: false,
    morph: false,
    animation: false,
    geometric: [0, 0, 0],
    meshTranslation: [0, 0, 0],
    extraModel: `Material: 100, "Material::${name}", "" {\n Properties70: {\n }\n}`,
    extraConnections: 'C: "OO",100,2',
  });
  return new TextEncoder().encode(
    source.replace(
      'PolygonVertexIndex: *3 {',
      'LayerElementUV: 0 {\n MappingInformationType: "ByVertice"\n ReferenceInformationType: "Direct"\n UV: *6 { a: 0,0,1,0,0,1 }\n}\nPolygonVertexIndex: *3 {',
    ),
  );
}
/** A json as Character Creator writes it, for one mesh and these materials. */
const json = (materials) => ({
  man: { Version: '1.10', Object: { man: { Generation: 'RL_CC3_Plus', Meshes: { CC_Base_Body: { Materials: materials } } } } },
});
const files = (map) => async (url) => map[new URL(url).pathname.replace(/^\//, '')];
const material = async (name, cc, map = {}) => {
  const glb = await convertFBX(fbx(name), {
    extensions: [pbrMaterials, characterCreator(cc, { base: 'https://assets.example/man.json', read: files(map) })],
    resourcePath: 'https://assets.example/',
    fetch: async () => new Response('', { status: 404 }),
  });
  const { doc, bin } = readGLB(glb),
    image = (info) => {
      const view = doc.bufferViews[doc.images[doc.textures[info.index].source].bufferView];
      return decodePNG(new Uint8Array(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0), view.byteLength));
    };
  return { m: doc.materials[0], image };
};

test('skin: the exported roughness, metallic and AO maps land in glTF roughness green, metalness blue and occlusion', async () => {
  const cc = json({
    Std_Skin_Head: {
      'Two Side': true,
      Textures: {
        'Base Color': { 'Texture Path': 'Std_Skin_Head_Diffuse.jpg', Strength: 100 },
        Roughness: { 'Texture Path': './textures/head/Std_Skin_Head_roughness.png', Strength: 100 },
        Metallic: { 'Texture Path': './textures/head/Std_Skin_Head_metallic.png', Strength: 100 },
        AO: { 'Texture Path': './textures/head/Std_Skin_Head_ao.png', Strength: 60 },
      },
      'Custom Shader': { 'Shader Name': 'RLHead', Variable: {} },
    },
  });
  const { m, image } = await material('Std_Skin_Head', cc, {
    'textures/head/Std_Skin_Head_roughness.png': await grey(140),
    'textures/head/Std_Skin_Head_metallic.png': await grey(0),
    'textures/head/Std_Skin_Head_ao.png': await grey(200),
  });
  const mr = image(m.pbrMetallicRoughness.metallicRoughnessTexture);
  assert.deepEqual([...mr.data.slice(0, 3)], [255, 140, 0]);
  assert.equal(m.pbrMetallicRoughness.roughnessFactor ?? 1, 1);
  assert.equal(m.pbrMetallicRoughness.metallicFactor ?? 1, 1);
  assert.equal(m.occlusionTexture.strength, 0.6);
  assert.equal(m.doubleSided, true);
  assert.equal(m.extras.characterCreator.shader, 'RLHead');
});

/** A 2 by 2 tangent-space normal map whose texels lean +x and -x by `x` (texel values as an 8-bit map stores them). */
const leaning = (x) => {
  const v = Math.round(((x + 1) / 2) * 255),
    w = Math.round(((-x + 1) / 2) * 255),
    data = new Uint8Array([v, 128, 255, 255, w, 128, 255, 255, w, 128, 255, 255, v, 128, 255, 255]);
  return { width: 2, height: 2, data };
};
test('skin micro normals widen the roughness by their slope variance, after the micro roughness scale', async () => {
  // The map leans +-0.5: slopes +-x / z, variance (x / z)^2 in x and 0 in y.
  const normal = leaning(0.5),
    x = (normal.data[0] / 255) * 2 - 1,
    y = (128 / 255) * 2 - 1,
    slope = x / Math.sqrt(1 - x * x - y * y);
  assert.ok(Math.abs(microNormalVariance(normal) - slope * slope) < 1e-9);
  const skin = (mask) =>
    json({
      Std_Skin_Body: {
        Textures: { Roughness: { 'Texture Path': './textures/body/rough.png', Strength: 100 } },
        'Custom Shader': {
          'Shader Name': 'RLSkin',
          Image: {
            MicroNormal: { 'Texture Path': './textures/head/micro.png' },
            ...(mask ? { MicroNormalMask: { 'Texture Path': './textures/body/mask.png' } } : {}),
          },
          Variable: { 'MicroNormal Strength': 0.5, 'Micro Roughness Scale': 0.1 },
        },
      },
    });
  const files = {
    'textures/body/rough.png': await grey(140),
    'textures/head/micro.png': await encodePNG(normal),
    'textures/body/mask.png': await grey(0),
  };
  const r = 140 / 255 + 0.1,
    expected = Math.round(255 * Math.sqrt(Math.sqrt(r ** 4 + 0.25 * slope * slope)));
  const full = await material('Std_Skin_Body', skin(false), files);
  const widened = full.image(full.m.pbrMetallicRoughness.metallicRoughnessTexture).data[1];
  assert.equal(widened, expected);
  assert.ok(widened > 140 + 25, `micro detail roughens the bare map: ${widened}`);
  // A mask of 0 keeps the micro normals off; the scale still applies.
  const masked = await material('Std_Skin_Body', skin(true), files);
  assert.equal(masked.image(masked.m.pbrMetallicRoughness.metallicRoughnessTexture).data[1], Math.round(255 * r));
});

/** An uncompressed 32-bit Targa, top-left origin, every pixel [r, g, b, a]. */
const targa = ([r, g, b, a], size = 2) => {
  const bytes = new Uint8Array(18 + size * size * 4);
  bytes.set([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, size, 0, size, 0, 32, 0x28]);
  for (let i = 18; i < bytes.length; i += 4) bytes.set([b, g, r, a], i);
  return bytes;
};

// The head shader scales roughness per region of the face over its masks' channels (Character Creator 4 manual, "Digital
// Human Shader > Head > Roughness"): the upper lid (blue of the Nose Mouth UpperInnerLid mask) wetter by 0.3, and the
// uncovered skin by Unmasked Roughness Scale.
test('head roughness takes the region scales over their Targa masks, and the unmasked scale where none reaches', async () => {
  const head = (variables) =>
    json({
      Std_Skin_Head: {
        Textures: { Roughness: { 'Texture Path': './textures/head/rough.png', Strength: 100 } },
        'Custom Shader': {
          'Shader Name': 'RLHead',
          Image: { 'Nose Mouth UpperInnerLid Mask': { 'Texture Path': './textures/head/NMUILMask.tga' } },
          Variable: variables,
        },
      },
    });
  const lid = {
      'textures/head/rough.png': await grey(140),
      'textures/head/NMUILMask.tga': targa([0, 0, 255, 0]),
    },
    bare = { ...lid, 'textures/head/NMUILMask.tga': targa([0, 0, 0, 0]) },
    green = async (variables, files) => {
      const got = await material('Std_Skin_Head', head(variables), files);
      return got.image(got.m.pbrMetallicRoughness.metallicRoughnessTexture).data[1];
    };
  assert.equal(await green({ 'UpperLid Roughness Scale': -0.3, 'Nose Roughness Scale': 0.2 }, lid), Math.round(255 * (140 / 255 - 0.3)));
  assert.equal(await green({ 'UpperLid Roughness Scale': -0.3, 'Unmasked Roughness Scale': 0.1 }, bare), Math.round(255 * (140 / 255 + 0.1)));
});

test('a material the json does not name, and a missing map, leave the FBX material as it was', async () => {
  const cc = json({ Std_Skin_Head: { Textures: { AO: { 'Texture Path': './gone/ao.png' } } } });
  const other = (await material('Boxers', cc)).m;
  assert.equal(other.occlusionTexture, undefined);
  assert.equal(other.extras?.characterCreator, undefined);
  const head = (await material('Std_Skin_Head', cc)).m;
  assert.equal(head.occlusionTexture, undefined);
  assert.throws(() => characterCreator({ nothing: 1 }), /no materials/);
});

test('eye occlusion: a soft shadow under the top lid fading to clear in the middle of the eye', async () => {
  const variables = {
    'Shadow Strength': 0.5,
    'Shadow Color': [178, 126, 109],
    'Shadow Top': 0.257,
    'Shadow Top Range': 1,
    'Shadow Top Arc': 1,
    'Shadow Bottom': 0.05,
    'Shadow Bottom Range': 0.3,
    'Shadow Inner Corner': 0.25,
    'Shadow Outer Corner': 0.2,
    'Shadow2 Strength': 0.412,
    'Shadow2 Color': [60, 41, 36],
    'Shadow2 Top': 0.088,
  };
  const a = eyeOcclusionAlpha(variables, 64, 64),
    alpha = (u, v) => a.data[(Math.floor(v * 63) * 64 + Math.floor(u * 63)) * 4 + 3];
  // Darkest at the top lid in the middle, clear at the centre of the eye, the top darker than the bottom.
  assert.ok(alpha(0.5, 0) > 120, `top ${alpha(0.5, 0)}`);
  assert.equal(alpha(0.5, 0.5), 0);
  assert.ok(alpha(0.5, 0) > alpha(0.5, 1));
  assert.ok(alpha(0.5, 0.1) < alpha(0.5, 0) && alpha(0.5, 0.1) > alpha(0.5, 0.2), 'fades down from the lid');
  // The tear duct corner keeps more shadow than the outer one at mid height (0.25 against 0.2 of the width).
  assert.ok(alpha(0.83, 0.5) > alpha(0.17, 0.5), `inner ${alpha(0.83, 0.5)} outer ${alpha(0.17, 0.5)}`);
  const cc = json({
    Std_Eye_Occlusion_R: { 'Two Side': true, 'Custom Shader': { 'Shader Name': 'RLEyeOcclusion', Variable: variables } },
  });
  const { m, image } = await material('Std_Eye_Occlusion_R', cc);
  assert.equal(m.alphaMode, 'BLEND');
  assert.ok(m.extensions.KHR_materials_unlit);
  const map = image(m.pbrMetallicRoughness.baseColorTexture);
  assert.equal(map.data[3 + 4 * Math.floor(map.width / 2)] > 120, true);
});

test('tear line: a clear glossy strip with the shader roughness', async () => {
  const cc = json({ Std_Tearline_L: { 'Custom Shader': { 'Shader Name': 'RLEyeTearline', Variable: { _Roughness: 0.1 } } } });
  const { m } = await material('Std_Tearline_L', cc);
  assert.equal(m.alphaMode, 'BLEND');
  assert.ok(Math.abs(m.pbrMetallicRoughness.roughnessFactor - 0.1) < 1e-6);
  assert.ok(m.pbrMetallicRoughness.baseColorFactor[3] < 0.5);
  assert.equal(m.pbrMetallicRoughness.baseColorTexture, undefined);
});
