import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WFC } from '../dist/index.js';
import { HeapWFC } from '../dist/chunks.js';

const all = (n) => Array.from({ length: n }, (_, i) => i);
// Every tile may sit beside every tile: full domains restrict nothing.
const open = (n, weight = (t) => 1 + t) =>
  Array.from({ length: n }, (_, t) => ({ weight: weight(t), neighbors: Array.from({ length: 6 }, () => all(n)) }));
// Neighbouring tiles along X differ by at most one; Y and Z are free, so pins and decisions propagate.
const band = (n) =>
  Array.from({ length: n }, (_, t) => ({
    weight: 1 + (t % 3),
    neighbors: Array.from({ length: 6 }, (_, d) => (d < 2 ? all(n).filter((u) => Math.abs(u - t) <= 1) : all(n))),
  }));
// The last tile has no X neighbour at all, so a full domain does restrict its X neighbours.
const narrow = (n) =>
  Array.from({ length: n }, (_, t) => ({
    weight: 2,
    neighbors: Array.from({ length: 6 }, (_, d) => (d >= 2 ? all(n) : t === n - 1 ? [] : all(n - 1))),
  }));
const cases = [
  [[16, 16, 1], open(8)],
  [[12, 6, 2], band(6)],
  [[10, 10, 1], narrow(5)],
  [[9, 7, 3], band(40)],
  [[20, 20, 1], open(33, () => 1)],
];
const pinsFor = ([w, h, d], n) => [
  { position: [0, 0, 0], tile: n - 1 },
  { position: [w - 1, h - 1, d - 1], tile: 0 },
];

function clzCalls(run) {
  const clz = Math.clz32;
  let calls = 0;
  Math.clz32 = (x) => {
    calls++;
    return clz(x);
  };
  try {
    run();
  } finally {
    Math.clz32 = clz;
  }
  return calls;
}

test('full domains reuse their precomputed support instead of walking every tile', () => {
  const heap = new HeapWFC([16, 16, 1], open(8)),
    legacy = new WFC([16, 16, 1], open(8));
  // Parents: 6656 and 4608 bit scans; 2048 of each walked the eight tiles of a full domain.
  assert.deepEqual([clzCalls(() => heap.solve({ seed: 3 })), clzCalls(() => legacy.solve(3))], [4608, 512]);
});

test('solutions and solver statistics keep the parent bytes', () => {
  const digest = createHash('sha256');
  for (const [dims, tiles] of cases)
    for (const seed of [1, 7, 99]) {
      const heap = new HeapWFC(dims, tiles);
      for (const pins of [[], pinsFor(dims, tiles.length)]) {
        let out;
        try {
          out = heap.solve({ seed, pins, attempts: 3 });
        } catch (error) {
          out = String(error.code);
        }
        digest.update(JSON.stringify([out instanceof Uint16Array ? Array.from(out) : out, heap.stats]));
      }
      if (tiles.length <= 32) {
        const legacy = new WFC(dims, tiles);
        let out;
        try {
          out = Array.from(legacy.solve(seed, pinsFor(dims, tiles.length), 3));
        } catch (error) {
          out = String(error.code);
        }
        digest.update(JSON.stringify(out));
      }
    }
  assert.equal(digest.digest('hex'), '227a189efccb94eeeae817d4681ec68a705aa058211dc6cd02a62ef31324c37e');
});
