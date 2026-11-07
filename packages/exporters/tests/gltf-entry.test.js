// @margoengine/exporters/gltf: exportGLB without the root, and a file a reader can open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB, exportGLTF } from '../dist/gltf.js';

const scene = () => ({
  nodes: [
    {
      name: 'Triangle',
      geometry: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
      },
    },
  ],
});

test('the entry writes a GLB read here from its own header and JSON chunk', () => {
  const glb = exportGLB(scene()),
    view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength),
    length = view.getUint32(12, true),
    json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(8, true), glb.byteLength);
  assert.equal(json.nodes[0].name, 'Triangle');
  assert.equal(json.accessors[json.meshes[0].primitives[0].attributes.POSITION].count, 3);
});

test('the entry also holds exportGLTF', () => {
  assert.equal(typeof exportGLTF, 'function');
});
