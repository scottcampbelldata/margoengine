import assert from 'node:assert/strict';
import test from 'node:test';
import { exportGLB, exportOBJ, exportUSDZ } from '@margoengine/exporters';
import { gridToExportSource } from '../dist/export.js';

const grid = { size: [1, 1, 1], voxels: Uint8Array.of(2) };
const materials = [{ index: 2, color: [0.2, 0.4, 0.8], roughness: 0.3, metalness: 0.7 }];

const readGLB = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
};

test('gridToExportSource is a scene the glTF, USDZ and OBJ writers accept', () => {
  const source = gridToExportSource(grid, materials, { name: 'block', ambientOcclusion: true, smoothNormals: true });
  assert.equal(source.nodes.length, 1);
  assert.equal(source.nodes[0].primitives.length, 1);
  const primitive = source.nodes[0].primitives[0];
  assert.equal(primitive.material.name, 'palette-2');
  assert.deepEqual(primitive.material.color, [0.2, 0.4, 0.8, 1]);
  assert.ok(primitive.geometry.positions.length > 0);
  assert.equal(primitive.geometry.normals.length, primitive.geometry.positions.length);
  assert.equal(primitive.geometry.colors.length / 3, primitive.geometry.positions.length / 3);

  const json = readGLB(exportGLB(source));
  assert.equal(json.materials[0].pbrMetallicRoughness.baseColorFactor[0], 0.2);
  assert.equal(json.materials[0].pbrMetallicRoughness.roughnessFactor, 0.3);
  assert.equal(json.materials[0].pbrMetallicRoughness.metallicFactor, 0.7);
  assert.ok(json.meshes[0].primitives[0].attributes.POSITION !== undefined);
  assert.ok(json.meshes[0].primitives[0].attributes.NORMAL !== undefined);
  assert.ok(json.meshes[0].primitives[0].attributes.COLOR_0 !== undefined);

  const obj = exportOBJ(source, { materials: true, colors: true });
  assert.match(obj.obj, /vn /);
  assert.match(obj.mtl, /Kd /);
  const plain = gridToExportSource(grid, materials, { name: 'block' });
  assert.equal(plain.nodes[0].primitives[0].geometry.colors, undefined);
  assert.ok(exportUSDZ(plain).byteLength > 100);
});
