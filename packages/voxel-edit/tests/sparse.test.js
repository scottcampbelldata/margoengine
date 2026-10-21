import assert from 'node:assert/strict';
import test from 'node:test';
import { BlockTypes, VoxelWorld } from '@margoengine/voxel';
import { editWindow, SparseGrid } from '../dist/sparse.js';

const FAR = [1_000_003, 47, 900_001];

test('a million-wide grid holds only the chunks its two cells touch; restore gives either snapshot', () => {
  const empty = SparseGrid.empty(FAR),
    edits = [
      [2, 3, 4, 7],
      [1_000_002, 46, 900_000, 255],
    ],
    { grid, delta } = empty.edit(edits);
  assert.equal(grid.get(2, 3, 4), 7);
  assert.equal(grid.get(1_000_002, 46, 900_000), 255);
  assert.deepEqual([grid.stats.filled, grid.stats.chunks], [2, 2]);
  assert.ok(grid.stats.bytes < 20_000);
  assert.equal(empty.stats.chunks, 0);
  assert.equal(delta.changed, 2);
  assert.deepEqual(grid.bounds, { min: [2, 3, 4], max: [1_000_003, 47, 900_001] });
  assert.equal(grid.restore(delta, 'before').stats.chunks, 0);
  assert.equal(empty.restore(delta, 'after').get(1_000_002, 46, 900_000), 255);
  edits[0][3] = 99;
  assert.equal(grid.get(2, 3, 4), 7);
  assert.equal(SparseGrid.empty([4, 4, 4]).bounds, null);
});

test('windows are copies; edits copy only touched chunks and drop emptied ones', () => {
  const a = SparseGrid.empty([80, 65, 93]).edit([
    [31, 2, 32, 9],
    [32, 2, 32, 10],
  ]).grid;
  const windows = [...a.windows()];
  assert.equal(windows.length, 2);
  windows[0].voxels.fill(0);
  assert.equal(a.get(31, 2, 32), 9);
  const edit = a.edit([
    [31, 2, 32, 0],
    [32, 2, 32, 11],
    [32, 2, 32, 12],
  ]);
  assert.equal(edit.delta.changed, 2);
  assert.equal(edit.grid.stats.chunks, 1);
  assert.equal(edit.grid.restore(edit.delta, 'before').get(32, 2, 32), 10);
  assert.equal(a.get(32, 2, 32), 10);
  assert.throws(
    () => SparseGrid.empty([80, 65, 93]).restore(edit.delta, 'before'),
    (e) => e.name === 'MargoError' && e.code === 'state',
  );
  const same = a.edit([[31, 2, 32, 9]]);
  assert.equal(same.grid, a, 'an edit that changes nothing returns the same grid');
});

test('serialize and deserialize round-trip and reject bad, duplicate or oversized data', () => {
  const a = SparseGrid.empty(FAR).edit([
      [2, 3, 4, 7],
      [1_000_002, 46, 900_000, 255],
    ]).grid,
    data = a.serialize();
  assert.equal(data.format, 'margo-sparse-volume');
  const b = SparseGrid.deserialize(JSON.parse(JSON.stringify(data)));
  assert.deepEqual([...b.filled()], [...a.filled()]);
  data.chunks[0].palette[1] = 22;
  assert.equal(a.get(2, 3, 4), 7);
  assert.throws(() => SparseGrid.deserialize(a.serialize(), { maxChunks: 1 }), /maxChunks/);
  assert.throws(() => SparseGrid.deserialize(a.serialize(), { maxBytes: 100 }), /maxBytes/);
  const twice = a.serialize();
  twice.chunks.push(twice.chunks[0]);
  assert.throws(() => SparseGrid.deserialize(twice), /duplicate/);
  const bad = a.serialize();
  bad.chunks[0].palette[1] = 256;
  assert.throws(() => SparseGrid.deserialize(bad), /palette/);
  const short = a.serialize();
  short.chunks[0].words.pop();
  assert.throws(() => SparseGrid.deserialize(short), /word length/);
  const outside = a.serialize();
  outside.size = [1, 1, 1];
  assert.throws(() => SparseGrid.deserialize(outside), /outside/);
  assert.throws(() => SparseGrid.deserialize({ ...a.serialize(), version: 2 }), /format/);
});

test('readWindow and writeWindow edit a far box without allocating the empty extent', () => {
  const a = SparseGrid.empty(FAR).edit([[1_000_002, 46, 900_000, 255]]).grid,
    window = a.readWindow([999_999, 44, 899_999], [4, 3, 2]);
  assert.equal(window.voxels[3 + 4 * (1 + 2 * 2)], 255);
  window.voxels[0] = 3;
  const b = a.writeWindow(window).grid;
  assert.equal(b.get(999_999, 44, 899_999), 3);
  assert.equal(a.get(999_999, 44, 899_999), 0);
  assert.throws(() => a.readWindow([0, 0, 0], [1000, 40, 1000]), /maxWindowCells/);
  assert.throws(() => a.readWindow([1_000_000, 0, 0], [4, 1, 1]), /outside the grid/);
  assert.throws(
    () =>
      a.edit(
        [
          [0, 0, 0, 1],
          [1, 0, 0, 2],
        ],
        { maxEdits: 1 },
      ),
    /maxEdits/,
  );
});

test('budgets and bad edits reject the whole edit', () => {
  const a = SparseGrid.empty([100_000, 64, 100_000], { maxChunks: 1 });
  assert.throws(
    () =>
      a.edit([
        [0, 0, 0, 1],
        [99_999, 0, 99_999, 2],
      ]),
    /maxChunks/,
  );
  assert.equal(a.stats.chunks, 0);
  assert.throws(() => a.edit([[0, 0, 0, 256]]), /palette index/);
  assert.throws(() => a.edit([[0.5, 0, 0, 1]]), /integer/);
  assert.throws(() => a.edit([[-1, 0, 0, 1]]), /outside the grid/);
  assert.throws(() => SparseGrid.empty([2, 2, 2], { maxChunks: 4096 * 4 + 1 }), RangeError);
});

test('toWorld writes cells at origin + cell into an empty world, checking first', () => {
  const a = SparseGrid.empty([65, 33, 67], { origin: [-33, -17, -65] }).edit([
    [0, 0, 0, 7],
    [64, 32, 66, 9],
  ]).grid;
  const blocks = new BlockTypes();
  for (let id = 1; id <= 255; id++) blocks.define(`palette-${id}`);
  const world = new VoxelWorld({ blocks, minY: -32768, maxY: 32767 });
  a.toWorld(world);
  assert.equal(world.getBlock(-33, -17, -65), 7);
  assert.equal(world.getBlock(31, 15, 1), 9);
  assert.throws(
    () => a.toWorld(world),
    (e) => e.code === 'state',
  );
  assert.throws(() => SparseGrid.empty([2, 2, 2], { origin: [0, 32767, 0] }), /Y extent/);
});

test('windows cover held chunks only and neighbours across seams read through get', () => {
  const a = SparseGrid.empty(FAR).edit([
    [31, 3, 4, 7],
    [32, 3, 4, 7],
    [1_000_002, 46, 900_000, 255],
  ]).grid;
  let windows = 0,
    faces = 0;
  for (const w of a.windows()) {
    windows++;
    assert.ok(w.voxels.length <= 32 ** 3);
    const [sx, sy, sz] = w.size;
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++)
        for (let x = 0; x < sx; x++) {
          if (!w.voxels[x + sx * (z + sz * y)]) continue;
          for (const [dx, dy, dz] of [
            [-1, 0, 0],
            [1, 0, 0],
            [0, -1, 0],
            [0, 1, 0],
            [0, 0, -1],
            [0, 0, 1],
          ])
            if (!a.get(x + w.origin[0] + dx, y + w.origin[1] + dy, z + w.origin[2] + dz)) faces++;
        }
  }
  assert.equal(windows, 3);
  assert.equal(faces, 16);
});

test('raycast skips empty chunks, stops at maxDistance and treats edges and starts like the dense ray', () => {
  const a = SparseGrid.empty(FAR).edit([[1_000_002, 46, 900_000, 255]]).grid,
    hit = a.raycast([-10, 46.5, 900_000.5], [2, 0, 0]);
  assert.deepEqual(
    [hit?.cell, hit?.adjacent, hit?.normal, hit?.value, hit?.distance],
    [[1_000_002, 46, 900_000], [1_000_001, 46, 900_000], [-1, 0, 0], 255, 1_000_012],
  );
  assert.equal(a.raycast([-10, 46.5, 900_000.5], [2, 0, 0], 100), null);
  const diagonal = SparseGrid.empty([100, 100, 100]).edit([
    [1, 0, 0, 3],
    [2, 2, 2, 8],
  ]).grid;
  assert.deepEqual(diagonal.raycast([0.5, 0.5, 0.5], [1, 1, 1])?.cell, [2, 2, 2]);
  const b = SparseGrid.empty([65, 65, 65]).edit([
    [1, 0, 0, 7],
    [64, 0, 0, 9],
    [32, 31, 0, 19],
  ]).grid;
  assert.deepEqual(b.raycast([1, 0.5, 0.5], [-1, 0, 0])?.cell, [1, 0, 0]);
  assert.deepEqual(b.raycast([65, 0.5, 0.5], [-1, 0, 0])?.normal, [1, 0, 0]);
  assert.equal(b.raycast([31, 32.5, 0.5], [1, -1, 0])?.value, 19);
  const corner = SparseGrid.empty([65, 65, 65]).edit([[32, 31, 0, 19]]).grid;
  assert.equal(corner.raycast([31, 31, 0.5], [1, 1, 0]), null);
  assert.throws(() => corner.raycast([0, 0, 0], [0, 0, 0]), /zero/);
});

test('fromGrid copies a dense grid; editWindow fills, paints, erases and grows a box', () => {
  const voxels = new Uint8Array(35 * 3 * 5);
  voxels[31 + 35 * (2 + 5)] = 7;
  const a = SparseGrid.fromGrid({ size: [35, 3, 5], voxels });
  voxels.fill(0);
  assert.equal(a.get(31, 1, 2), 7);
  const grown = editWindow(a, { origin: [32, 1, 2], size: [1, 1, 1], operation: 'dilate' });
  assert.equal(grown.grid.get(32, 1, 2), 7, 'dilate copies the neighbour without color');
  assert.equal(
    editWindow(a, { origin: [32, 1, 2], size: [1, 1, 1], operation: 'dilate', color: 19 }).grid.get(32, 1, 2),
    19,
  );
  assert.equal(a.get(32, 1, 2), 0);
  const filled = editWindow(a, { origin: [0, 0, 0], size: [2, 2, 2], operation: 'fill', color: 255 }).grid;
  assert.equal(filled.stats.filled, 9);
  const painted = editWindow(filled, { origin: [0, 0, 0], size: [3, 2, 2], operation: 'paint', color: 9 }).grid;
  assert.equal(painted.get(2, 0, 0), 0);
  assert.equal(painted.get(0, 0, 0), 9);
  const eroded = editWindow(filled, { origin: [0, 0, 0], size: [2, 2, 2], operation: 'erode' }).grid;
  assert.equal(eroded.stats.filled, 1, 'every cell of the 2-cube touches air; the far voxel stays');
  assert.equal(editWindow(filled, { origin: [0, 0, 0], size: [2, 2, 2], operation: 'erase' }).grid.stats.filled, 1);
  assert.throws(
    () => editWindow(a, { origin: [0, 0, 0], size: [2, 2, 2], operation: 'fill', color: 0 }),
    /palette index/,
  );
  assert.throws(() => editWindow(a, { origin: [0, 0, 0], size: [2, 2, 2], operation: 'melt' }), TypeError);
});
