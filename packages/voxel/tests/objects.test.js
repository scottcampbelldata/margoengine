import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box, PbrMaterial } from '../../core/dist/extension.js';
import { parseGLTF } from '../../gltf/dist/index.js';
import { BlockTypes, VoxelWorld } from '../dist/index.js';
import { VoxelObjects, objectState } from '../dist/objects.js';
import { meshChunk, meshInput } from '../dist/mesher.js';

async function setup() {
  const draws = [];
  const engine = new Engine(
    { width: 32, height: 32 },
    await TransformStore.create(128),
    {
      backend: 'webgl2',
      add() {},
      remove() {},
      dispose() {},
      render(_camera, _lights, batches) {
        draws.length = 0;
        for (const b of batches) draws.push({ geometry: b.geometry, count: b.count });
      },
    },
    { position: [0.5, 0.5, 4], target: [0.5, 0.5, 0] },
  );
  const world = new VoxelWorld({ blocks: new BlockTypes() }),
    objects = VoxelObjects.attach(engine, world);
  return { engine, world, objects, draws };
}
test('core geometry is shared and instanced; edits retain unchanged handles and chunks stream away', async () => {
  const { engine, world, objects, draws } = await setup(),
    geometry = box(0.5, 0.5, 0.5),
    source = engine
      .createMesh()
      .setGeometry(geometry)
      .setMaterial(new PbrMaterial({ color: '#ff0000' })),
    id = objects.define('item', source);
  source.dispose();
  world.setBlock(0, 0, 0, id);
  world.setBlock(1, 0, 0, id);
  world.setBlock(10000, 0, 0, id);
  objects.update();
  const retained = objects.at(0, 0, 0);
  assert.equal(retained[1].geometry, geometry);
  assert.equal(objects.at(1, 0, 0)[1].geometry, geometry);
  engine.render();
  assert.equal(draws.length, 1);
  assert.equal(draws[0].count, 2); // distant object is culled
  world.setBlock(1, 0, 0, 0);
  objects.update();
  assert.equal(objects.at(0, 0, 0)[1], retained[1]);
  assert.equal(objects.stats.cells, 2);
  world.removeChunk(0, 0, 0);
  objects.update();
  assert.equal(objects.at(0, 0, 0).length, 0);
  assert.equal(objects.stats.cells, 1);
  world.removeChunk(312, 0, 0);
  objects.update();
  assert.deepEqual(objects.stats, { chunks: 0, cells: 0, meshes: 0 });
  objects.dispose();
  objects.dispose();
  assert.throws(
    () => objects.update(),
    (e) => e.code === 'disposed',
  );
  engine.dispose();
});
test('glTF graph snapshots preserve node transforms, primitives and source lifetime independence', async () => {
  const { engine, world, objects } = await setup();
  const positions = new Float32Array([-0.2, 0, 0, 0.2, 0, 0, 0, 0.4, 0]),
    doc = {
      asset: { version: '2.0' },
      buffers: [{ byteLength: positions.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      nodes: [
        { mesh: 0, translation: [0, 0.25, 0], children: [1] },
        { mesh: 0, translation: [0, 0.5, 0] },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    };
  const model = parseGLTF(engine, doc, [positions]),
    id = objects.define('gltf', model);
  model.root.position.x = 20;
  model.dispose();
  world.setBlock(-1, 0, 0, objectState(id, 1));
  objects.update();
  engine.render();
  const made = objects.at(-1, 0, 0),
    rendered = made.filter((m) => m.geometry);
  assert.equal(rendered.length, 2);
  assert.equal(rendered[0].geometry, rendered[1].geometry);
  assert.deepEqual(rendered.map((m) => Math.round(m.matrix[13] * 100) / 100).sort(), [0.25, 0.75]);
  assert.equal(made[0].position.x, -0.5);
  assert.ok(Math.abs(made[0].rotation.y - Math.PI / 2) < 1e-6);
  assert.equal(meshChunk(meshInput(world, '-1,0,0')).opaque.length, 0);
  objects.dispose();
  engine.dispose();
});
test('invalid source graphs and states do not define partially usable block types', async () => {
  const { engine, world, objects } = await setup(),
    empty = engine.createMesh(),
    source = engine.createMesh().setGeometry(box());
  assert.throws(() => objects.define('empty', empty), RangeError);
  assert.throws(() => objects.define('foreign graph', { root: empty, meshes: [source] }), TypeError);
  assert.equal(world.blocks.table.length, 1);
  for (const turns of [-1, 4, 1.5, NaN]) assert.throws(() => objectState(1, turns), RangeError);
  objects.dispose();
  engine.dispose();
});
