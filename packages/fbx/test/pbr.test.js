// PBR materials from files Max and Maya wrote (test/fixtures/real). Those files give every parameter its own number, so
// a value landing in the wrong slot shows. Their texture files were never shipped, so images here are stand-ins made
// from the test, which is all a channel check needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import validator from 'gltf-validator';
import { decodePNG } from '@margoengine/decoders/png';
import { encodePNG } from '@margoengine/exporters/capture';
import { convertFBX } from '../dist/index.js';
import { pbrMaterials, specularToMetal } from '../dist/pbr.js';
import { readGLB } from './native-scene-helper.js';

const real = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/real', name));
const flat = async (r, g, b, a = 255, width = 2, height = 2) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, a], i);
  return encodePNG({ width, height, data });
};
const serve = (images) => async (url) => {
  const name = decodeURIComponent(String(url).split('/').pop());
  return images[name] ? new Response(images[name]) : new Response('', { status: 404 });
};
const options = (images = {}) => ({
  extensions: [pbrMaterials],
  resourcePath: 'https://assets.example/',
  fetch: serve(images),
});
const close = (actual, expected, label) =>
  expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) < 1e-6, `${label}: ${actual} against ${expected}`));
/** The PNG images a file embeds, each under the name it follows in the file. */
function embedded(bytes) {
  const out = {},
    signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (let at = bytes.indexOf(signature); at >= 0; at = bytes.indexOf(signature, at + 8)) {
    const before = bytes.subarray(Math.max(0, at - 600), at).toString('latin1'),
      name = [...before.matchAll(/checkerboard_(\w+)\.png/g)].pop()?.[1],
      end = bytes.indexOf('IEND', at) + 8;
    out[name] = decodePNG(new Uint8Array(bytes.subarray(at, end)));
  }
  return out;
}
const imageOf = (glb, index) => {
  const { doc, bin } = readGLB(glb),
    texture = doc.textures[index],
    view = doc.bufferViews[doc.images[texture.source].bufferView];
  return decodePNG(new Uint8Array(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0), view.byteLength));
};

test('3ds Max PBR material: each value of the file lands in its slot', async () => {
  const glb = await convertFBX(real('max_pbr_metal_rough_material_7700_ascii.fbx'), options()),
    material = readGLB(glb).doc.materials[0],
    pbr = material.pbrMetallicRoughness;
  close(pbr.baseColorFactor, [0.01, 0.02, 0.03], 'base');
  assert.ok(Math.abs(pbr.metallicFactor - 0.05) < 1e-6);
  assert.ok(Math.abs(pbr.roughnessFactor - 0.06) < 1e-6);
  close(material.emissiveFactor, [0.08, 0.09, 0.1], 'emission');
  assert.equal(material.extras.fbxMissingTextures.length, 7);
});

test('EmissiveColor above 1 converts with no entry: it goes to the emissive strength', async () => {
  const { doc } = readGLB(await convertFBX(real('max_pbr_metal_rough_material_7700_ascii.fbx'), { fetch: serve({}), resourcePath: 'https://assets.example/' }));
  const material = doc.materials[0];
  assert.equal(Math.max(...material.emissiveFactor) <= 1, true);
  const bytes = real('maxPbrMaterial_specGloss.fbx'),
    bright = readGLB(await convertFBX(bytes, { fetch: serve({}), resourcePath: 'https://assets.example/' })).doc.materials[0];
  close(bright.emissiveFactor, [1, 0, 1], 'normalized');
  assert.ok(Math.abs(bright.extensions.KHR_materials_emissive_strength.emissiveStrength - Math.PI) < 1e-5);
});

test('3ds Max PBR maps: separate metal and roughness images pack into green and blue, the others keep their slots', async () => {
  const images = {
    'checkerboard_diffuse.png': await flat(200, 100, 50),
    'checkerboard_metallic.png': await flat(77, 77, 77),
    'checkerboard_roughness.png': await flat(33, 33, 33, 255, 4, 4),
    'checkerboard_ambient.png': await flat(150, 150, 150),
    'checkerboard_normal.png': await flat(128, 128, 255),
    'checkerboard_emissive.png': await flat(255, 0, 0),
    'checkerboard_transparency.png': await flat(255, 255, 255),
  };
  const glb = await convertFBX(real('max_pbr_metal_rough_material_7700_ascii.fbx'), options(images)),
    material = readGLB(glb).doc.materials[0],
    pbr = material.pbrMetallicRoughness;
  assert.equal(pbr.metallicFactor ?? 1, 1);
  assert.equal(pbr.roughnessFactor ?? 1, 1);
  const packed = imageOf(glb, pbr.metallicRoughnessTexture.index);
  assert.deepEqual([packed.width, packed.height], [4, 4]);
  assert.deepEqual([...packed.data.slice(0, 4)], [255, 33, 77, 255]);
  for (const slot of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) assert.ok(material[slot], slot);
  assert.ok(pbr.baseColorTexture);
  const report = await validator.validateBytes(new Uint8Array(glb));
  assert.equal(report.issues.numErrors, 0);
});

test('3ds Max specular and gloss: the gloss map inverts, and the colours solve to metalness', async () => {
  const image = await flat(200, 200, 200);
  const glb = await convertFBX(real('maxPbrMaterial_specGloss.fbx'), { ...options(), fetch: async () => new Response(image) }),
    pbr = readGLB(glb).doc.materials[0].pbrMetallicRoughness,
    packed = imageOf(glb, pbr.metallicRoughnessTexture.index);
  assert.equal(packed.data[1], 55);
  // Worked by hand from the published conversion: a white specular colour over black is a full metal of that colour.
  const metal = specularToMetal([0, 0, 0], [1, 1, 1]);
  assert.ok(Math.abs(metal.metalness - 1) < 1e-12);
  close(metal.color, [1, 1, 1], 'metal');
  assert.equal(specularToMetal([0.5, 0.5, 0.5], [0.04, 0.04, 0.04]).metalness, 0);
});

test('3ds Max Physical: weight, inverted IOR and transparency', async () => {
  const { doc } = readGLB(await convertFBX(real('max_physical_material_properties_7500_ascii.fbx'), options())),
    material = doc.materials[0],
    pbr = material.pbrMetallicRoughness;
  close(pbr.baseColorFactor, [0.02 * 0.01, 0.03 * 0.01, 0.04 * 0.01], 'base by weight');
  assert.ok(Math.abs(pbr.metallicFactor - 0.07) < 1e-6);
  assert.ok(Math.abs(pbr.roughnessFactor - 0.06) < 1e-6);
  close(material.emissiveFactor, [0.28 * 0.27, 0.29 * 0.27, 0.3 * 0.27], 'emission by weight');
  assert.ok(Math.abs(material.extensions.KHR_materials_transmission.transmissionFactor - 0.09) < 1e-6);
  assert.ok(Math.abs(material.extensions.KHR_materials_ior.ior - 1.25) < 1e-6);
});

test('Stingray PBS: a map switched off stays out, and the file holds its values', async () => {
  const bytes = real('maya_shaderfx_pbs_material_7700_binary.fbx'),
    metal = embedded(bytes).metallic,
    glb = await convertFBX(bytes, options()),
    { doc } = readGLB(glb),
    material = doc.materials.find((m) => m.name === 'StingrayPBS1'),
    pbr = material.pbrMetallicRoughness;
  // use_color_map, use_metallic_map and use_emissive_map are 1; use_roughness_map, use_normal_map and use_ao_map are 0.
  assert.ok(pbr.baseColorTexture && pbr.metallicRoughnessTexture && material.emissiveTexture);
  assert.equal(material.normalTexture, undefined);
  assert.equal(material.occlusionTexture, undefined);
  const packed = imageOf(glb, pbr.metallicRoughnessTexture.index);
  assert.equal(packed.data[1], Math.round(0.05 * 255));
  for (let i = 0; i < packed.data.length; i += 4) assert.equal(packed.data[i + 2], metal.data[i], 'blue is the metal map');
});

test('layered textures flatten, first layer at the bottom, by blend mode and alpha', async () => {
  const bytes = real('maya_texture_layers_7500_binary.fbx'),
    glb = await convertFBX(
      bytes,
      options({
        'checkerboard_weight.png': await flat(200, 200, 200),
        'checkerboard_diffuse.png': await flat(100, 0, 0),
        'checkerboard_ambient.png': await flat(0, 50, 0),
      }),
    ),
    { doc } = readGLB(glb),
    material = doc.materials.find((m) => m.pbrMetallicRoughness?.baseColorTexture),
    pixel = imageOf(glb, material.pbrMetallicRoughness.baseColorTexture.index).data.slice(0, 4);
  // The file says modulate at 0.75, over at 0.5, add at 1, for weight, diffuse, ambient. Worked by hand, in 0 to 255:
  // 200 x 0.75 = 150 at cover 0.75, modulate having nothing under it. Over: 125, 75, 75 at cover 0.875. Add: the sum
  // counts where there was something under it, so red 125 x 0.875, green 50 + 75 x 0.875, blue 75 x 0.875.
  assert.deepEqual([...pixel], [109, 116, 66, 255]);
  await assert.rejects(convertFBX(bytes, { resourcePath: 'https://assets.example/', fetch: serve({}) }), /pbrMaterials/);
});

test('a transparency map beside a colour map goes to the alpha, as a mask when it is all holes', async () => {
  const bytes = real('max_pbr_metal_rough_material_7700_ascii.fbx'),
    mask = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) mask.set(i % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
  const glb = await convertFBX(
      bytes,
      options({
        'checkerboard_diffuse.png': await flat(10, 20, 30),
        'checkerboard_transparency.png': await encodePNG({ width: 4, height: 4, data: mask }),
      }),
    ),
    material = readGLB(glb).doc.materials[0],
    image = imageOf(glb, material.pbrMetallicRoughness.baseColorTexture.index);
  assert.equal(material.alphaMode, 'MASK');
  assert.deepEqual([...image.data.slice(0, 8)], [10, 20, 30, 0, 10, 20, 30, 255]);
});

test('TGA and TIFF textures become PNG with the entry and stay a named loss without it', async () => {
  // An uncompressed 1 x 1 true colour TGA: blue, green, red.
  const tga = new Uint8Array([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 24, 0, 30, 20, 10]);
  const glb = await convertFBX(real('max_pbr_metal_rough_material_7700_ascii.fbx'), options({ 'checkerboard_diffuse.png': tga })),
    material = readGLB(glb).doc.materials[0];
  assert.deepEqual([...imageOf(glb, material.pbrMetallicRoughness.baseColorTexture.index).data.slice(0, 3)], [10, 20, 30]);
  const plain = readGLB(
    await convertFBX(real('maya_shaderfx_pbs_material_7700_binary.fbx'), {
      resourcePath: 'https://assets.example/',
      fetch: async () => new Response(tga),
    }),
  ).doc;
  assert.equal(plain.images, undefined);
});
