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

test('origin: objects 2^24 blocks out, under their origin, sit where the same objects near zero sit; a moved origin moves them', async () => {
  const S = 2 ** 24,
    { engine, world, objects } = await setup(),
    far = VoxelObjects.attach(engine, world, { origin: { origin: [S, 2048, -S] } }),
    source = engine
      .createMesh()
      .setGeometry(box(0.5, 0.5, 0.5))
      .setMaterial(new PbrMaterial({ color: '#ff0000' })),
    id = objects.define('item', source),
    farId = far.define('far item', source);
  world.setBlock(3, 1, 5, objectState(id, 1));
  world.setBlock(S + 3, 2048 + 1, -S + 5, objectState(farId, 1));
  objects.update();
  far.update();
  const xyz = (m) => [m.position.x, m.position.y, m.position.z],
    near = objects.at(3, 1, 5)[0],
    placed = far.at(S + 3, 2048 + 1, -S + 5)[0];
  assert.deepEqual(xyz(near), [3.5, 1, 5.5]);
  assert.deepEqual(xyz(placed), xyz(near));
  assert.deepEqual([placed.rotation.x, placed.rotation.y], [near.rotation.x, near.rotation.y]);
  // In place and live: every placement moves to its cell minus the new origin, in float64.
  far.origin.origin[0] = S + 10.25;
  far.update();
  assert.deepEqual(xyz(placed), [3.5 - 10.25, 1, 5.5]);
  far.origin = null;
  far.update();
  assert.deepEqual(xyz(placed), [Math.fround(S + 3.5), 2049, Math.fround(-S + 5.5)]);
  assert.throws(() => VoxelObjects.attach(engine, world, { origin: [1, 2, 3] }), TypeError);
  far.origin = { origin: [0, Number.NaN, 0] };
  assert.throws(() => far.update(), RangeError);
  far.dispose();
  objects.dispose();
  engine.dispose();
});
test('a placement that fails mid-chunk keeps the placements made before it owned, so dispose releases them', async () => {
  const { engine, world, objects } = await setup(),
    good = box(0.5, 0.5, 0.5),
    bad = box(0.5, 0.5, 0.5),
    material = new PbrMaterial({ color: '#ff0000' }),
    make = (geometry) => engine.createMesh().setGeometry(geometry).setMaterial(material),
    ok = objects.define('ok', make(good)),
    // A chain one level deeper than a placement can hold is refused at define; one level shorter is placed.
    chain = [make(bad)];
  while (chain.length < 64) chain.push(make(bad).setParent(chain.at(-1)));
  assert.throws(() => objects.define('too deep', { root: chain[0], meshes: chain }), RangeError);
  const deepest = objects.define('deep', { root: chain[0], meshes: chain.slice(0, 63) });
  world.setBlock(40, 0, 0, deepest);
  objects.update();
  assert.equal(objects.at(40, 0, 0).length, 64);
  world.setBlock(40, 0, 0, 0);
  objects.update();
  // A placement that fails part way (here the engine refuses every mesh from the fifth on).
  const broken = objects.define('broken', make(bad)),
    before = engine.meshes.size,
    createMesh = engine.createMesh;
  let calls = 0;
  engine.createMesh = function (...args) {
    if (++calls >= 5) throw new RangeError('no mesh slot');
    return createMesh.apply(this, args);
  };
  world.setBlocks([0, 0, 0, ok, 1, 0, 0, ok, 2, 0, 0, broken]);
  assert.throws(() => objects.update());
  assert.deepEqual(objects.stats, { chunks: 1, cells: 2, meshes: 4 });
  assert.equal(objects.at(1, 0, 0).length, 2);
  assert.equal(engine.meshes.size, before + 4);
  // A second try does not place the first cells twice.
  assert.throws(() => objects.update());
  assert.equal(engine.meshes.size, before + 4);
  engine.createMesh = createMesh;
  objects.update(); // the retry finishes the chunk
  assert.deepEqual(objects.stats, { chunks: 1, cells: 3, meshes: 6 });
  world.setBlock(2, 0, 0, 0);
  objects.update();
  assert.deepEqual(objects.stats, { chunks: 1, cells: 2, meshes: 4 });
  objects.dispose();
  assert.equal(engine.meshes.size, before);
  engine.dispose();
});
