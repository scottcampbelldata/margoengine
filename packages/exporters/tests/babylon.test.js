// exportBabylon read back by parseBabylon, with the expected numbers worked out by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBabylon } from '@margoengine/loaders/babylon';
import { exportBabylon } from '../dist/babylon.js';

const tri = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1] };
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5, 6]);
const scene = () => ({
  nodes: [
    {
      name: 'rig',
      translation: [10, 0, 0],
      children: [
        {
          name: 'tri',
          translation: [1, 2, 3],
          geometry: tri,
          material: { name: 'steel', color: [0.5, 0.25, 0.125, 1], metalness: 0.9, roughness: 0.3, baseColorTexture: { image: png, mimeType: 'image/png' } },
        },
      ],
    },
    { name: 'eye', translation: [0, 1, 5], camera: { type: 'perspective', perspective: { yfov: 0.9, znear: 0.1, zfar: 100 } } },
    { name: 'sun', light: { type: 'directional', color: [1, 1, 0.5], intensity: 2 } },
    {
      name: 'lamp',
      translation: [0, 5, 0],
      rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], // -90 degrees about X turns -Z to -Y
      light: { type: 'spot', color: [1, 1, 1], intensity: 1, outerConeAngle: 0.5, innerConeAngle: 0.25 },
    },
    {
      name: 'matte',
      geometry: tri,
      material: { name: 'matte', color: [1, 0, 0, 0.5], shading: 'lambert', doubleSided: true },
    },
  ],
});

test('writes left-handed Babylon JSON that parseBabylon reads back', () => {
  const out = exportBabylon(scene());
  const doc = JSON.parse(out.text);
  assert.equal(doc.producer.name, 'Margo Engine');
  assert.equal(out.meshes, 2);
  assert.equal(out.materials, 2);
  const mesh = doc.meshes.find((m) => m.name === 'tri');
  assert.equal(mesh.parentId, 'rig');
  assert.deepEqual(mesh.position, [1, 2, -3]); // Z mirrored
  assert.deepEqual(mesh.indices, [0, 2, 1]); // winding swapped
  assert.deepEqual(mesh.subMeshes[0], { materialIndex: 0, verticesStart: 0, verticesCount: 3, indexStart: 0, indexCount: 3 });
  assert.equal(doc.transformNodes[0].name, 'rig');
  const steel = doc.materials.find((m) => m.name === 'steel');
  assert.equal(steel.customType, 'BABYLON.PBRMetallicRoughnessMaterial');
  assert.equal(steel.baseTexture.invertY, false);
  assert.equal(steel.baseTexture.base64String, `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  const matte = doc.materials.find((m) => m.name === 'matte');
  assert.equal(matte.customType, 'BABYLON.StandardMaterial');
  assert.equal(matte.backFaceCulling, false);
  assert.equal(matte.alpha, 0.5);
  assert.equal(doc.activeCameraID, 'eye');
  assert.deepEqual(doc.cameras[0].position, [0, 1, -5]);
  assert.deepEqual(doc.cameras[0].target, [0, 1, -4]); // looks down -Z in the engine, +Z in Babylon
  assert.deepEqual(doc.lights[0].direction, [0, 0, 1]);
  assert.equal(doc.lights[0].type, 1);
  assert.deepEqual(doc.lights[1].direction.map((v) => Math.round(v * 1e6) / 1e6), [0, -1, 0]);
  assert.equal(doc.lights[1].angle, 1);
  assert.equal(doc.lights[1].innerAngle, 0.5);

  const back = parseBabylon(out.text);
  const t = back.meshes.find((m) => m.name === 'tri');
  assert.deepEqual([...t.geometry.indices], [0, 1, 2]);
  assert.deepEqual([...t.geometry.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(t.translation, [1, 2, 3]);
  assert.equal(t.parentId, 'rig');
  const m = back.materials.find((x) => x.name === 'steel');
  assert.deepEqual(m.color.slice(0, 3), [0.5, 0.25, 0.125]);
  assert.equal(m.metallic, 0.9);
  assert.deepEqual([...m.textures.color.data], [...png]);
  const matteBack = back.materials.find((x) => x.name === 'matte');
  assert.ok(Math.abs(matteBack.color[0] - 1) < 1e-6 && matteBack.color[1] === 0);
  assert.deepEqual(back.cameras[0].position, [0, 1, 5]);
  assert.deepEqual(back.cameras[0].target, [0, 1, 4]);
  assert.equal(back.lights[1].kind, 'spot');
});

test('leftHanded false keeps the engine numbers, and textures can go to files', () => {
  const out = exportBabylon(scene(), { leftHanded: false, embedTextures: false, texturePrefix: 'tex/' });
  const mesh = out.json.meshes.find((m) => m.name === 'tri');
  assert.deepEqual(mesh.position, [1, 2, 3]);
  assert.deepEqual(mesh.indices, [0, 1, 2]);
  const texture = out.json.materials[0].baseTexture;
  assert.equal(texture.base64String, undefined);
  assert.deepEqual([...out.textures.get(texture.name)], [...png]);
  assert.match(texture.name, /^tex\//);
});

test('bad options throw', () => {
  assert.throws(() => exportBabylon(scene(), { leftHanded: 1 }), TypeError);
  assert.throws(() => exportBabylon(scene(), { texturePrefix: 'a b' }), TypeError);
});
