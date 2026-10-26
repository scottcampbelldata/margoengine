// Decoded Draco indices load whatever componentType the index accessor declares. Blender's glTF exporter (4.2.57)
// declares UNSIGNED_SHORT on Draco primitives of 75,744 to 94,965 vertices; NASA's ISS GLB has four, and gltf-pro
// rejected the whole file ("Draco indices exceed accessor component type") where other glTF viewers load it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFAsset } from '../dist/index.js';

const vertices = 70_000; // more than UNSIGNED_SHORT can index

function asset(indices) {
  const positions = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++) positions.set([i, i % 2, 0], i * 3);
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: 4 }],
    bufferViews: [{ buffer: 0, byteLength: 4 }],
    accessors: [
      { componentType: 5126, count: vertices, type: 'VEC3', min: [0, 0, 0], max: [vertices - 1, 1, 0] },
      { componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
            extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } },
          },
        ],
      },
    ],
  };
  return new GLTFAsset(doc, [new Uint8Array(4)], undefined, {
    draco: { decode: async () => ({ positions, vertexCount: vertices, indices }) },
  });
}

test('Draco indices past a declared UNSIGNED_SHORT load exactly', async () => {
  const loaded = asset(new Uint32Array([0, 65_536, vertices - 1]));
  await loaded.decode();
  assert.deepEqual([...loaded.accessor(1, 'SCALAR')], [0, 65_536, vertices - 1]);
});

test('a Draco index past the vertex count is still refused', async () => {
  await assert.rejects(asset(new Uint32Array([0, 1, vertices])).decode(), {
    name: 'RangeError',
    message:
      'Invalid glTF Draco triangle indices; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
  });
});
