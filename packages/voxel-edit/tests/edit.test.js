import assert from 'node:assert/strict';
import test from 'node:test';
import { cellAt, cellIndex } from '../dist/index.js';
import { boxCells, connectedCells, faceCells, floodCells, lineCells, sphereCells } from '../dist/edit.js';
import { groundCell, pickRay, raycastGrid } from '../dist/pick.js';
import { SparseGrid } from '../dist/sparse.js';

const empty = (size) => ({ size, voxels: new Uint8Array(size[0] * size[1] * size[2]) });
const cells = (grid, indexes) => [...indexes].map((i) => cellAt(grid.size, i).join()).sort();

test('raycastGrid normalizes finite directions at extreme magnitudes, dense and sparse', () => {
  const dense = { size: [2, 1, 2], voxels: Uint8Array.from([0, 0, 0, 1]) };
  const origin = [-0.5, 0.5, -0.5];
  for (const grid of [dense, SparseGrid.fromGrid(dense)]) {
    const expected = raycastGrid(grid, { origin, direction: [1, 0, 1] });
    assert.ok(expected);
    for (const magnitude of [Number.MAX_VALUE, Number.MIN_VALUE]) {
      const ray = { origin, direction: [magnitude, 0, magnitude] };
      assert.deepEqual(raycastGrid(grid, ray), expected);
      assert.equal(raycastGrid(grid, ray, 2), null, 'maxDistance uses a unit direction');
    }
  }
});

test('lineCells includes both ends and handles reversed and zero-length lines', () => {
  assert.deepEqual(lineCells([0, 0, 0], [3, 1, 0]), [
    [0, 0, 0],
    [1, 0, 0],
    [2, 1, 0],
    [3, 1, 0],
  ]);
  assert.deepEqual(lineCells([1, 2, 3], [1, 2, 3]), [[1, 2, 3]]);
  assert.deepEqual(lineCells([2, 0, 0], [0, 0, 0]), [
    [2, 0, 0],
    [1, 0, 0],
    [0, 0, 0],
  ]);
});

test('boxCells takes corners in either order; hollow keeps only the shell', () => {
  assert.equal(boxCells([2, 2, 2], [0, 0, 0]).length, 27);
  const shell = boxCells([0, 0, 0], [2, 2, 2], { hollow: true });
  assert.equal(shell.length, 26);
  assert.ok(!shell.some((p) => p.join() === '1,1,1'));
});

test('sphereCells is round and its radius is bounded', () => {
  assert.equal(sphereCells([0, 0, 0], 1).length, 7);
  assert.deepEqual(sphereCells([2, 3, 4], 0), [[2, 3, 4]]);
  assert.throws(() => sphereCells([0, 0, 0], -1), RangeError);
});

test('brush limits reject huge footprints without changing the input point', () => {
  const point = [1, 2, 3];
  assert.throws(() => lineCells(point, [4098, 2, 3]), /4096/);
  assert.throws(() => boxCells(point, [1000, 1000, 1000]), /over 16777216/);
  assert.throws(() => sphereCells(point, 129), /128/);
  assert.deepEqual(point, [1, 2, 3]);
  assert.throws(() => lineCells(new Array(3), [1, 2, 3]), RangeError);
});

test('floodCells follows face neighbours with the same index and never wraps across a row', () => {
  const grid = empty([3, 1, 2]);
  grid.voxels.set([1, 1, 0, 0, 1, 1]);
  assert.deepEqual(cells(grid, floodCells(grid, [0, 0, 0])), ['0,0,0', '1,0,0', '1,0,1', '2,0,1']);
  grid.voxels.set([0, 0, 1, 1, 0, 0]);
  assert.deepEqual(cells(grid, floodCells(grid, [2, 0, 0])), ['2,0,0']);
  assert.deepEqual([...floodCells(grid, [-1, 0, 0])], []);
});

test('connectedCells crosses palette indexes and returns its own array', () => {
  const grid = empty([3, 1, 2]);
  grid.voxels.set([1, 7, 0, 0, 9, 255]);
  const result = connectedCells(grid, [0, 0, 0]);
  assert.ok(result instanceof Float64Array);
  assert.deepEqual([...result], [0, 1, 4, 5]);
  result.fill(0);
  assert.deepEqual([...grid.voxels], [1, 7, 0, 0, 9, 255]);
  assert.deepEqual([...connectedCells(grid, [-1, 0, 0])], []);
  assert.deepEqual([...connectedCells(grid, [2, 0, 0])], [], 'an air seed selects nothing');
  assert.throws(() => connectedCells(grid, [0.5, 0, 0]), /integers/);
});

test('faceCells follows an exposed layer across indexes but not through a covered cell', () => {
  const grid = empty([4, 2, 4]);
  grid.voxels[0] = 3;
  grid.voxels[1] = 7;
  grid.voxels[4] = 8;
  grid.voxels[15] = 9;
  assert.deepEqual(cells(grid, faceCells(grid, [0, 0, 0], [0, 1, 0])), ['0,0,0', '0,0,1', '1,0,0']);
  grid.voxels[17] = 10; // covers (1, 0, 0) from above
  assert.deepEqual(cells(grid, faceCells(grid, [0, 0, 0], [0, 1, 0])), ['0,0,0', '0,0,1']);
  assert.deepEqual([...faceCells(grid, [1, 0, 0], [0, 1, 0])], []);
  assert.deepEqual(cells(grid, faceCells(grid, [3, 0, 3], [1, 0, 0])), ['3,0,3']);
  assert.throws(() => faceCells(grid, [0, 0, 0], [1, 1, 0]), RangeError);
});

test('selections check dense grids and their budget before reading cells', () => {
  for (const grid of [
    { size: [2, 1, 1], voxels: Uint8Array.of(7) },
    { size: [1e6, 1e6, 1], voxels: Uint8Array.of(7) },
  ])
    for (const select of [
      () => floodCells(grid, [0, 0, 0]),
      () => connectedCells(grid, [0, 0, 0]),
      () => faceCells(grid, [0, 0, 0], [0, 1, 0]),
    ])
      assert.throws(select, RangeError);
  const full = { size: [4, 1, 1], voxels: new Uint8Array(4).fill(1) };
  assert.throws(() => connectedCells(full, [0, 0, 0], { maxCells: 3 }), /maxCells/);
  assert.equal(connectedCells(full, [0, 0, 0], { maxCells: 4 }).length, 4);
});

test('selections on a sparse grid keep cell indexes beyond 2^32 and leave it unchanged', () => {
  const size = [1_000_003, 47, 900_001],
    sparse = SparseGrid.empty(size).edit([
      [1_000_001, 46, 900_000, 255],
      [1_000_002, 46, 900_000, 7],
    ]).grid,
    seed = [1_000_001, 46, 900_000],
    id = cellIndex(size, ...seed);
  assert.ok(id > 0xffffffff);
  assert.deepEqual([...connectedCells(sparse, seed)], [id, id + 1]);
  assert.deepEqual([...faceCells(sparse, seed, [0, 1, 0])], [id, id + 1]);
  assert.deepEqual([...floodCells(sparse, seed)], [id]);
  assert.deepEqual(cellAt(size, id), seed);
  assert.throws(() => floodCells(sparse, [0, 0, 0]), /flood the air/);
  assert.throws(() => connectedCells(sparse, seed, { maxCells: 1 }), /maxCells/);
  assert.equal(sparse.get(...seed), 255);
  assert.equal(sparse.stats.filled, 2);
});

test('pickRay unprojects with reverse depth and returns null for a singular matrix', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.deepEqual(pickRay(identity, 0.5, -0.25), { origin: [0.5, -0.25, 1], direction: [0, 0, -1] });
  assert.equal(pickRay(new Float64Array(16), 0, 0), null);
});

test('raycastGrid reports the entry face, the cell in front of it and the distance', () => {
  const grid = empty([4, 4, 4]);
  grid.voxels[3] = 255;
  grid.voxels[1] = 7;
  assert.deepEqual(raycastGrid(grid, { origin: [4, 0.5, 0.5], direction: [-1, 0, 0] }), {
    cell: [3, 0, 0],
    adjacent: [4, 0, 0],
    normal: [1, 0, 0],
    value: 255,
    distance: 0,
  });
  assert.deepEqual(raycastGrid(grid, { origin: [6, 0.5, 0.5], direction: [-2, 0, 0] })?.distance, 2);
  assert.deepEqual(raycastGrid(grid, { origin: [1, 0.5, 0.5], direction: [-1, 0, 0] }), {
    cell: [1, 0, 0],
    adjacent: [1, 0, 0],
    normal: [0, 0, 0],
    value: 7,
    distance: 0,
  });
  assert.equal(raycastGrid(grid, { origin: [6, 0.5, 0.5], direction: [-1, 0, 0] }, 1.5), null);
});

test('rays through an edge skip both cells; groundCell is half-open', () => {
  const grid = empty([4, 4, 4]);
  grid.voxels[20] = 7;
  assert.equal(raycastGrid(grid, { origin: [-1, -1, 1.5], direction: [Math.SQRT1_2, Math.SQRT1_2, 0] }), null);
  assert.deepEqual(groundCell(grid.size, { origin: [2.5, 9, 1.2], direction: [0, -1, 0] }), [2, 0, 1]);
  assert.equal(groundCell(grid.size, { origin: [4, 9, 1.2], direction: [0, -1, 0] }), null);
});

test('raycastGrid on a sparse grid skips empty chunks and matches the dense rules', () => {
  const sparse = SparseGrid.empty([1_000_003, 47, 900_001]).edit([[1_000_002, 46, 900_000, 255]]).grid;
  assert.deepEqual(raycastGrid(sparse, { origin: [-10, 46.5, 900_000.5], direction: [1, 0, 0] }), {
    cell: [1_000_002, 46, 900_000],
    adjacent: [1_000_001, 46, 900_000],
    normal: [-1, 0, 0],
    value: 255,
    distance: 1_000_012,
  });
  const small = SparseGrid.empty([4, 4, 4]).edit([
    [1, 0, 0, 7],
    [3, 0, 0, 9],
  ]).grid;
  assert.deepEqual(raycastGrid(small, { origin: [1, 0.5, 0.5], direction: [-1, 0, 0] })?.normal, [0, 0, 0]);
  assert.deepEqual(raycastGrid(small, { origin: [4, 0.5, 0.5], direction: [-1, 0, 0] })?.normal, [1, 0, 0]);
});

test('raycastGrid on a top edge reports the exposed face, not the occupied side', () => {
  // 5 wide x 24 tall x 2 deep solid curtain. The top edge of cell [3,23,0] has an occupied
  // neighbour on +X and air above. A ray that crosses that edge must report the top normal
  // so faceCells can select the face (E36).
  const size = [6, 25, 4];
  const grid = empty(size);
  for (let y = 0; y < 24; y++)
    for (let z = 0; z < 2; z++) for (let x = 0; x < 5; x++) grid.voxels[x + size[0] * (z + size[2] * y)] = 1;
  const hit = raycastGrid(grid, { origin: [5, 26, 0.5], direction: [-1, -2, 0] });
  assert.ok(hit, 'ray hits the curtain');
  assert.deepEqual(hit.normal, [0, 1, 0]);
  assert.equal(grid.voxels[hit.adjacent[0] + size[0] * (hit.adjacent[2] + size[2] * hit.adjacent[1])] ?? 0, 0);
  assert.ok(faceCells(grid, hit.cell, hit.normal).length > 0);
});

test('exposed-face ties cover sparse grids, reversed axes and corners', () => {
  const size = [6, 25, 4];
  const fill = [];
  for (let y = 0; y < 24; y++) for (let z = 0; z < 2; z++) for (let x = 0; x < 5; x++) fill.push([x, y, z, 1]);
  const sparse = SparseGrid.empty(size).edit(fill).grid;
  const top = raycastGrid(sparse, { origin: [5, 26, 0.5], direction: [-1, -2, 0] });
  assert.deepEqual(top.normal, [0, 1, 0]);
  assert.equal(sparse.get(...top.adjacent), 0);

  // Bottom edge, side neighbour occupied, steeper in X than in Y: the empty face still wins.
  const bottom = empty(size);
  for (let y = 1; y < 24; y++)
    for (let z = 0; z < 2; z++) for (let x = 0; x < 5; x++) bottom.voxels[x + size[0] * (z + size[2] * y)] = 1;
  const under = raycastGrid(bottom, { origin: [7, -0.5, 0.5], direction: [-3, 1.5, 0] });
  assert.ok(under);
  assert.deepEqual(under.normal, [0, -1, 0]);
  assert.equal(bottom.voxels[under.adjacent[0] + size[0] * (under.adjacent[2] + size[2] * under.adjacent[1])] ?? 0, 0);

  // Corner of a box. The ray is steepest in Y, so the exposed top wins over the two sides.
  const box = empty([8, 28, 8]);
  for (let y = 0; y < 24; y++)
    for (let z = 0; z < 4; z++) for (let x = 0; x < 5; x++) box.voxels[x + 8 * (z + 8 * y)] = 1;
  const corner = raycastGrid(box, { origin: [8, 30, 7], direction: [-1, -2, -1] });
  assert.deepEqual(corner.normal, [0, 1, 0]);
  assert.equal(box.voxels[corner.adjacent[0] + 8 * (corner.adjacent[2] + 8 * corner.adjacent[1])] ?? 0, 0);
  assert.ok(faceCells(box, corner.cell, corner.normal).length > 0);

  // Orthographic parallel ray, and a slanted (perspective) ray, both through the exposed top.
  const ortho = raycastGrid(box, { origin: [2.5, 40, 2.5], direction: [0, -1, 0] });
  assert.deepEqual(ortho.normal, [0, 1, 0]);
  const view = pickRay([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0.2, 0.4);
  assert.ok(view && view.direction[2] !== 0);
  const perspective = raycastGrid(box, { origin: [2.2, 40, 1.8], direction: [0.15, -1, 0.05] });
  assert.deepEqual(perspective.normal, [0, 1, 0]);
});
