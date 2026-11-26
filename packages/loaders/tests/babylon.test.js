// .babylon scenes written by hand from the public file description; numbers worked out on paper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBabylon, flattenBabylon } from '../dist/babylon.js';
import { LoaderError } from '../dist/common.js';

const isError = (code) => (e) => e instanceof LoaderError && e.format === 'BABYLON' && e.code === code;
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t, `${a} against ${b}`);

const scene = () => ({
  producer: { name: 'Babylon.js', version: '7.0' },
  clearColor: [0.1, 0.2, 0.3],
  activeCameraID: 'cam',
  materials: [
    { name: 'red', id: 'red', diffuse: [1, 0, 0], specular: [1, 1, 1], specularPower: 32, alpha: 0.5, backFaceCulling: false },
    {
      name: 'steel',
      id: 'steel',
      customType: 'BABYLON.PBRMetallicRoughnessMaterial',
      baseColor: [0.5, 0.25, 0.125],
      metallic: 0.9,
      roughness: 0.3,
      baseTexture: { name: 'a.png', uScale: 2, base64String: 'data:image/png;base64,AQID' },
    },
  ],
  multiMaterials: [{ name: 'multi', id: 'multi', materials: ['red', 'steel'] }],
  cameras: [
    { name: 'cam', id: 'cam', type: 'FreeCamera', position: [0, 1, -5], target: [0, 1, 0], fov: 0.9, minZ: 0.1, maxZ: 100 },
    { name: 'orbit', id: 'orbit', type: 'ArcRotateCamera', alpha: 0, beta: Math.PI / 2, radius: 4, target: [1, 2, 3] },
  ],
  lights: [
    { name: 'sun', id: 'sun', type: 1, direction: [0, -1, 1], diffuse: [1, 1, 0.5], intensity: 2 },
    { name: 'spot', id: 'spot', type: 2, position: [0, 5, 0], direction: [0, -1, 0], angle: 1, intensity: 1, diffuse: [1, 1, 1] },
  ],
  transformNodes: [{ name: 'rig', id: 'rig', position: [10, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [2, 2, 2] }],
  meshes: [
    {
      name: 'tri',
      id: 'tri',
      parentId: 'rig',
      position: [1, 2, 3],
      rotation: [0, 0, 0],
      scaling: [1, 1, 1],
      materialId: 'multi',
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: [0, 0, -1, 0, 0, -1, 0, 0, -1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      subMeshes: [{ materialIndex: 1, verticesStart: 0, verticesCount: 3, indexStart: 0, indexCount: 3 }],
      instances: [{ name: 'tri2', position: [5, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] }],
    },
  ],
});

test('materials, cameras, lights and nodes read in the engine space', () => {
  const s = parseBabylon(JSON.stringify(scene()));
  assert.deepEqual(s.clearColor, [0.1, 0.2, 0.3]);
  assert.equal(s.activeCameraId, 'cam');
  assert.equal(s.producer.name, 'Babylon.js');
  const [red, steel] = s.materials;
  assert.equal(red.kind, 'standard');
  assert.equal(red.doubleSided, true);
  near(red.color[0], 1);
  assert.equal(red.color[3], 0.5);
  assert.equal(steel.kind, 'pbr');
  assert.deepEqual(steel.color.slice(0, 3), [0.5, 0.25, 0.125]); // PBR colours are linear already
  assert.equal(steel.metallic, 0.9);
  assert.equal(steel.textures.color.scale[0], 2);
  assert.deepEqual([...steel.textures.color.data], [1, 2, 3]);
  assert.equal(steel.textures.color.mimeType, 'image/png');
  assert.deepEqual(s.multiMaterials[0].materials, ['red', 'steel']);
  // Z is mirrored: the camera at z -5 looking at z 0 sits at +5 looking at 0.
  assert.deepEqual(s.cameras[0].position, [0, 1, 5]);
  assert.deepEqual(s.cameras[0].target, [0, 1, 0]);
  assert.equal(s.cameras[0].fov, 0.9);
  // Arc camera: alpha 0, beta 90 degrees, radius 4 puts the eye 4 along +X of the target.
  near(s.cameras[1].position[0], 5);
  near(s.cameras[1].position[1], 2);
  near(s.cameras[1].position[2], -3);
  assert.equal(s.lights[0].kind, 'directional');
  assert.deepEqual(s.lights[0].direction, [0, -1, -1]);
  assert.equal(s.lights[1].kind, 'spot');
  assert.equal(s.lights[1].angle, 1);
  const rig = s.transformNodes[0];
  assert.deepEqual(rig.translation, [10, 0, 0]);
  assert.deepEqual(rig.scale, [2, 2, 2]);
});

test('a mesh mirrors Z, swaps the winding, keeps submesh groups and gets an instance', () => {
  const s = parseBabylon(scene());
  assert.equal(s.meshes.length, 2);
  const [tri, inst] = s.meshes;
  assert.deepEqual([...tri.geometry.indices], [0, 2, 1]);
  assert.deepEqual([...tri.geometry.normals.slice(0, 3)], [0, 0, 1]);
  assert.deepEqual(tri.translation, [1, 2, -3]);
  assert.equal(tri.geometry.groups[0].properties.materialIndex, 1);
  assert.equal(inst.instanceOf, 'tri');
  assert.equal(inst.geometry, tri.geometry);
  assert.deepEqual(inst.translation, [5, 0, 0]);
  const left = parseBabylon(scene(), { rightHanded: false });
  assert.deepEqual([...left.meshes[0].geometry.indices], [0, 1, 2]);
  assert.deepEqual(left.meshes[0].translation, [1, 2, 3]);
});

test('Euler rotation is yaw about Y: 90 degrees turns +X to -Z', () => {
  const doc = scene();
  doc.meshes[0].rotation = [0, Math.PI / 2, 0];
  const s = parseBabylon(doc, { rightHanded: false });
  const [x, y, z, w] = s.meshes[0].rotation;
  near(x, 0);
  near(y, Math.sin(Math.PI / 4));
  near(z, 0);
  near(w, Math.cos(Math.PI / 4));
  // Rotate (1,0,0) by q about Y: x' = (1 - 2y^2), z' = -2wy.
  near(1 - 2 * y * y, 0);
  near(-2 * w * y, -1);
});

test('shared geometries, bone weights and flattening', () => {
  const doc = {
    geometries: {
      vertexData: [
        {
          id: 'g',
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2],
          matricesIndices: [1 + 2 * 256, 0, 3],
          matricesWeights: [0.5, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        },
      ],
    },
    skeletons: [{ id: 0, name: 's', bones: [{ name: 'root', index: 0, parentBoneIndex: -1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1] }] }],
    meshes: [
      { name: 'a', id: 'a', geometryId: 'g', position: [0, 0, 0], skeletonId: 0 },
      { name: 'b', id: 'b', geometryId: 'g', position: [0, 0, 0], scaling: [-1, 1, 1], isVisible: false },
      { name: 'c', id: 'c', geometryId: 'g', position: [0, 0, 0], scaling: [-1, 1, 1] },
    ],
  };
  const s = parseBabylon(doc);
  assert.deepEqual([...s.meshes[0].joints.slice(0, 4)], [1, 2, 0, 0]);
  assert.deepEqual([...s.meshes[0].weights.slice(0, 4)], [0.5, 0.5, 0, 0]);
  assert.equal(s.meshes[0].skeletonId, '0');
  assert.equal(s.skeletons[0].bones[0].matrix[14], -2); // translation Z mirrored
  const flat = flattenBabylon(s);
  assert.equal(flat.positions.length / 3, 6); // the hidden one is skipped
  assert.deepEqual([...flat.indices.slice(0, 3)], [0, 2, 1]);
  // The mirrored copy has a negative determinant, so its winding flips back.
  assert.deepEqual([...flat.indices.slice(3, 6)], [3, 4, 5]);
  assert.equal(flat.positions[3 * 3 + 3], -1);
  assert.equal(flattenBabylon(s, { onlyVisible: false }).positions.length / 3, 9);
});

test('flattened group colours are sRGB, as LoadedGroup.color documents, so createMeshes does not darken them', () => {
  const s = parseBabylon({
    materials: [{ id: 'm', diffuse: [0.5, 0.25, 1], alpha: 0.5 }], // Standard colours are sRGB in the file
    meshes: [{ id: 't', materialId: 'm', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }],
  });
  const color = flattenBabylon(s).groups[0].color;
  near(color[0], 0.5);
  near(color[1], 0.25);
  near(color[2], 1);
  assert.equal(color[3], 0.5);
});

test('hostile files throw coded errors', () => {
  assert.throws(() => parseBabylon('not json'), isError('syntax'));
  assert.throws(() => parseBabylon('[1,2]'), isError('syntax'));
  assert.throws(() => parseBabylon('{}'), isError('header'));
  assert.throws(() => parseBabylon(42), isError('range'));
  assert.throws(() => parseBabylon({ meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 5] }] }), isError('range'));
  assert.throws(() => parseBabylon({ meshes: [{ positions: [0, 0], indices: [] }] }), isError('syntax'));
  assert.throws(() => parseBabylon({ meshes: [{ positions: [0, 0, 'x'], indices: [] }] }), isError('syntax'));
  assert.throws(() => parseBabylon({ meshes: [{ geometryId: 'nope' }] }), isError('range'));
  assert.throws(
    () => parseBabylon({ meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }] }, { maxVertices: 2 }),
    isError('limit'),
  );
  assert.throws(
    () => parseBabylon({ meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }] }, { maxTriangles: 0 }),
    isError('limit'),
  );
  assert.throws(() => parseBabylon({ meshes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, { maxNodes: 2 }), isError('limit'));
  assert.throws(() => parseBabylon('{"meshes":[]}'.padEnd(100, ' '), { maxBytes: 50 }), isError('limit'));
  assert.throws(() => parseBabylon({ meshes: [] }, { maxVertices: -1 }), isError('range'));
  assert.throws(
    () =>
      parseBabylon({
        meshes: [
          { id: 'a', parentId: 'b' },
          { id: 'b', parentId: 'a' },
        ],
      }),
    isError('syntax'),
  );
  assert.throws(
    () => parseBabylon({ materials: [{ id: 'm', diffuseTexture: { base64String: 'AAAA' } }] }, { maxTextureBytes: 1 }),
    isError('limit'),
  );
  assert.throws(() => parseBabylon({ materials: [{ id: 'm', diffuseTexture: { base64String: '!!!' } }] }), isError('syntax'));
  assert.throws(
    () => parseBabylon({ meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], subMeshes: [{ indexStart: 0, indexCount: 9 }] }] }),
    isError('range'),
  );
  // A delay-loaded mesh is skipped with a warning, not read.
  const s = parseBabylon({ meshes: [{ id: 'x', delayLoadingFile: 'x.babylonbinarymeshdata' }] });
  assert.equal(s.meshes.length, 0);
  assert.match(s.warnings[0], /delay-loaded/);
});
