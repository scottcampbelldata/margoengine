// KHR_materials_diffuse_roughness: the @margoengine/materials option and map, and their glTF export round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, Texture, createMesh } from '@margoengine/materials';
import { parseGLTF } from '@margoengine/gltf/pbr';
import { extendedMaterials } from '@margoengine/gltf/extended-materials';
import { exportModel } from '../dist/model.js';
import { headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { materialEngine as headless } from './helpers.js';

const name = 'KHR_materials_diffuse_roughness';
const triangle = {
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2],
};

test('Material diffuseRoughness: default 0, bounds, the extension named, other materials unchanged', () => {
  const plain = new Material({ anisotropy: 0.5 });
  assert.equal(plain.diffuseRoughness, 0);
  assert.equal(plain.diffuseRoughnessMap, null);
  assert.ok(!plain.extensions.includes('diffuse_roughness'));
  for (const bad of [-0.1, 1.1, NaN]) assert.throws(() => new Material({ diffuseRoughness: bad }), /diffuseRoughness/);
  const rough = new Material({ diffuseRoughness: 0.6 });
  assert.equal(rough.diffuseRoughness, 0.6);
  assert.equal(rough.physical[19], 0.6);
  assert.ok(rough.extensions.includes('diffuse_roughness'));
  rough.anisotropy = 1;
  rough.anisotropyRotation = 1;
  assert.equal(rough.diffuseRoughness, 0.6, 'anisotropy rows leave the lane alone');
});

test('a material mesh round-trips factor and map through exportModel and the loader', () =>
  headlessModels(async () => {
    const map = new Texture({ width: 1, height: 1, data: Uint8Array.of(128, 0, 0, 255) }),
      mesh = createMesh(await headless(), triangle, new Material({ diffuseRoughness: 0.8 }));
    const factorOnly = (await exportModel(mesh)).json;
    assert.deepEqual(factorOnly.materials[0].extensions[name], { diffuseRoughnessFactor: 0.8 });
    assert.ok(factorOnly.extensionsUsed.includes(name));
    mesh.material.diffuseRoughnessMap = map;
    const exported = await exportModel(mesh, { embed: false }),
      written = exported.json.materials[0].extensions[name];
    assert.equal(written.diffuseRoughnessFactor, 0.8);
    assert.equal(typeof written.diffuseRoughnessTexture.index, 'number');
    const loaded = parseGLTF(await headless(), exported.json, [exported.bin.buffer], [{ width: 1, height: 1 }], {
        materials: extendedMaterials,
      }),
      material = loaded.primitives[0].material;
    assert.equal(material.physical[19], 0.8);
    assert.equal(material.maps[21].index, written.diffuseRoughnessTexture.index);
    // A loaded model keeps both on a second export, with a live edit of the factor.
    material.physical[19] = 0.25;
    const again = (await exportModel(loaded)).json.materials[0].extensions[name];
    assert.equal(again.diffuseRoughnessFactor, 0.25);
    assert.ok(again.diffuseRoughnessTexture);
  }));

test('a material without it exports no diffuse roughness', () =>
  headlessModels(async () => {
    const mesh = createMesh(await headless(), triangle, new Material({ iridescence: 1 }));
    assert.equal((await exportModel(mesh)).json.materials[0].extensions[name], undefined);
  }));
