import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { exportMaterialGLB } from '@margoengine/exporters/materials';
import { splitGLB } from '../dist/glb.js';
import { validate } from './helpers.js';

const geometry = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  tangents: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
};
async function texture() {
  const parts = splitGLB(await readFile(new URL('./fixtures/BoxTextured.glb', import.meta.url))),
    image = parts.json.images[0],
    view = parts.json.bufferViews[image.bufferView];
  return {
    image: parts.bin.slice(view.byteOffset, view.byteOffset + view.byteLength),
    mimeType: 'image/png',
    wrapS: 'clamp',
    texCoord: 0,
  };
}
test('every current KHR material lobe writes its exact payload and shared extension texture', async () => {
  const tex = await texture(),
    info = { texture: tex },
    extensions = {
      KHR_materials_clearcoat: {
        clearcoatFactor: 0.7,
        clearcoatTexture: info,
        clearcoatRoughnessFactor: 0.2,
        clearcoatNormalTexture: { ...info, scale: 0.4 },
      },
      KHR_materials_sheen: { sheenColorFactor: [0.1, 0.2, 0.3], sheenRoughnessFactor: 0.5, sheenColorTexture: info },
      KHR_materials_specular: { specularFactor: 0.6, specularColorFactor: [1, 0.5, 0.2], specularTexture: info },
      KHR_materials_iridescence: {
        iridescenceFactor: 0.8,
        iridescenceIor: 1.3,
        iridescenceThicknessMinimum: 100,
        iridescenceThicknessMaximum: 400,
        iridescenceTexture: info,
      },
      KHR_materials_anisotropy: { anisotropyStrength: 0.5, anisotropyRotation: 0.2, anisotropyTexture: info },
      KHR_materials_transmission: { transmissionFactor: 0.3, transmissionTexture: info },
      KHR_materials_volume: {
        thicknessFactor: 0.2,
        attenuationDistance: 4,
        attenuationColor: [0.8, 0.9, 1],
        thicknessTexture: info,
      },
      KHR_materials_dispersion: { dispersion: 2.3 },
      KHR_materials_ior: { ior: 1.4 },
      KHR_materials_emissive_strength: { emissiveStrength: 3 },
      KHR_materials_diffuse_transmission: {
        diffuseTransmissionFactor: 0.2,
        diffuseTransmissionColorFactor: [1, 0.5, 0.4],
        diffuseTransmissionTexture: info,
      },
    },
    material = { baseColorTexture: tex, emissive: [0.1, 0.1, 0.1], extensions },
    scene = { nodes: [{ geometry, material }] };
  const bytes = exportMaterialGLB(scene),
    j = splitGLB(bytes).json,
    m = j.materials[0];
  assert.equal(j.images.length, 1);
  assert.equal(j.textures.length, 1);
  for (const [name, payload] of Object.entries(extensions)) {
    assert.ok(j.extensionsUsed.includes(name));
    for (const [field, value] of Object.entries(payload)) {
      if (field.endsWith('Texture')) assert.equal(m.extensions[name][field].index, 0);
      else assert.deepEqual(m.extensions[name][field], value);
    }
  }
  assert.equal(m.extensions.KHR_materials_clearcoat.clearcoatNormalTexture.scale, 0.4);
  assert.equal(extensions.KHR_materials_clearcoat.clearcoatTexture.texture, tex);
  const report = await validate(bytes);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('per-primitive variants stay independent when default meshes and materials are shared', async () => {
  const base = { name: 'base' },
    red = { name: 'red', color: [1, 0, 0], unlit: true },
    blue = { name: 'blue', color: [0, 0, 1], extensions: { KHR_materials_dispersion: { dispersion: 0 } } };
  const scene = {
    variants: [{ name: 'Warm', extras: { purpose: 'sale' } }, { name: 'Cool' }],
    nodes: [
      { geometry, material: base, variants: { Warm: red, Cool: blue } },
      { geometry, material: base, variants: { Warm: blue } },
    ],
  };
  const bytes = exportMaterialGLB(scene),
    j = splitGLB(bytes).json,
    a = j.meshes[j.nodes[0].mesh].primitives[0],
    b = j.meshes[j.nodes[1].mesh].primitives[0];
  assert.notEqual(j.nodes[0].mesh, j.nodes[1].mesh);
  assert.equal(j.materials[a.extensions.KHR_materials_variants.mappings[0].material].name, 'red');
  assert.equal(j.materials[b.extensions.KHR_materials_variants.mappings[0].material].name, 'blue');
  assert.ok(j.extensionsUsed.includes('KHR_materials_unlit'));
  assert.deepEqual(j.extensions.KHR_materials_variants.variants, scene.variants);
  const report = await validate(bytes);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('alternate-only images and texture transforms have valid lengths, UV selection and declarations', async () => {
  const tex = await texture(),
    scene = {
      nodes: [
        {
          geometry,
          material: {},
          variants: {
            Coat: {
              extensions: {
                KHR_materials_clearcoat: {
                  clearcoatTexture: {
                    texture: tex,
                    extensions: { KHR_texture_transform: { offset: [0.2, 0.3], scale: [2, 2], texCoord: 0 } },
                  },
                },
              },
            },
          },
        },
      ],
    };
  const bytes = exportMaterialGLB(scene),
    parts = splitGLB(bytes);
  assert.equal(parts.json.buffers[0].byteLength, parts.bin.length);
  assert.ok(parts.json.extensionsUsed.includes('KHR_texture_transform'));
  const report = await validate(bytes);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
});

test('malformed payloads, cycles, absent UVs and nested flatten variants reject explicitly', async () => {
  const build = (extensions) => exportMaterialGLB({ nodes: [{ geometry, material: { extensions } }] });
  assert.throws(() => build({ KHR_materials_dispersion: { dispersion: NaN } }), /MARGO_EXPORT_MATERIAL_NUMBER/);
  assert.throws(
    () => build({ KHR_materials_clearcoat: { clearcoatTexture: { index: 0 } } }),
    /MARGO_EXPORT_MATERIAL_TEXTURE/,
  );
  const cycle = {};
  cycle.loop = cycle;
  assert.throws(() => build({ KHR_materials_clearcoat: cycle }), /MARGO_EXPORT_MATERIAL_TREE/);
  const tex = await texture();
  assert.throws(
    () => build({ KHR_materials_clearcoat: { clearcoatTexture: { texture: tex, texCoord: 1 } } }),
    /MARGO_EXPORT_MATERIAL_UV_MISSING/,
  );
  assert.throws(
    () => exportMaterialGLB({ nodes: [{ children: [{ geometry, variants: { A: {} } }] }] }, { flatten: true }),
    /MARGO_EXPORT_VARIANT_FLATTEN/,
  );
  assert.throws(() => exportMaterialGLB({ nodes: [] }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
