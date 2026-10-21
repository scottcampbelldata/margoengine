import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVox, writeVox } from '@margoengine/voxel/vox';
import { SparseGrid } from '../dist/sparse.js';
import * as vox from '../dist/vox.js';

const { gridFromVox, voxFromGrid } = vox;

function scene() {
  return {
    version: 200,
    palette: new Uint8Array(1024).fill(255),
    materials: [],
    layers: [],
    models: [
      { size: [1, 1, 1], voxels: new Uint8Array([0, 0, 0, 7]) },
      { size: [1, 1, 1], voxels: new Uint8Array([0, 0, 0, 9]) },
    ],
    nodes: [
      { id: 0, type: 'group', children: [1, 3], attributes: new Map([['_future', 'root']]) },
      {
        id: 1,
        type: 'transform',
        child: 2,
        layer: -1,
        frames: [
          { frame: 0, translation: [1, 2, 3], attributes: new Map([['_future', 'pose']]) },
          { frame: 8, translation: [4, 2, 3] },
        ],
      },
      { id: 2, type: 'shape', models: [{ model: 0, frame: 0, attributes: new Map([['_future', 'shape']]) }] },
      {
        id: 3,
        type: 'transform',
        child: 4,
        layer: -1,
        frames: [
          { frame: 0, translation: [10, 0, 0] },
          { frame: 4, translation: [20, 0, 0] },
        ],
      },
      { id: 4, type: 'group', children: [] },
    ],
    chunks: [{ id: 'ZZZZ', content: new Uint8Array([1, 7, 9]), children: new Uint8Array() }],
  };
}
const isState = (e) => e.name === 'MargoError' && e.code === 'state';

test('gridFromVox turns Z up to Y up; voxFromGrid inverts it and returns an unedited original', () => {
  const model = { size: [2, 3, 4], voxels: Uint8Array.from([1, 0, 3, 255, 0, 2, 1, 7, 1, 0, 3, 9]) },
    grid = gridFromVox(model);
  assert.deepEqual(grid.size, [2, 4, 3]);
  assert.equal(grid.voxels[1 + 2 * (2 + 3 * 3)], 9, 'the later record wins');
  assert.equal(grid.voxels[0 + 2 * (0 + 3 * 1)], 7);
  assert.equal(grid.voxels.filter(Boolean).length, 2);
  assert.equal(voxFromGrid(grid, model), model);
  const out = voxFromGrid(grid);
  assert.deepEqual(out.size, model.size);
  assert.deepEqual(gridFromVox(out), grid);
  out.voxels.fill(0);
  assert.equal(grid.voxels[1 + 2 * (2 + 3 * 3)], 9);
});

test('voxFromGrid reads a sparse grid filled cell by filled cell with the same turn', () => {
  const sparse = SparseGrid.empty([35, 3, 39]).edit([
      [34, 2, 38, 255],
      [1, 0, 2, 7],
    ]).grid,
    out = voxFromGrid(sparse);
  assert.equal(out.voxels.length, 8);
  assert.equal(gridFromVox(out).voxels[34 + 35 * (38 + 39 * 2)], 255);
  assert.equal(sparse.get(1, 0, 2), 7);
});

test('.vox conversion checks records, the 256 limit and budgets before allocating', () => {
  assert.throws(() => gridFromVox({ size: [256, 256, 256], voxels: new Uint8Array() }, { maxCells: 16 }), /maxCells/);
  assert.throws(() => gridFromVox({ size: [2, 3, 4], voxels: Uint8Array.from([2, 0, 0, 7]) }), /outside the model/);
  assert.throws(() => gridFromVox({ size: [2, 3, 4], voxels: Uint8Array.from([1, 0, 0, 0]) }), /palette index 0/);
  assert.throws(() => voxFromGrid({ size: [257, 1, 1], voxels: new Uint8Array(257) }), /256/);
  assert.throws(() => voxFromGrid({ size: [2, 1, 1], voxels: new Uint8Array(1) }), /hold 1 cells/);
});

test('layers: add, rename, hide and assign keep unknown keys and the rest of the scene', () => {
  const source = scene(),
    added = vox.addVoxLayer(source, '  Props ');
  assert.deepEqual(
    added.layers.map((l) => [l.id, l.name, l.hidden]),
    [[0, 'Props', false]],
  );
  assert.equal(added.models, source.models);
  const hidden = vox.updateVoxLayer(added, 0, { hidden: true });
  assert.equal(hidden.layers[0].attributes.get('_hidden'), '1');
  assert.equal(vox.updateVoxLayer(hidden, 0, { hidden: true }), hidden);
  const placed = vox.setVoxNodeLayer(hidden, 1, 0);
  assert.equal(placed.nodes.find((n) => n.id === 1).layer, 0);
  assert.equal(vox.setVoxNodeLayer(placed, 1, 0), placed);
  assert.throws(() => vox.setVoxNodeLayer(placed, 1, 5), /layer 5/);
  const named = vox.updateVoxNode(placed, 2, { name: 'Sword' });
  assert.equal(named.nodes.find((n) => n.id === 2).attributes.get('_name'), 'Sword');
  assert.throws(() => vox.updateVoxNode(placed, 2, { colour: 'red' }), TypeError);
  assert.throws(() => vox.addVoxLayer(source, ' '), RangeError);
  assert.doesNotThrow(() => parseVox(writeVox(named)));
});

test('transform keys share the scene key budget; replacing a key does not count', () => {
  const source = scene();
  source.nodes[2].models = Array.from({ length: 4095 }, (_, frame) => ({ frame, model: 0 }));
  for (let n = 0; n < 3; n++)
    source.nodes.push({
      id: 10 + n,
      type: 'shape',
      models: Array.from({ length: 4095 }, (_, frame) => ({ frame, model: 0 })),
    });
  const frames = source.nodes[1].frames;
  assert.throws(() => vox.setVoxTransformKey(source, 1, 9, { translation: [2, 3, 4] }), /16384 keys/);
  assert.equal(source.nodes[1].frames, frames);
  const replaced = vox.setVoxTransformKey(source, 1, 8, { translation: [2, 3, 4] });
  assert.deepEqual(replaced.nodes[1].frames[1].translation, [2, 3, 4]);
  assert.throws(() => vox.setVoxTransformKey(scene(), 1, 9, { translation: [0.5, 0, 0] }), RangeError);
  assert.throws(() => vox.setVoxTransformKey(scene(), 1, 9, { rotation: [1, 0, 0, 0, 1, 0, 0, 1, 0] }), /permutation/);
});

test('deleting a transform key keeps unknown data and refuses the last pose', () => {
  const source = scene(),
    before = writeVox(source),
    next = vox.deleteVoxTransformKey(source, 1, 8);
  assert.deepEqual(
    next.nodes[1].frames.map((k) => k.frame),
    [0],
  );
  assert.equal(next.nodes[1].frames[0].attributes.get('_future'), 'pose');
  assert.equal(next.models, source.models);
  assert.equal(next.chunks, source.chunks);
  assert.deepEqual(writeVox(source), before);
  assert.equal(vox.deleteVoxTransformKey(next, 1, 99), next);
  assert.throws(() => vox.deleteVoxTransformKey(next, 1, 0), isState);
  assert.equal(parseVox(writeVox(next)).nodes.find((n) => n.id === 1).frames.length, 1);
});

test('shape keys set, replace and delete without touching models', () => {
  const source = scene(),
    before = writeVox(source),
    next = vox.setVoxShapeKey(source, 2, 6, 1),
    shape = next.nodes.find((n) => n.id === 2);
  assert.deepEqual(
    shape.models.map((k) => [k.frame, k.model]),
    [
      [0, 0],
      [6, 1],
    ],
  );
  assert.equal(shape.models[1].attributes.get('_future'), 'shape');
  assert.equal(next.models, source.models);
  assert.equal(vox.setVoxShapeKey(next, 2, 6, 1), next);
  assert.deepEqual(
    vox
      .deleteVoxShapeKey(next, 2, 6)
      .nodes.find((n) => n.id === 2)
      .models.map((k) => k.model),
    [0],
  );
  assert.throws(() => vox.setVoxShapeKey(source, 2, 1, 99), /model 99/);
  assert.throws(() => vox.deleteVoxShapeKey(source, 2, 0), isState);
  assert.deepEqual(writeVox(source), before);
  assert.equal(parseVox(writeVox(next)).nodes.find((n) => n.id === 2).models[1].model, 1);
});

test('groups and instances get the next ids and share model data', () => {
  const source = scene(),
    before = writeVox(source),
    grouped = vox.addVoxGroup(source, 0, 'Props');
  assert.deepEqual([grouped.transformId, grouped.groupId], [5, 6]);
  const added = vox.addVoxInstance(grouped.scene, 6, 1, 'Sword');
  assert.deepEqual([added.transformId, added.shapeId], [7, 8]);
  assert.deepEqual(added.scene.nodes.find((n) => n.id === 6).children, [7]);
  assert.equal(added.scene.nodes.find((n) => n.id === 8).models[0].model, 1);
  assert.equal(added.scene.models, source.models);
  assert.equal(added.scene.chunks, source.chunks);
  assert.deepEqual(writeVox(source), before);
  assert.equal(parseVox(writeVox(added.scene)).nodes.length, 9);
  assert.throws(() => vox.addVoxInstance(source, 2, 0, 'Invalid'), /not a group/);
});

test('moveVoxNode keeps world poses at every old and new ancestor key', () => {
  const source = scene(),
    before = writeVox(source),
    next = vox.moveVoxNode(source, 1, 4);
  assert.deepEqual(next.nodes.find((n) => n.id === 0).children, [3]);
  assert.deepEqual(next.nodes.find((n) => n.id === 4).children, [1]);
  const node = next.nodes.find((n) => n.id === 1);
  assert.deepEqual(
    node.frames.map((k) => [k.frame, k.translation]),
    [
      [0, [-9, 2, 3]],
      [4, [-19, 2, 3]],
      [8, [-16, 2, 3]],
    ],
  );
  assert.equal(node.frames[0].attributes.get('_future'), 'pose');
  assert.deepEqual(writeVox(source), before);
  assert.doesNotThrow(() => parseVox(writeVox(next)));
  assert.equal(vox.moveVoxNode(next, 1, 4), next);
  assert.throws(() => vox.moveVoxNode(source, 3, 4), isState);
});

test('moveVoxNode keeps signed rotations and refuses moving a visible node into a hidden group', () => {
  const source = scene();
  source.nodes[3].frames = [{ frame: 0, translation: [10, 0, 0], rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1] }];
  const key = vox.moveVoxNode(source, 1, 4).nodes.find((n) => n.id === 1).frames[0];
  assert.deepEqual(key.translation, [2, 9, 3]);
  assert.deepEqual(key.rotation, [0, 1, 0, -1, 0, 0, 0, 0, 1]);
  source.nodes[3].hidden = true;
  const before = writeVox(source);
  assert.throws(() => vox.moveVoxNode(source, 1, 4), /hidden/);
  assert.deepEqual(writeVox(source), before);
});

test('deleteVoxNode removes a subtree, keeps models and refuses the root', () => {
  const source = scene(),
    before = writeVox(source),
    next = vox.deleteVoxNode(source, 1);
  assert.deepEqual(
    next.nodes.map((n) => n.id),
    [0, 3, 4],
  );
  assert.deepEqual(next.nodes[0].children, [3]);
  assert.equal(next.models, source.models);
  assert.deepEqual(writeVox(source), before);
  assert.throws(() => vox.deleteVoxNode(source, 0), /not a transform/);
  assert.doesNotThrow(() => parseVox(writeVox(next)));
});

test('ambiguous duplicate keys and exhausted int32 ids are refused, not guessed', () => {
  const source = scene();
  source.nodes[2].models.push({ frame: 0, model: 1 });
  assert.throws(() => vox.setVoxShapeKey(source, 2, 0, 0), /ambiguous/);
  assert.throws(() => vox.moveVoxNode(source, 1, 4), /ambiguous/);
  const full = scene();
  full.nodes[4].id = 2147483647;
  full.nodes[3].child = 2147483647;
  assert.throws(() => vox.addVoxGroup(full, 0, 'No room'), /int32/);
});
