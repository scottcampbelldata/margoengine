// Proof for @margoengine/wfc: propagation gathers all six neighbor masks in one pass over the set tiles, and the
// entropy scan reuses each cell's pre-jitter entropy until its mask changes. Seeded results must not move.
// Run: node examples/package-benchmarks/proofs/wfc.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/wfc.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import { refs, versions, time, record } from './compare.js';

const { ref, pin } = refs('f05414a', 'f47ff3f'),
  { baseline, candidate } = await versions('wfc', ref, undefined, pin);
// Height-level tiles: a tile may sit next to itself or one level up/down. `vertical` false keeps columns uniform,
// which is the tile set of the package benchmark demo (examples/package-benchmarks/wfc.js).
const levels = (weights, vertical) =>
  weights.map((weight, id) => ({
    weight,
    neighbors: Array.from({ length: 6 }, (_, direction) =>
      weights
        .map((_, other) => other)
        .filter((other) =>
          !vertical && (direction === 2 || direction === 3) ? other === id : Math.abs(other - id) <= 1,
        ),
    ),
  }));
const outcome = (module, dimensions, tiles, seed, pins, attempts) => {
  try {
    return [...new module.WFC(dimensions, tiles).solve(seed, pins, attempts)];
  } catch (error) {
    return `${error.constructor.name}: ${error.message}`;
  }
};
// Edge cases from packages/wfc/test: parity pins on a 3D checkerboard, a contradiction, non-reciprocal tiles, weights.
const only = (tile) => Array.from({ length: 6 }, () => [tile]),
  checker = [{ neighbors: only(1) }, { neighbors: only(0) }];
for (const [dimensions, tiles, seed, pins, attempts] of [
  [[5, 4, 3], checker, 123, [{ position: [0, 0, 0], tile: 0 }], 16],
  [
    [5, 4, 3],
    checker,
    1,
    [
      { position: [0, 0, 0], tile: 0 },
      { position: [1, 0, 0], tile: 0 },
    ],
    1,
  ],
  [[1, 1, 1], [{ neighbors: only(1) }], 1, [], 16],
  [
    [4, 2, 1],
    levels([1, 2, 4], true).map((tile) => ({ ...tile, neighbors: only(0).map(() => [0, 1, 2]) })),
    123,
    [],
    16,
  ],
  [[3, 3, 3], levels([1, 1], true), 7, [{ position: [3, 0, 0], tile: 0 }], 16],
  [
    [6, 6, 6],
    levels(
      Array.from({ length: 31 }, (_, i) => 1 + (i % 5)),
      true,
    ),
    99,
    [
      { position: [0, 0, 0], tile: 30 },
      { position: [5, 5, 5], tile: 0 },
    ],
    64,
  ],
])
  assert.deepEqual(
    outcome(candidate, dimensions, tiles, seed, pins, attempts),
    outcome(baseline, dimensions, tiles, seed, pins, attempts),
  );

const cases = [];
for (const [name, dimensions, tiles, pins, attempts, solves] of [
  // The demo's largest preset: a 32 x 32 single-layer map with four weighted height levels and two pinned corners.
  [
    '32x1x32 map, 4 tiles',
    [32, 1, 32],
    levels([1, 4, 2, 1], false),
    [
      { position: [0, 0, 0], tile: 0 },
      { position: [31, 0, 31], tile: 3 },
    ],
    8,
    6,
  ],
  // A dungeon-sized map with a larger tile vocabulary.
  [
    '48x1x48 map, 12 tiles',
    [48, 1, 48],
    levels([1, 4, 2, 1, 3, 2, 1, 5, 2, 1, 3, 1], false),
    [{ position: [0, 0, 0], tile: 0 }],
    16,
    3,
  ],
  // A small voxel chunk with full 3D adjacency.
  [
    '16x8x16 volume, 8 tiles',
    [16, 8, 16],
    levels([1, 4, 2, 1, 3, 2, 1, 5], true),
    [
      { position: [0, 0, 0], tile: 0 },
      { position: [15, 7, 15], tile: 7 },
    ],
    16,
    2,
  ],
]) {
  const a = new baseline.WFC(dimensions, tiles),
    b = new candidate.WFC(dimensions, tiles);
  // The same generator is reused across seeds, as an app regenerating a level does.
  for (let seed = 1; seed <= 12; seed++) assert.deepEqual(b.solve(seed, pins, attempts), a.solve(seed, pins, attempts));
  cases.push({
    case: name,
    solves,
    ...time(
      () => {
        for (let seed = 100; seed < 100 + solves; seed++) a.solve(seed, pins, attempts);
      },
      () => {
        for (let seed = 100; seed < 100 + solves; seed++) b.solve(seed, pins, attempts);
      },
    ),
  });
}
await record(
  'wfc',
  ref,
  cases,
  'Seeded solutions are byte-identical; the random stream is consumed in the same order.',
  pin,
);
