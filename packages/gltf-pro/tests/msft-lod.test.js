// MSFT_lod: a node's level nodes load though no scene names them, sit under its parent and start hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseGLTF } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function parse(nodes, scene = [0]) {
  const device = optionalGPU().engine.gpu,
    store = await TransformStore.create(32),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    buffers = [
      new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0]),
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      new Uint32Array([0, 1, 2]),
    ];
  return parseGLTF(
    engine,
    {
      asset: { version: '2.0' },
      buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
      bufferViews: buffers.map((data, buffer) => ({ buffer, byteLength: data.byteLength })),
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5125, count: 3, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
      nodes,
      scene: 0,
      scenes: [{ nodes: scene }],
    },
    buffers,
  );
}

test('levels load outside the scene, under the base node, hidden, with their coverage', async () => {
  const model = await parse([
    { mesh: 0, children: [1] },
    { mesh: 0, extensions: { MSFT_lod: { ids: [2, 3] } }, extras: { MSFT_screencoverage: [0.5, 0.2, 0.05] } },
    { mesh: 0 },
    { mesh: 0 },
  ]);
  assert.equal(model.lods.length, 1);
  const [lod] = model.lods;
  assert.ok(lod.node === model.nodes[1]);
  assert.equal(lod.levels.length, 3);
  for (let i = 0; i < 3; i++) assert.ok(lod.levels[i] === model.nodes[i + 1]);
  assert.deepEqual(lod.screenCoverage, [0.5, 0.2, 0.05]);
  assert.equal(model.nodes[1].visible, true);
  assert.equal(model.nodes[2].visible, false);
  assert.equal(model.nodes[3].visible, false);
  assert.equal(model.nodes[2].engine.store.parents[model.nodes[2].id], model.nodes[0].id, 'under the base parent');
  assert.equal(model.primitives.length, 4, 'the levels have geometry');
});

test('without the extension nothing changes, and a node outside the scene stays unloaded', async () => {
  const model = await parse([{ mesh: 0 }, { mesh: 0 }]);
  assert.deepEqual(model.lods, []);
  assert.equal(model.primitives.length, 1);
});

test('bad ids and bad coverage name the node', async () => {
  await assert.rejects(parse([{ mesh: 0, extensions: { MSFT_lod: { ids: [0] } } }]), /node 0 MSFT_lod/);
  await assert.rejects(parse([{ mesh: 0, extensions: { MSFT_lod: { ids: [5] } } }]), /node 0 MSFT_lod/);
  await assert.rejects(parse([{ mesh: 0, extensions: { MSFT_lod: { ids: 'no' } } }]), /node 0 MSFT_lod/);
  await assert.rejects(
    parse([
      { mesh: 0, extensions: { MSFT_lod: { ids: [1] } }, extras: { MSFT_screencoverage: [0.1, 0.5] } },
      { mesh: 0 },
    ]),
    /node 0 MSFT_screencoverage/,
  );
});
