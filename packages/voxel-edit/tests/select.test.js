import assert from 'node:assert/strict';
import test from 'node:test';
import { screenSelection, rectangleSelection, lassoSelection, colorSelection } from '../dist/select.js';
import { SparseGrid } from '../dist/sparse.js';
import { cellAt, cellIndex } from '../dist/index.js';

// Independent orthographic camera: X/Y [0,4] to [-1,1], Z [0,4] to reverse depth [1,0].
const camera = [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, -0.25, 0, -1, -1, 1, 1];
const full = { type: 'rectangle', min: [-1, -1], max: [1, 1] };
const grid = { size: [4, 4, 4], voxels: new Uint8Array(64).fill(1) };
const expected = (predicate) =>
  Float64Array.from(Array.from({ length: 64 }, (_, i) => i).filter((i) => predicate(...cellAt(grid.size, i))));

test('rectangle drag in either direction returns exact edit indexes and clips to frustum', () => {
  const want = expected((x, y) => x < 2 && y < 2);
  assert.deepEqual(rectangleSelection(grid, camera, [-1, -1], [0, 0]), want);
  assert.deepEqual(rectangleSelection(grid, camera, [0, 0], [-1, -1]), want);
  assert.deepEqual(
    screenSelection(grid, camera, full),
    expected(() => true),
  );
  const wide = { size: [8, 4, 8], voxels: new Uint8Array(256).fill(1) };
  const cells = screenSelection(wide, camera, { type: 'rectangle', min: [-100, -100], max: [100, 100] });
  assert.equal(cells.length, 64);
  assert.ok(
    [...cells].every((i) => {
      const [x, y, z] = cellAt(wide.size, i);
      return x < 4 && y < 4 && z < 4;
    }),
  );
  assert.deepEqual(grid.voxels, new Uint8Array(64).fill(1));
});

test('even-odd lasso covers concavity, reversed winding and exact boundary centres', () => {
  const triangle = [
    [-1, -1],
    [1, -1],
    [-1, 1],
  ];
  const want = expected((x, y) => x + y <= 3);
  assert.deepEqual(lassoSelection(grid, camera, triangle), want);
  assert.deepEqual(lassoSelection(grid, camera, triangle.toReversed()), want);
  const concave = [
    [-1, -1],
    [1, -1],
    [1, 0],
    [0, 0],
    [0, 1],
    [-1, 1],
  ];
  assert.deepEqual(
    lassoSelection(grid, camera, concave),
    expected((x, y) => x < 2 || y < 2),
  );
  assert.deepEqual(
    lassoSelection(grid, camera, [
      [-1, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
    ]),
    expected((x, y) => Math.abs(x - 1.5) <= Math.abs(y - 1.5)),
  );
  assert.deepEqual(
    rectangleSelection(grid, camera, [-0.75, -0.75], [-0.75, -0.75]),
    expected((x, y) => x === 0 && y === 0),
  );
});

test('model placement, perspective division and behind-camera rejection', () => {
  const model = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1];
  assert.deepEqual(
    screenSelection(grid, camera, full, { modelMatrix: model }),
    expected((x) => x >= 2),
  );
  // Clip W=localZ-1, x/y=local+offset, depth=0.5*W. Negative W rejects cells behind the eye.
  const perspective = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 1, -2, -2, -0.5, -1];
  const selected = screenSelection(grid, perspective, full);
  const want = expected((x, y, z) => z > 0 && Math.abs(x - 1.5) <= z - 0.5 && Math.abs(y - 1.5) <= z - 0.5);
  assert.deepEqual(selected, want);
  const clipped = perspective.slice();
  clipped[14] = 0; // z=1 centres now lie beyond the near plane despite positive W.
  assert.deepEqual(
    screenSelection(grid, clipped, full),
    expected((_x, _y, z) => z >= 2),
  );
});

test('visible-only picks the first occupied voxel, including holes and transformed grids', () => {
  assert.deepEqual(
    screenSelection(grid, camera, full, { visibleOnly: true }),
    expected((_x, _y, z) => z === 0),
  );
  const voxels = grid.voxels.slice();
  voxels[cellIndex(grid.size, 1, 2, 0)] = 0;
  const result = screenSelection({ ...grid, voxels }, camera, full, { visibleOnly: true });
  assert.equal(result.length, 16);
  assert.ok(result.includes(cellIndex(grid.size, 1, 2, 1)));
  const singular = new Array(16).fill(0);
  assert.equal(screenSelection(grid, singular, full, { visibleOnly: true }).length, 0);
});

test('global colour similarity compares RGBA values, including duplicated palette entries', () => {
  const voxels = Uint8Array.from({ length: 64 }, (_, i) => 1 + (i % 4)),
    palette = new Uint8Array(1024);
  palette.set([100, 40, 20, 255], 4);
  palette.set([100, 40, 20, 255], 8);
  palette.set([103, 44, 20, 255], 12);
  palette.set([100, 40, 20, 0], 16);
  const source = { ...grid, voxels };
  assert.deepEqual(
    colorSelection(source, camera, full, palette, 1),
    expected((x, y, z) => voxels[cellIndex(grid.size, x, y, z)] <= 2),
  );
  assert.deepEqual(
    colorSelection(source, camera, full, palette, 1, { tolerance: 5 / 510 }),
    expected((x, y, z) => voxels[cellIndex(grid.size, x, y, z)] <= 3),
  );
  assert.equal(colorSelection(source, camera, full, palette, 1, { tolerance: 1, visibleOnly: true }).length, 16);
});

test('sparse selections agree with dense selections and retain indexes past 2^32', () => {
  const sparse = SparseGrid.fromGrid(grid);
  assert.deepEqual(screenSelection(sparse, camera, full), screenSelection(grid, camera, full));
  assert.deepEqual(
    screenSelection(sparse, camera, full, { visibleOnly: true }),
    screenSelection(grid, camera, full, { visibleOnly: true }),
  );
  const size = [1000000, 4, 1000000],
    big = SparseGrid.empty(size).edit([[999999, 3, 999999, 2]]).grid;
  const cam = [2e-6, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, -1e-6, 0, -1, -1, 1, 1];
  assert.deepEqual(
    screenSelection(big, cam, full, { maxCells: 1 }),
    Float64Array.of(cellIndex(size, 999999, 3, 999999)),
  );
});

test('malformed shapes, matrices, palettes, options, budgets and cancellation refuse', () => {
  assert.throws(() => screenSelection(grid, camera, full, { maxCells: 2 }));
  assert.throws(() =>
    screenSelection(grid, camera, {
      type: 'lasso',
      points: [
        [0, 0],
        [1, 1],
      ],
    }),
  );
  assert.throws(() => screenSelection(grid, camera, { ...full, min: [NaN, 0] }));
  assert.throws(() => screenSelection(grid, new Array(16), full));
  assert.throws(() => screenSelection(grid, camera, full, { visibleOnly: 1 }));
  assert.throws(() => colorSelection(grid, camera, full, new Uint8Array(4), 1));
  assert.throws(() => colorSelection(grid, camera, full, new Uint8Array(1024), 0));
  assert.throws(() => colorSelection(grid, camera, full, new Uint8Array(1024), 1, { tolerance: NaN }));
  const reason = new Error('stop');
  assert.throws(
    () => screenSelection(grid, camera, full, { signal: AbortSignal.abort(reason) }),
    (e) => e === reason,
  );
});
