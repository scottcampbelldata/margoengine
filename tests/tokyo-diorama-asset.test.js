// Structural checks on the Blender-exported Tokyo diorama (examples/assets/tokyo-diorama.glb).
// Rebuild the asset with `npm run build:tokyo` (needs Blender 5.3; see BLENDER in scripts/build-tokyo-diorama.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';

const file = new URL('../examples/assets/tokyo-diorama.glb', import.meta.url);

function readGLB(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF', 'not a GLB');
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, 'first chunk must be JSON');
  return JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)));
}

const doc = readGLB(file);
const nodeIndex = name => {
  const index = doc.nodes.findIndex(node => node.name === name);
  assert.ok(index >= 0, `missing node ${name}`);
  return index;
};
const channels = name => doc.animations[0].channels.filter(c => c.target.node === nodeIndex(name)).map(c => c.target.path);
const triangles = () => {
  let count = 0;
  for (const node of doc.nodes) if (node.mesh !== undefined) for (const p of doc.meshes[node.mesh].primitives)
    count += (p.indices !== undefined ? doc.accessors[p.indices].count : doc.accessors[p.attributes.POSITION].count) / 3;
  return count;
};

test('one 12 s Diorama clip, Draco-compressed', () => {
  assert.equal(doc.animations.length, 1);
  assert.equal(doc.animations[0].name, 'Diorama');
  const duration = Math.max(...doc.animations[0].samplers.map(s => doc.accessors[s.input].max[0]));
  assert.ok(duration > 11.9 && duration < 12.1, `clip lasts ${duration} s`);
  assert.ok(doc.extensionsRequired?.includes('KHR_draco_mesh_compression'), 'GLB is not Draco-compressed');
});

test('street, track and moving tram', () => {
  for (const name of ['Diorama_Root', 'Slab', 'Street', 'Sidewalk', 'Track_Rails', 'Track_Sleepers']) nodeIndex(name);
  assert.deepEqual(channels('Tram').sort(), ['rotation', 'translation']);
});
