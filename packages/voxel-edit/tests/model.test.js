import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cellAt,
  cellIndex,
  combineGrids,
  dilateGrid,
  erodeGrid,
  fillEnclosed,
  generateMaze,
  insideGrid,
  mergePalettes,
  reflectDiagonal,
  repeatGrid,
  resampleGrid,
  rotateGrid,
  shearGrid,
  wrapGrid,
} from '../dist/index.js';

const grid = (size, values) => ({ size, voxels: Uint8Array.from(values) });
const line = (values) => grid([values.length, 1, 1], values);
const palette = (...pairs) => {
  const p = new Uint8Array(256);
  for (const [from, to] of pairs) p[from] = to;
  return p;
};
/** Asserts `fn` throws a RangeError without constructing any Uint8Array first. */
const throwsBeforeAllocating = (fn) => {
  const Original = globalThis.Uint8Array;
  globalThis.Uint8Array = new Proxy(Original, {
    construct() {
      throw new Error('allocated before validating');
    },
  });
  try {
    assert.throws(fn, RangeError);
  } finally {
    globalThis.Uint8Array = Original;
  }
};

test('cellIndex, cellAt and insideGrid share the x + sx * (z + sz * y) layout', () => {
  assert.equal(cellIndex([7, 3, 5], 6, 2, 4), 104);
  assert.deepEqual(cellAt([7, 3, 5], 104), [6, 2, 4]);
  assert.equal(insideGrid([7, 3, 5], 6, 2, 4), true);
  assert.equal(insideGrid([7, 3, 5], 7, 2, 4), false);
  assert.equal(insideGrid([7, 3, 5], 6.5, 2, 4), false);
});

test('union moves the tool by offset, remaps its palette, keeps filled base cells and clips the rest', () => {
  const base = grid([4, 1, 1], [1, 0, 2, 0]),
    tool = grid([4, 1, 1], [7, 7, 8, 9]),
    r = combineGrids(base, tool, {
      operation: 'union',
      offset: [1, 0, 0],
      paletteMap: palette([7, 4], [8, 5], [9, 6]),
    });
  assert.deepEqual([...r.grid.voxels], [1, 4, 2, 5]);
  assert.deepEqual(r.grid.size, [4, 1, 1]);
  assert.equal(r.changed, 2);
  assert.equal(r.clipped, 1);
  assert.deepEqual([...base.voxels], [1, 0, 2, 0]);
  assert.deepEqual([...tool.voxels], [7, 7, 8, 9]);
});

test("union with overlap 'tool' replaces base indexes and takes negative offsets", () => {
  const r = combineGrids(grid([3, 1, 1], [1, 2, 3]), grid([3, 1, 1], [7, 8, 9]), {
    operation: 'union',
    offset: [-1, 0, 0],
    overlap: 'tool',
    paletteMap: palette([7, 4], [8, 5], [9, 6]),
  });
  assert.deepEqual([...r.grid.voxels], [5, 6, 3]);
  assert.equal(r.clipped, 1);
});

test('intersect keeps base cells under filled tool cells; subtract empties them, in Y-up layout', () => {
  const kept = combineGrids(line([1, 2, 3, 4]), line([7, 0]), { operation: 'intersect', offset: [1, 0, 0] });
  assert.deepEqual([...kept.grid.voxels], [0, 2, 0, 0]);
  assert.equal(kept.changed, 3);
  const cut = combineGrids(grid([2, 2, 2], [1, 2, 3, 4, 5, 6, 7, 8]), grid([1, 1, 1], [9]), {
    operation: 'subtract',
    offset: [0, 1, 1],
  });
  assert.deepEqual([...cut.grid.voxels], [1, 2, 3, 4, 5, 6, 0, 8]);
  assert.equal(cut.changed, 1);
});

test('combineGrids checks budgets and inputs before allocating or reading cells', () => {
  const a = grid([2, 2, 2], new Array(8).fill(1));
  throwsBeforeAllocating(() => combineGrids(a, a, { operation: 'subtract', maxCells: 7 }));
  const huge = {
    size: [1e9, 1e9, 1e9],
    get voxels() {
      throw new Error('read the voxels');
    },
  };
  assert.throws(() => combineGrids(huge, a, { operation: 'subtract' }), RangeError);
  const one = grid([1, 1, 1], [1]);
  assert.throws(() => combineGrids(one, one, { operation: 'union' }), TypeError);
  assert.throws(() => combineGrids(one, one, { operation: 'union', paletteMap: palette() }), /empties tool index 1/);
  assert.throws(() => combineGrids(one, one, { operation: 'subtract', offset: [0, 0.5, 0] }), RangeError);
  assert.throws(() => combineGrids(grid([2, 1, 1], [1]), one, { operation: 'subtract' }), /hold 1 cells, not 2/);
  assert.throws(() => combineGrids(one, one, { operation: 'intersection' }), TypeError);
});

test('shearGrid shifts layers along an axis without touching the input; ties round up', () => {
  const a = grid([3, 3, 1], [1, 0, 0, 2, 0, 0, 3, 0, 0]),
    r = shearGrid(a, { axis: 'x', along: 'y', factor: 1 });
  assert.deepEqual([...r.grid.voxels], [1, 0, 0, 0, 2, 0, 0, 0, 3]);
  assert.equal(r.changed, 4);
  assert.equal(r.clipped, 0);
  assert.deepEqual([...a.voxels], [1, 0, 0, 2, 0, 0, 3, 0, 0]);
  const off = shearGrid(grid([3, 3, 1], [0, 0, 1, 0, 0, 2, 0, 0, 3]), { axis: 'x', along: 'y', factor: 1 });
  assert.deepEqual([...off.grid.voxels], [0, 0, 1, 0, 0, 0, 0, 0, 0]);
  assert.equal(off.clipped, 2);
  const back = shearGrid(grid([3, 3, 1], [0, 1, 0, 0, 2, 0, 0, 3, 0]), { axis: 'x', along: 'y', factor: -1, pivot: 1 });
  assert.deepEqual([...back.grid.voxels], [0, 0, 1, 0, 2, 0, 3, 0, 0]);
  const half = shearGrid(grid([2, 1, 2], [4, 0, 5, 0]), { axis: 'x', along: 'z', factor: 1, pivot: 0.5 });
  assert.deepEqual([...half.grid.voxels], [4, 0, 0, 5]);
});

test('shearGrid checks options and budgets before allocating', () => {
  const a = grid([2, 2, 2], new Array(8).fill(1));
  throwsBeforeAllocating(() => shearGrid(a, { axis: 'x', along: 'y', factor: 1, maxCells: 7 }));
  throwsBeforeAllocating(() => shearGrid(a, { axis: 'x', along: 'y', factor: Infinity }));
  throwsBeforeAllocating(() => shearGrid(a, { axis: 'x', along: 'y', factor: Number.MAX_VALUE, pivot: 2 }));
  assert.throws(() => shearGrid(a, { axis: 'x', along: 'x', factor: 1 }), TypeError);
  assert.throws(() => shearGrid(a, { axis: 'q', along: 'y', factor: 1 }), TypeError);
});

test('reflectDiagonal mirrors each plane, and symmetrize copies the kept half (air included)', () => {
  for (const [plane, size] of [
    ['xy', [2, 2, 1]],
    ['xz', [2, 1, 2]],
    ['yz', [1, 2, 2]],
  ]) {
    const a = grid(size, [1, 2, 3, 4]),
      r = reflectDiagonal(a, { plane, mode: 'mirror' });
    assert.deepEqual([...r.grid.voxels], [1, 3, 2, 4], plane);
    assert.equal(r.changed, 2);
    assert.deepEqual([...a.voxels], [1, 2, 3, 4]);
  }
  const a = grid([2, 2, 1], [1, 2, 3, 4]);
  assert.deepEqual([...reflectDiagonal(a, { plane: 'xy' }).grid.voxels], [1, 3, 3, 4]);
  assert.deepEqual([...reflectDiagonal(a, { plane: 'xy', keep: 'upper' }).grid.voxels], [1, 2, 2, 4]);
  assert.deepEqual([...reflectDiagonal(grid([2, 2, 1], [1, 2, 0, 4]), { plane: 'xy' }).grid.voxels], [1, 0, 0, 4]);
  assert.deepEqual(
    [...reflectDiagonal(a, { plane: 'xy', diagonal: 'anti', mode: 'mirror' }).grid.voxels],
    [4, 2, 3, 1],
  );
  assert.deepEqual([...reflectDiagonal(a, { plane: 'xy', diagonal: 'anti' }).grid.voxels], [1, 2, 3, 1]);
});

test('reflectDiagonal refuses non-square planes and unknown choices before allocating', () => {
  const tall = grid([2, 3, 1], new Array(6).fill(1));
  throwsBeforeAllocating(() => reflectDiagonal(tall, { plane: 'xy' }));
  throwsBeforeAllocating(() => reflectDiagonal(tall, { plane: 'xy', maxCells: 5 }));
  const square = grid([2, 2, 1], [1, 2, 3, 4]);
  for (const options of [
    { plane: 'xx' },
    { plane: 'xy', diagonal: 'x' },
    { plane: 'xy', mode: 'x' },
    { plane: 'xy', keep: 'x' },
  ])
    assert.throws(() => reflectDiagonal(square, options), TypeError);
});

test('wrapGrid moves cells through opposite sides; any whole offset works', () => {
  const source = grid([2, 2, 2], [1, 2, 3, 4, 5, 6, 7, 8]),
    r = wrapGrid(source, { offset: [1, -1, 3] });
  assert.deepEqual([...r.grid.voxels], [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual([...source.voxels], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...wrapGrid(line([3, 0, 7]), { offset: [-1000000, 0, 0] }).grid.voxels], [0, 7, 3]);
  assert.throws(() => wrapGrid(source, { offset: [0.5, 0, 0] }), RangeError);
});

test('repeatGrid tiles whole grids; changed counts the new filled cells', () => {
  const r = repeatGrid(grid([2, 1, 2], [3, 0, 7, 9]), { counts: [2, 2, 1] });
  assert.deepEqual(r.grid.size, [4, 2, 2]);
  assert.deepEqual([...r.grid.voxels], [3, 0, 3, 0, 7, 9, 7, 9, 3, 0, 3, 0, 7, 9, 7, 9]);
  assert.equal(r.changed, 9);
  assert.throws(() => repeatGrid(line([1]), { counts: [0, 1, 1] }), RangeError);
  assert.throws(() => repeatGrid(line([1]), { counts: [1.5, 1, 1] }), RangeError);
  const cube = grid([2, 2, 2], new Array(8).fill(1));
  throwsBeforeAllocating(() => repeatGrid(cube, { counts: [2, 1, 1], maxCells: 15 }));
});

test('resampleGrid samples the nearest cell at each new centre, growing or shrinking', () => {
  assert.deepEqual([...resampleGrid(line([3, 0, 7]), { scale: [2, 1, 1] }).grid.voxels], [3, 3, 0, 0, 7, 7]);
  assert.deepEqual([...resampleGrid(line([1, 2, 3, 4]), { scale: [0.5, 1, 1] }).grid.voxels], [2, 4]);
  const tiny = resampleGrid(line([1, 2, 3]), { scale: [0.01, 1, 1] });
  assert.deepEqual(tiny.grid.size, [1, 1, 1]);
  assert.deepEqual([...tiny.grid.voxels], [2]);
  assert.deepEqual([...resampleGrid(line([3, 7]), { scale: [1.5, 1, 1] }).grid.voxels], [3, 7, 7]);
  for (const scale of [
    [Infinity, 1, 1],
    [-1, 1, 1],
    [0, 1, 1],
  ])
    assert.throws(() => resampleGrid(line([1]), { scale }), RangeError);
});

test('rotateGrid turns right-handed about the centre inside the box and counts what leaves it', () => {
  const source = grid([3, 1, 3], [0, 0, 0, 0, 7, 3, 0, 0, 0]);
  assert.deepEqual([...rotateGrid(source, { axis: 'y', degrees: 90 }).grid.voxels], [0, 3, 0, 0, 7, 0, 0, 0, 0]);
  assert.deepEqual([...rotateGrid(source, { axis: 'y', degrees: 45 }).grid.voxels], [0, 0, 3, 0, 7, 0, 0, 0, 0]);
  assert.deepEqual([...rotateGrid(source, { axis: 'y', degrees: 360 }).grid.voxels], [...source.voxels]);
  const turned = rotateGrid(line([1, 2, 3]), { axis: 'z', degrees: 90 });
  assert.deepEqual([...turned.grid.voxels], [0, 2, 0]);
  assert.equal(turned.clipped, 2);
  assert.throws(() => rotateGrid(source, { axis: 3, degrees: 45 }), TypeError);
  assert.throws(() => rotateGrid(source, { axis: 'y', degrees: Infinity }), RangeError);
});

test('dilateGrid grows from the previous pass only; added cells take color or their source index', () => {
  const source = line([3, 0, 0, 0]),
    right = [[1, 0, 0]];
  assert.deepEqual([...dilateGrid(source, { directions: right, color: 7 }).grid.voxels], [3, 7, 0, 0]);
  assert.deepEqual([...dilateGrid(source, { directions: right, iterations: 2, color: 7 }).grid.voxels], [3, 7, 7, 0]);
  assert.deepEqual([...dilateGrid(source, { directions: right, iterations: 2 }).grid.voxels], [3, 3, 3, 0]);
  assert.deepEqual(
    [
      ...dilateGrid(line([0, 3, 0]), {
        directions: [
          [-1, 0, 0],
          [1, 0, 0],
        ],
        color: 9,
      }).grid.voxels,
    ],
    [9, 3, 9],
  );
  assert.deepEqual([...source.voxels], [3, 0, 0, 0]);
});

test('erodeGrid empties cells with air (or the edge) along a direction', () => {
  const right = [[1, 0, 0]];
  assert.deepEqual([...erodeGrid(line([3, 7, 9, 4]), { directions: right }).grid.voxels], [3, 7, 9, 0]);
  assert.deepEqual([...erodeGrid(line([3, 7, 9, 4]), { directions: right, iterations: 2 }).grid.voxels], [3, 7, 0, 0]);
  assert.deepEqual(
    [
      ...erodeGrid(line([3, 7, 9, 4]), {
        directions: [
          [-1, 0, 0],
          [1, 0, 0],
        ],
      }).grid.voxels,
    ],
    [0, 7, 9, 0],
  );
  assert.deepEqual([...erodeGrid(line([3, 0, 7]), { directions: right }).grid.voxels], [0, 0, 0]);
  assert.deepEqual([...erodeGrid(line([3, 7, 9])).grid.voxels], [0, 0, 0]);
});

test('morphology never wraps across rows or planes, and zero passes return an independent copy', () => {
  const source = grid([2, 2, 2], [0, 3, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    [...dilateGrid(source, { directions: [[1, 0, 0]], color: 7 }).grid.voxels],
    [0, 3, 0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    [...dilateGrid(source, { directions: [[0, 1, 0]], color: 7 }).grid.voxels],
    [0, 3, 0, 0, 0, 7, 0, 0],
  );
  assert.deepEqual(
    [...dilateGrid(source, { directions: [[0, 0, 1]], color: 7 }).grid.voxels],
    [0, 3, 0, 7, 0, 0, 0, 0],
  );
  const copy = erodeGrid(source, { iterations: 0 }).grid;
  copy.voxels[1] = 9;
  assert.equal(source.voxels[1], 3);
  for (const options of [{ directions: [[1, 1, 0]] }, { directions: [] }, { iterations: -1 }, { iterations: 1.5 }])
    assert.throws(() => erodeGrid(source, options));
  assert.throws(() => dilateGrid(source, { color: 0 }), RangeError);
  const slab = { size: [256, 256, 8], voxels: new Uint8Array(524288) };
  assert.throws(() => erodeGrid(slab, { iterations: 1024, directions: [[1, 0, 0]] }), /work exceeds/);
});

test('fillEnclosed fills only air cut off from the boundary (face-connected) and keeps filled indexes', () => {
  const size = [5, 3, 3],
    voxels = new Uint8Array(45).fill(3);
  voxels[cellIndex(size, 1, 1, 1)] = 0;
  voxels[cellIndex(size, 3, 1, 1)] = 0;
  voxels[cellIndex(size, 4, 1, 1)] = 0;
  voxels[0] = 7;
  const r = fillEnclosed({ size, voxels }, { color: 9 });
  assert.equal(r.grid.voxels[cellIndex(size, 1, 1, 1)], 9);
  assert.equal(r.grid.voxels[cellIndex(size, 3, 1, 1)], 0);
  assert.equal(r.grid.voxels[0], 7);
  assert.equal(r.changed, 1);
  assert.equal(voxels[cellIndex(size, 1, 1, 1)], 0);
  const corner = { size: [3, 3, 3], voxels: new Uint8Array(27).fill(3) };
  corner.voxels[0] = 0;
  corner.voxels[13] = 0;
  const filled = fillEnclosed(corner, { color: 9 }).grid;
  assert.equal(filled.voxels[0], 0);
  assert.equal(filled.voxels[13], 9, 'diagonal corner contact does not connect air');
  assert.throws(() => fillEnclosed(corner, { color: 0 }), RangeError);
});

test('mergePalettes reuses equal identities, keeps base entries and refuses overflow', () => {
  const baseKeys = Array.from({ length: 256 }, (_, i) => `base${i}`),
    toolKeys = Array.from({ length: 256 }, (_, i) => `tool${i}`);
  baseKeys[2] = 'red|metal';
  toolKeys[7] = 'red|metal';
  toolKeys[8] = 'red|glass';
  toolKeys[9] = 'red|glass';
  const r = mergePalettes({ baseKeys, toolKeys, baseUsed: palette([2, 1]), toolUsed: palette([7, 1], [8, 1], [9, 1]) });
  assert.deepEqual([r.paletteMap[0], r.paletteMap[7], r.paletteMap[8], r.paletteMap[9]], [0, 2, 1, 1]);
  assert.deepEqual(r.assignments, [
    { from: 7, to: 2 },
    { from: 8, to: 1 },
    { from: 9, to: 1 },
  ]);
  const full = new Uint8Array(256).fill(1);
  full[0] = 0;
  assert.throws(() => mergePalettes({ baseKeys, toolKeys, baseUsed: full, toolUsed: palette([1, 1]) }), /0 are free/);
  assert.throws(() => mergePalettes({ baseKeys: [], toolKeys, baseUsed: full, toolUsed: palette([1, 1]) }), TypeError);
});

test('generateMaze builds an exact floor and walls for one room', () => {
  const r = generateMaze(Object.freeze({ columns: 1, rows: 1, wallHeight: 2, wallIndex: 7, floorIndex: 2, seed: 17 }));
  assert.deepEqual(r.grid.size, [3, 3, 3]);
  assert.deepEqual(
    [...r.grid.voxels],
    [2, 2, 2, 2, 2, 2, 2, 2, 2, 7, 0, 7, 7, 0, 7, 7, 0, 7, 7, 0, 7, 7, 0, 7, 7, 0, 7],
  );
  assert.deepEqual([r.rooms, r.passages, r.seed], [1, 0, 17]);
});

test('generateMaze repeats per seed and links every room by exactly one path', () => {
  const options = { columns: 5, rows: 4, wallHeight: 2, wallIndex: 9, seed: 42, openings: false },
    a = generateMaze(options).grid,
    b = generateMaze(options).grid;
  assert.deepEqual(a.voxels, b.voxels);
  assert.notDeepEqual(a.voxels, generateMaze({ ...options, seed: 43 }).grid.voxels);
  const [sx, , sz] = a.size,
    open = (x, z) => !a.voxels[x + sx * z],
    seen = new Set([0]),
    queue = [0];
  let links = 0;
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 5; col++) {
      assert.ok(open(2 * col + 1, 2 * row + 1));
      if (col < 4 && open(2 * col + 2, 2 * row + 1)) links++;
      if (row < 3 && open(2 * col + 1, 2 * row + 2)) links++;
    }
  for (let i = 0; i < queue.length; i++) {
    const col = queue[i] % 5,
      row = Math.floor(queue[i] / 5);
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = col + dx,
        z = row + dz;
      if (x < 0 || x >= 5 || z < 0 || z >= 4 || !open(2 * col + 1 + dx, 2 * row + 1 + dz) || seen.has(x + 5 * z))
        continue;
      seen.add(x + 5 * z);
      queue.push(x + 5 * z);
    }
  }
  assert.equal(seen.size, 20);
  assert.equal(links, 19);
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      if (x === 0 || z === 0 || x === sx - 1 || z === sz - 1) assert.equal(a.voxels[x + sx * z], 9);
      assert.equal(a.voxels[x + sx * z], a.voxels[x + sx * (z + sz)], 'walls are extruded');
    }
});

test('generateMaze checks every option before allocating', () => {
  const options = { columns: 2, rows: 2, wallHeight: 2, wallIndex: 1 };
  for (const patch of [
    { maxCells: 49 },
    { columns: Number.MAX_SAFE_INTEGER },
    { wallHeight: 0 },
    { wallIndex: 0 },
    { floorIndex: 256 },
    { seed: 0.5 },
  ])
    throwsBeforeAllocating(() => generateMaze({ ...options, ...patch }));
  assert.throws(() => generateMaze({ ...options, openings: 'yes' }), TypeError);
});
