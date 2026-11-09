import test from 'node:test';
import assert from 'node:assert/strict';
import { ConstrainedWFC } from '../dist/constraints.js';
const tiles = [0, 1].map(() => ({ neighbors: Array.from({ length: 6 }, () => [0, 1]) }));
function reachable(out, from, to) {
  if (out[from] !== 1 || out[to] !== 1) return false;
  const seen = new Set([from]),
    queue = [from];
  for (const i of queue)
    for (const j of [i % 3 > 0 ? i - 1 : -1, i % 3 < 2 ? i + 1 : -1, i >= 3 ? i - 3 : -1, i < 3 ? i + 3 : -1])
      if (j >= 0 && out[j] === 1 && !seen.has(j)) {
        seen.add(j);
        queue.push(j);
      }
  return seen.has(to);
}
function valid(out, min, max, connected, path) {
  const indices = [...out.keys()].filter((i) => out[i] === 1),
    n = indices.length;
  return (
    n >= min &&
    n <= max &&
    (!connected || (n > 0 && indices.every((i) => reachable(out, indices[0], i)))) &&
    (!path || reachable(out, 0, 5))
  );
}
test('count propagation, possible-connectivity pruning and paths agree with exhaustive small-grid truth', () => {
  for (let min = 0; min <= 6; min++)
    for (let max = min; max <= 6; max++)
      for (const connected of [false, true])
        for (const path of [false, true]) {
          const constraints = {
            counts: [{ tiles: [1], min, max }],
            ...(connected ? { connected: [1] } : {}),
            ...(path ? { paths: [{ from: [0, 0, 0], to: [2, 1, 0], tiles: [1] }] } : {}),
          };
          let witness;
          for (let mask = 0; mask < 64; mask++) {
            const out = Array.from({ length: 6 }, (_, i) => (mask >> i) & 1);
            if (valid(out, min, max, connected, path)) {
              witness = out;
              break;
            }
          }
          const model = new ConstrainedWFC([3, 2, 1], tiles, constraints);
          if (witness) {
            const out = model.solve({ seed: 7, attempts: 1 });
            assert.ok(valid([...out], min, max, connected, path), JSON.stringify({ out: [...out], constraints }));
            assert.deepEqual(model.solve({ seed: 7, attempts: 1 }), out);
          } else
            assert.throws(
              () => model.solve({ seed: 7, attempts: 1 }),
              (e) => e.code === 'failed' && /https:/.test(e.message),
            );
        }
});
test('global search backtracks rather than accepting an invalid locally valid layout', () => {
  const m = new ConstrainedWFC([5, 4, 1], tiles, {
    counts: [{ tiles: [1], min: 8, max: 8 }],
    connected: [1],
    paths: [{ from: [0, 0, 0], to: [4, 3, 0], tiles: [1] }],
  });
  let backtracks = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const out = m.solve({ seed, attempts: 1 });
    backtracks += m.stats.backtracks;
    assert.equal([...out].filter((t) => t === 1).length, 8);
    assert.equal(out[0], 1);
    assert.equal(out[19], 1);
  }
  assert.ok(backtracks > 0, 'fixture must exercise undo of global pruning');
});
test('six-direction 3D paths, overlapping tile groups, pins, copied inputs and wide IDs', () => {
  const all = [0, 1, 2],
    defs = all.map(() => ({ neighbors: Array.from({ length: 6 }, () => all) }));
  const config = {
    paths: [{ from: [0, 0, 0], to: [1, 1, 1], tiles: [1, 2] }],
    connected: [1, 2],
    counts: [
      { tiles: [1, 2], min: 4, max: 4 },
      { tiles: [2], min: 2, max: 2 },
    ],
  };
  const m = new ConstrainedWFC([2, 2, 2], defs, config);
  config.connected[0] = 0;
  config.counts[0].min = 8;
  defs[0].neighbors[0] = [];
  const out = m.solve({ seed: 2, pins: [{ position: [0, 0, 0], tile: 2 }] });
  assert.equal(out[0], 2);
  assert.equal([...out].filter((t) => t > 0).length, 4);
  assert.equal([...out].filter((t) => t === 2).length, 2);
  const wide = Array.from({ length: 257 }, (_, t) => ({ neighbors: Array.from({ length: 6 }, () => [t]) }));
  assert.deepEqual(
    [...new ConstrainedWFC([2, 1, 1], wide).solve({ pins: [{ position: [0, 0, 0], tile: 256 }] })],
    [256, 256],
  );
});
test('invalid groups, bounds, dimensions and cancellation fail before search', () => {
  for (const constraints of [
    { connected: [] },
    { connected: [2] },
    { counts: [{ tiles: [1, 1] }] },
    { counts: [{ tiles: [1], min: 2, max: 1 }] },
    { paths: [{ from: [3, 0, 0], to: [0, 0, 0], tiles: [1] }] },
  ])
    assert.throws(() => new ConstrainedWFC([3, 2, 1], tiles, constraints), RangeError);
  const m = new ConstrainedWFC([3, 2, 1], tiles);
  for (const options of [
    { seed: 1.5 },
    { attempts: 0 },
    { backtracks: -1 },
    { pins: [{ position: [3, 0, 0], tile: 1 }] },
    { pins: [{ position: [0, 0, 0], tile: 2 }] },
  ])
    assert.throws(() => m.solve(options), RangeError);
  assert.throws(
    () => new ConstrainedWFC([2, 2, 1], [{ weight: 1e308, neighbors: Array.from({ length: 6 }, () => [0]) }]),
    RangeError,
  );
  const c = new AbortController();
  c.abort();
  assert.throws(() => m.solve({ signal: c.signal }), { name: 'AbortError' });
  assert.throws(
    () =>
      m.solve({
        pins: [
          { position: [0, 0, 0], tile: 0 },
          { position: [0, 0, 0], tile: 1 },
        ],
        attempts: 1,
      }),
    (e) => e.code === 'failed',
  );
});

test('local adjacency and global constraints must both hold, including contradictory connected checkerboards', () => {
  const checker = [0, 1].map((t) => ({ neighbors: Array.from({ length: 6 }, () => [1 - t]) }));
  const m = new ConstrainedWFC([3, 2, 1], checker, { counts: [{ tiles: [1], min: 3, max: 3 }] });
  assert.deepEqual([...m.solve({ pins: [{ position: [0, 0, 0], tile: 0 }] })], [0, 1, 0, 1, 0, 1]);
  assert.throws(
    () => new ConstrainedWFC([2, 2, 2], checker, { connected: [1] }).solve({ attempts: 1 }),
    (e) => e.code === 'failed',
  );
  assert.throws(
    () =>
      new ConstrainedWFC(
        [2, 1, 1],
        [{ neighbors: Array.from({ length: 6 }, () => [1]) }, { neighbors: Array.from({ length: 6 }, () => [1]) }],
      ),
    /reciprocal/,
  );
});
