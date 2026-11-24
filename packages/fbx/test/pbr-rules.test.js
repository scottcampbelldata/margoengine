// pbrMaterials against the published rules, on small text files: FbxLayeredTexture's EBlendMode numbers (FBX SDK 2017
// class reference), Autodesk Standard Surface's defaults and emission, and the Stingray UV transform after the V flip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePNG } from '@margoengine/decoders/png';
import { encodePNG } from '@margoengine/exporters/capture';
import { convertFBX } from '../dist/index.js';
import { pbrMaterials } from '../dist/pbr.js';
import { rigFixture, readGLB } from './native-scene-helper.js';

const flat = async (r, g, b, a = 255) => {
  const data = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, a], i);
  return encodePNG({ width: 2, height: 2, data });
};
const P = (name, ...values) => `P: "${name}", "Number", "", "A", ${values.join(',')}`;
/** A texture object: embedded bytes, or a file name the server does not have. */
const texture = (id, bytes) =>
  bytes
    ? `Texture: ${id}, "Texture::T${id}", "" {\n}\nVideo: ${id + 1000}, "Video::V${id}", "Clip" {\n Content: "${Buffer.from(bytes).toString('base64')}"\n}`
    : `Texture: ${id}, "Texture::T${id}", "" {\n RelativeFilename: "gone${id}.png"\n}`;
const videoLink = (id, bytes) => (bytes ? `C: "OO",${id + 1000},${id}` : '');

function file(properties, objects = [], connections = []) {
  const source = rigFixture({
    skin: false,
    morph: false,
    animation: false,
    geometric: [0, 0, 0],
    meshTranslation: [0, 0, 0],
    extraModel: [`Material: 100, "Material::Surface", "" {\n Properties70: {\n ${properties.join('\n ')}\n }\n}`, ...objects].join(
      '\n',
    ),
    extraConnections: ['C: "OO",100,2', ...connections].join('\n'),
  });
  return new TextEncoder().encode(
    source.replace(
      'PolygonVertexIndex: *3 {',
      'LayerElementUV: 0 {\n MappingInformationType: "ByVertice"\n ReferenceInformationType: "Direct"\n UV: *6 { a: 0,0,1,0,0,1 }\n}\nPolygonVertexIndex: *3 {',
    ),
  );
}
const convert = (bytes) =>
  convertFBX(bytes, {
    extensions: [pbrMaterials],
    resourcePath: 'https://assets.example/',
    fetch: async () => new Response('', { status: 404 }),
  });
function baseTexel(glb) {
  const { doc, bin } = readGLB(glb),
    info = doc.materials[0].pbrMetallicRoughness.baseColorTexture,
    view = doc.bufferViews[doc.images[doc.textures[info.index].source].bufferView];
  return [...decodePNG(new Uint8Array(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0), view.byteLength)).data.slice(0, 4)];
}
/** A layered texture on DiffuseColor over the given layers (bytes, or undefined for a lost image). */
async function layered(layers, modes) {
  const objects = [
      `LayeredTexture: 400, "LayeredTexture::Stack", "" {\n BlendModes: *${modes.length} { a: ${modes.join(',')} }\n Alphas: *${modes.length} { a: ${modes.map(() => 1).join(',')} }\n}`,
    ],
    connections = ['C: "OP",400,100,"DiffuseColor"'];
  layers.forEach((bytes, k) => {
    objects.push(texture(200 + k, bytes));
    connections.push(`C: "OO",${200 + k},400`, videoLink(200 + k, bytes));
  });
  return baseTexel(await convert(file([], objects, connections)));
}

test('layered texture blend modes follow the EBlendMode numbers: 22 is difference, 24 subtract, 21 and 23 draw plain', async () => {
  const bottom = await flat(200, 100, 50),
    top = await flat(50, 150, 50);
  assert.deepEqual(await layered([bottom, top], [0, 22]), [150, 50, 0, 255]);
  assert.deepEqual(await layered([bottom, top], [0, 24]), [150, 0, 0, 255]);
  // Hard mix (21) and exclusion (23) are not among the modes drawn, so the top layer covers.
  assert.deepEqual(await layered([bottom, top], [0, 21]), [50, 150, 50, 255]);
  assert.deepEqual(await layered([bottom, top], [0, 23]), [50, 150, 50, 255]);
});

test('a layer whose image is lost takes its blend mode with it, so the layers above keep their own', async () => {
  const bottom = await flat(200, 100, 50),
    top = await flat(50, 150, 50);
  // The middle layer (modulate) is lost; the top keeps add: 200 + 50, 100 + 150, 50 + 50.
  assert.deepEqual(await layered([bottom, undefined, top], [0, 2, 1]), [250, 250, 100, 255]);
});

test('Standard Surface: an emission map at weight 0 stays dark, and the weight scales it', async () => {
  const arnold = (weight) =>
    file(
      [P('Maya|specularRoughness', 0.2), P('Maya|emission', weight), P('Maya|emissionColor', 1, 1, 1)],
      [texture(200, glow)],
      ['C: "OP",200,100,"Maya|emissionColor"', videoLink(200, glow)],
    );
  const glow = await flat(255, 128, 0);
  const dark = readGLB(await convert(arnold(0))).doc.materials[0];
  assert.ok(dark.emissiveTexture);
  assert.deepEqual(dark.emissiveFactor ?? [0, 0, 0], [0, 0, 0]);
  const half = readGLB(await convert(arnold(0.5))).doc.materials[0];
  assert.deepEqual(half.emissiveFactor, [0.5, 0.5, 0.5]);
  const bright = readGLB(await convert(arnold(2))).doc.materials[0];
  assert.deepEqual(bright.emissiveFactor, [1, 1, 1]);
  assert.equal(bright.extensions.KHR_materials_emissive_strength.emissiveStrength, 2);
});

test('a Phong emissive map is scaled by EmissiveFactor, so a factor of 0 does not glow', async () => {
  const glow = await flat(255, 128, 0),
    material = readGLB(
      await convert(
        file([P('EmissiveFactor', 0)], [texture(200, glow)], ['C: "OP",200,100,"EmissiveColor"', videoLink(200, glow)]),
      ),
    ).doc.materials[0];
  assert.ok(material.emissiveTexture);
  assert.deepEqual(material.emissiveFactor ?? [0, 0, 0], [0, 0, 0]);
});

test('Standard Surface base defaults to 0.8 when the file leaves it out', async () => {
  const material = readGLB(await convert(file([P('Maya|specularRoughness', 0.2), P('Maya|baseColor', 1, 1, 1)]))).doc
    .materials[0];
  const factor = material.pbrMetallicRoughness.baseColorFactor;
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(factor[c] - 0.8) < 1e-6, String(factor));
});

test('Stingray uv_offset and uv_scale land in the GLB after the V flip: offset v is 1 - sv - ov', async () => {
  const image = await flat(10, 20, 30),
    glb = await convert(
      file(
        [P('Maya|base_color', 1, 1, 1), P('Maya|use_color_map', 1), P('Maya|uv_offset', 0.1, 0.2), P('Maya|uv_scale', 2, 3)],
        [texture(200, image)],
        ['C: "OP",200,100,"Maya|TEX_color_map"', videoLink(200, image)],
      ),
    ),
    transform = readGLB(glb).doc.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform;
  assert.deepEqual(transform.scale, [2, 3]);
  assert.ok(Math.abs(transform.offset[0] - 0.1) < 1e-6 && Math.abs(transform.offset[1] - (1 - 3 - 0.2)) < 1e-6, String(transform.offset));
});

test('Stingray uv_offset and uv_scale reach every map the shader samples, not only the base colour', async () => {
  const image = await flat(10, 20, 30),
    maps = [
      ['color_map', 201],
      ['normal_map', 202],
      ['roughness_map', 203],
      ['ao_map', 204],
      ['emissive_map', 205],
    ],
    glb = await convert(
      file(
        [
          P('Maya|base_color', 1, 1, 1),
          ...maps.map(([name]) => P(`Maya|use_${name}`, 1)),
          P('Maya|uv_offset', 0.1, 0.2),
          P('Maya|uv_scale', 2, 3),
        ],
        maps.map(([, id]) => texture(id, image)),
        maps.flatMap(([name, id]) => [`C: "OP",${id},100,"Maya|TEX_${name}"`, videoLink(id, image)]),
      ),
    ),
    material = readGLB(glb).doc.materials[0],
    infos = {
      base: material.pbrMetallicRoughness.baseColorTexture,
      metalRough: material.pbrMetallicRoughness.metallicRoughnessTexture,
      normal: material.normalTexture,
      occlusion: material.occlusionTexture,
      emissive: material.emissiveTexture,
    };
  for (const [name, info] of Object.entries(infos)) {
    assert.ok(info, `${name} map is written`);
    const transform = info.extensions?.KHR_texture_transform;
    assert.ok(transform, `${name} carries the transform`);
    assert.deepEqual(transform.scale, [2, 3], name);
    assert.ok(Math.abs(transform.offset[0] - 0.1) < 1e-6 && Math.abs(transform.offset[1] - (1 - 3 - 0.2)) < 1e-6, name);
  }
});
