// model.extras(): glTF node extras (Blender custom properties, "Include > Custom Properties") with world matrices,
// from a GLB generated here in the shape Blender's exporter writes (nothing is downloaded).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mockGPU} from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import {Engine, TransformStore} from '../../core/dist/extension.js';
import {parseGLTFAsync} from '../dist/index.js';

function levelGLB() {
  const bin = new Uint8Array(48 + 12);
  new Float32Array(bin.buffer, 0, 12).set([-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10]);
  new Uint16Array(bin.buffer, 48, 6).set([0, 2, 1, 0, 3, 2]);
  const doc = {asset: {version: '2.0', generator: 'Khronos glTF Blender I/O'}, scene: 0,
    scenes: [{nodes: [0, 1, 2, 4]}],
    nodes: [
      {name: 'Ground', mesh: 0},
      {name: 'PlayerStart', translation: [2, 1, -3], extras: {spawn: 'player'}},
      {name: 'Coins', translation: [5, 0, 0], children: [3]},
      {name: 'Coin.001', translation: [0, 1, 2], extras: {spawn: 'coin', value: 10}},
      {name: 'Note', extras: 'a string is valid glTF extras, but not an object'},
    ],
    meshes: [{primitives: [{attributes: {POSITION: 0}, indices: 1, material: 0}], extras: {collider: 'trimesh'}}],
    materials: [{pbrMetallicRoughness: {baseColorFactor: [0.3, 0.6, 0.2, 1]}, extras: {surface: 'grass'}}],
    accessors: [{bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-10, 0, -10], max: [10, 0, 10]}, {bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR'}],
    bufferViews: [{buffer: 0, byteOffset: 0, byteLength: 48}, {buffer: 0, byteOffset: 48, byteLength: 12}],
    buffers: [{byteLength: bin.byteLength}]};
  let json = new TextEncoder().encode(JSON.stringify(doc));
  json = Uint8Array.from([...json, ...Array((4 - json.length % 4) % 4).fill(0x20)]);
  const glb = new Uint8Array(12 + 8 + json.length + 8 + bin.length), view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.length, true);
  view.setUint32(12, json.length, true); view.setUint32(16, 0x4e4f534a, true); glb.set(json, 20);
  view.setUint32(20 + json.length, bin.length, true); view.setUint32(24 + json.length, 0x004e4942, true); glb.set(bin, 28 + json.length);
  return glb.buffer;
}

test('model.extras() lists object-valued node extras in node order with world matrices', async () => {
  const gpu = mockGPU(), store = await TransformStore.create(32), renderer = {backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {}};
  const engine = new Engine({width: 64, height: 64, clientWidth: 64, clientHeight: 64}, store, renderer, {position: [0, 5, 10], target: [0, 0, 0]}, null);
  const model = await parseGLTFAsync(engine, levelGLB());
  const markers = model.extras();
  assert.deepEqual(markers.map(m => [m.nodeIndex, m.name, m.extras]), [[1, 'PlayerStart', {spawn: 'player'}], [3, 'Coin.001', {spawn: 'coin', value: 10}]]);
  assert.equal(markers[1].node, model.nodes[3]);
  // Read before any render: the parent's translation is already in the world matrix.
  assert.deepEqual([...markers[0].matrix.subarray(12, 15)], [2, 1, -3]);
  assert.deepEqual([...markers[1].matrix.subarray(12, 15)], [5, 1, 2]);
  // Moving the model root moves the markers; the returned matrix is a copy.
  model.root.setPosition([0, 10, 0]);
  assert.deepEqual([...markers[1].matrix.subarray(12, 15)], [5, 1, 2]);
  assert.deepEqual([...model.extras()[1].matrix.subarray(12, 15)], [5, 11, 2]);
  // Mesh and material extras stay on the document.
  assert.deepEqual(model.asset.doc.meshes[0].extras, {collider: 'trimesh'});
  assert.deepEqual(model.asset.doc.materials[model.primitives[0].definition.material].extras, {surface: 'grass'});
  model.dispose(); engine.dispose();
});
