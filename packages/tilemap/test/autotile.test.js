import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOB_MASKS,
  autotile,
  autotileGrid,
  blobIndex,
  blobMask,
  cardinalMask,
  resolveTerrain,
  verticesFromCells,
} from '../dist/autotile.js';
import { createTileLayer } from '../dist/index.js';

// The 47 blob cases, written out by hand. Bits: N 1, NE 2, E 4, SE 8, S 16, SW 32, W 64, NW 128.
const BLOB_TABLE = [
  0, 1, 4, 5, 7, 16, 17, 20, 21, 23, 28, 29, 31, 64, 65, 68, 69, 71, 80, 81, 84, 85, 87, 92, 93, 95, 112, 113, 116, 117,
  119, 124, 125, 127, 193, 197, 199, 209, 213, 215, 221, 223, 241, 245, 247, 253, 255,
];

test('the blob set is the 47 hand-written masks, ascending', () => {
  assert.equal(BLOB_TABLE.length, 47);
  assert.deepEqual([...BLOB_MASKS], BLOB_TABLE);
});

test('every raw 8-neighbour case reduces to one of the 47, dropping corners without both edges', () => {
  const kept = new Set(BLOB_TABLE);
  for (let raw = 0; raw < 256; raw++) {
    const bit = (n) => (raw >> n) & 1;
    const [N, NE, E, SE, S, SW, W, NW] = [0, 1, 2, 3, 4, 5, 6, 7].map(bit);
    const expected =
      N * 1 +
      (NE && N && E ? 2 : 0) +
      E * 4 +
      (SE && E && S ? 8 : 0) +
      S * 16 +
      (SW && S && W ? 32 : 0) +
      W * 64 +
      (NW && W && N ? 128 : 0);
    const got = blobMask(N, NE, E, SE, S, SW, W, NW);
    assert.equal(got, expected, `raw ${raw}`);
    assert.ok(kept.has(got), `raw ${raw} gave ${got}`);
    assert.equal(BLOB_TABLE[blobIndex(got)], got);
  }
});

test('blobIndex throws for a mask that is not reduced', () => {
  assert.throws(() => blobIndex(2), RangeError);
  assert.throws(() => blobIndex(256), /blobMask/);
});

test('all 16 cardinal cases give N 1, E 2, S 4, W 8', () => {
  for (let m = 0; m < 16; m++) assert.equal(cardinalMask(m & 1, m & 2, m & 4, m & 8), m);
});

test('cardinal auto-tiling: a plus shape, edges count as empty', () => {
  // . X .
  // X X X
  // . X .
  const filled = [0, 1, 0, 1, 1, 1, 0, 1, 0];
  const tiles = Array.from({ length: 16 }, (_, i) => 100 + i);
  const got = autotileGrid(filled, 3, 3, { mode: 'cardinal', tiles }, { firstGid: 1 });
  // top: only S (4); left: only E (2); centre: all (15); right: only W (8); bottom: only N (1)
  assert.deepEqual([...got], [0, 101 + 4, 0, 101 + 2, 101 + 15, 101 + 8, 0, 101 + 1, 0]);
});

test('outside: true treats the map edge as filled', () => {
  const tiles = Array.from({ length: 16 }, (_, i) => i);
  const got = autotileGrid([1], 1, 1, { mode: 'cardinal', tiles }, { firstGid: 0, outside: true });
  assert.equal(got[0], 15);
  const none = autotileGrid([1], 1, 1, { mode: 'cardinal', tiles }, { firstGid: 0 });
  assert.equal(none[0], 0);
});

test('blob auto-tiling: a 3x3 block gives centre 255, edges and corners as hand-checked', () => {
  const tiles = Array.from({ length: 47 }, (_, i) => i);
  const got = autotileGrid(new Array(9).fill(1), 3, 3, { mode: 'blob', tiles }, { firstGid: 0 });
  const mask = (x, y) => BLOB_TABLE[got[y * 3 + x]];
  assert.equal(mask(1, 1), 255);
  assert.equal(mask(0, 0), 4 + 8 + 16); // E, SE, S
  assert.equal(mask(1, 0), 4 + 8 + 16 + 32 + 64); // E, SE, S, SW, W
  assert.equal(mask(2, 0), 16 + 32 + 64); // S, SW, W
  assert.equal(mask(0, 1), 1 + 2 + 4 + 8 + 16); // N, NE, E, SE, S
  assert.equal(mask(2, 2), 64 + 128 + 1); // W, NW, N
});

test('a lone cell and an inner corner pick the right blob tile', () => {
  const tiles = Array.from({ length: 47 }, (_, i) => i);
  const rules = { mode: 'blob', tiles };
  assert.equal(BLOB_TABLE[autotileGrid([1], 1, 1, rules, { firstGid: 0 })[0]], 0);
  // 3x3 with the NW cell empty: the centre sees everything but its NW corner.
  const got = autotileGrid([0, 1, 1, 1, 1, 1, 1, 1, 1], 3, 3, rules, { firstGid: 0 });
  assert.equal(BLOB_TABLE[got[4]], 255 - 128);
});

test('rule sets are checked and the result is deterministic', () => {
  assert.throws(() => autotileGrid([1], 1, 1, { mode: 'blob', tiles: [0] }), /needs 47 tiles/);
  assert.throws(() => autotileGrid([1], 1, 1, { mode: 'nope', tiles: [] }), TypeError);
  assert.throws(() => autotileGrid([1, 1], 1, 1, { mode: 'cardinal', tiles: new Array(16).fill(0) }), RangeError);
  const tiles = Array.from({ length: 47 }, (_, i) => i);
  const grid = Array.from({ length: 64 }, (_, i) => ((i * 7) % 3 === 0 ? 1 : 0));
  const a = autotileGrid(grid, 8, 8, { mode: 'blob', tiles });
  const b = autotileGrid(grid, 8, 8, { mode: 'blob', tiles });
  assert.deepEqual(a, b);
});

test('autotile(layer) retiles matching cells, keeps the rest and returns a new layer', () => {
  const layer = createTileLayer('ground', 2, 1, new Uint32Array([9, 5]));
  const tiles = Array.from({ length: 16 }, (_, i) => i);
  const out = autotile(layer, { mode: 'cardinal', tiles }, { firstGid: 10, matches: (v) => v === 9 });
  assert.deepEqual([...out.data], [10 + 0, 5]);
  assert.deepEqual([...layer.data], [9, 5]);
  assert.equal(out.name, 'ground');
  const any = autotile(layer, { mode: 'cardinal', tiles }, { firstGid: 10 });
  assert.deepEqual([...any.data], [10 + 2, 10 + 8]);
});

test('terrain: corners pick the tile, empty corners match terrain 0', () => {
  const set = {
    tiles: [
      { tile: 0, corners: [0, 0, 0, 0] },
      { tile: 1, corners: [1, 1, 1, 1] },
      { tile: 2, corners: [0, 1, 1, 0] },
      { tile: 3, corners: [1, 0, 0, 1] },
    ],
  };
  // 2x1 cells, vertices 3x2: left half grass at the left column of vertices.
  const vertices = [1, 1, 0, 1, 1, 0];
  const got = resolveTerrain(vertices, 2, 1, set, { firstGid: 1 });
  assert.deepEqual([...got], [1 + 1, 1 + 3]);
  assert.deepEqual([...resolveTerrain([0, 1, 0, 1], 1, 1, set, { firstGid: 1 })], [3]);
});

test('terrain: no match leaves 0, multiple matches are weighted, seeded and deterministic', () => {
  const set = {
    tiles: [
      { tile: 4, corners: [1, 1, 1, 1], weight: 1 },
      { tile: 5, corners: [1, 1, 1, 1], weight: 3 },
    ],
  };
  const w = 40;
  const vertices = new Array((w + 1) * 2).fill(1);
  const a = resolveTerrain(vertices, w, 1, set, { firstGid: 0, seed: 7 });
  assert.deepEqual(a, resolveTerrain(vertices, w, 1, set, { firstGid: 0, seed: 7 }));
  assert.notDeepEqual(a, resolveTerrain(vertices, w, 1, set, { firstGid: 0, seed: 8 }));
  const fives = [...a].filter((v) => v === 5).length;
  assert.ok([...a].every((v) => v === 4 || v === 5));
  assert.ok(fives > w / 2, `weight 3 should win most of ${w}, got ${fives}`);
  assert.deepEqual([...resolveTerrain([2, 2, 2, 2], 1, 1, set)], [0]);
  assert.throws(() => resolveTerrain([1, 1], 1, 1, set), /\(width \+ 1\) \* \(height \+ 1\)/);
});

test('verticesFromCells: a corner takes the highest terrain touching it', () => {
  // 2x1 cells: [1, 0]
  const v = verticesFromCells([1, 0], 2, 1);
  assert.deepEqual([...v], [1, 1, 0, 1, 1, 0]);
  const two = verticesFromCells([1, 2], 2, 1);
  assert.deepEqual([...two], [1, 2, 2, 1, 2, 2]);
  assert.throws(() => verticesFromCells([1], 2, 1), RangeError);
});
