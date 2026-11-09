import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HeapWFC, ChunkedWFC } from '../dist/chunks.js';
import { ConstrainedWFC } from '../dist/constraints.js';
const open = (n) =>
  Array.from({ length: n }, () => ({
    neighbors: Array.from({ length: 6 }, () => Array.from({ length: n }, (_, i) => i)),
  }));
const checker = [0, 1].map((t) => ({ neighbors: Array.from({ length: 6 }, () => [t ^ 1]) }));
const hash = (b) => createHash('sha256').update(b).digest('hex');

test('SIMD artifact matches its own Rust source and has SIMD instructions', () => {
  const record = JSON.parse(readFileSync(new URL('../native/solver/artifact.json', import.meta.url)));
  const wasm = readFileSync(new URL('../src/wfc.wasm', import.meta.url));
  assert.equal(hash(wasm), record.wasm);
  assert.equal(wasm.length, record.bytes);
  assert.equal(
    hash(readFileSync(new URL('../native/solver/src/lib.rs', import.meta.url), 'utf8').replaceAll('\r\n', '\n')),
    record.source,
  );
  assert.equal(
    hash(readFileSync(new URL('../native/solver/Cargo.toml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')),
    record.manifest,
  );
  assert.ok(WebAssembly.validate(wasm));
  assert.ok(wasm.includes(0xfd));
});
test('installed relative Wasm asset loads in Node; TS and actual SIMD solver reproduce decisions and propagation', async () => {
  for (const tiles of [open(2), open(32), checker])
    for (const dims of [
      [9, 8, 1],
      [4, 3, 2],
    ]) {
      const js = new HeapWFC(dims, tiles),
        rs = await HeapWFC.create(dims, tiles, { backend: 'wasm' });
      assert.equal(rs.backend, 'wasm');
      for (const seed of [0, -1, 4294967296, ...Array.from({ length: 12 }, (_, i) => i + 1)]) {
        const options = { seed, pins: [{ position: [0, 0, 0], tile: tiles.length - 1 }] };
        const a = js.solve(options),
          b = rs.solve(options);
        assert.deepEqual(b, a, JSON.stringify({ dims, seed, T: tiles.length }));
        assert.deepEqual(rs.stats, js.stats);
      }
    }
});
test('reciprocal validation reads adjacency linearly instead of rescanning opposite lists per edge', () => {
  const n = 64,
    budget = 6 * n * n * 4;
  let reads = 0;
  const tiles = open(n).map((t) => ({
    neighbors: t.neighbors.map(
      (list) =>
        new Proxy(list, {
          get(target, key) {
            if (typeof key === 'string' && /^\d+$/.test(key) && ++reads > budget)
              throw new Error('Reciprocal validation exceeded linear adjacency work');
            return Reflect.get(target, key);
          },
        }),
    ),
  }));
  new ConstrainedWFC([1, 1, 1], tiles);
  assert.ok(reads <= budget);
});
test('heap validates adjacency with exhaustive small binary constraints and parity in both implementations', async () => {
  // Every symmetric binary relation, with or without loops, on a 3-cell chain.
  for (let mask = 0; mask < 8; mask++) {
    const relation = [[], []];
    if (mask & 1) relation[0].push(0);
    if (mask & 2) {
      relation[0].push(1);
      relation[1].push(0);
    }
    if (mask & 4) relation[1].push(1);
    const tiles = relation.map((r) => ({ neighbors: [r, r, [0, 1], [0, 1], [0, 1], [0, 1]] }));
    const js = new HeapWFC([3, 1, 1], tiles),
      rs = await HeapWFC.create([3, 1, 1], tiles);
    for (let pins = 0; pins < 4; pins++) {
      const options = {
        seed: 5,
        attempts: 8,
        pins: [
          { position: [0, 0, 0], tile: pins & 1 },
          { position: [2, 0, 0], tile: pins >>> 1 },
        ],
      };
      const possible = [0, 1].some((t) => relation[pins & 1].includes(t) && relation[t].includes(pins >>> 1));
      if (!possible) {
        for (const solver of [js, rs])
          assert.throws(
            () => solver.solve(options),
            (e) => e.code === 'failed' && /https:/.test(e.message),
          );
      } else {
        const a = js.solve(options);
        assert.deepEqual(a, rs.solve(options));
        assert.ok(relation[a[0]].includes(a[1]) && relation[a[1]].includes(a[2]));
      }
    }
  }
});
test('weighted and wide domains use TypeScript without losing tile 64 or 4095', async () => {
  for (const n of [65, 4096]) {
    const solver = await HeapWFC.create([1, 1, 1], open(n));
    assert.equal(solver.backend, 'typescript');
    assert.equal(solver.solve({ pins: [{ position: [0, 0, 0], tile: n - 1 }] })[0], n - 1);
  }
  const tiles = open(2);
  tiles[1].weight = 5;
  const m = await HeapWFC.create([12, 8, 1], tiles);
  assert.equal(m.backend, 'typescript');
  assert.deepEqual(m.solve({ seed: 17 }), m.solve({ seed: 17 }));
  await assert.rejects(HeapWFC.create([1, 1, 1], tiles, { backend: 'wasm' }), (e) => e.code === 'unsupported');
});
test('large heap output does bounded entropy work, not a full-grid scan per decision', () => {
  const m = new HeapWFC([192, 192, 1], open(4)),
    out = m.solve({ seed: 11 });
  assert.equal(out.length, 192 * 192);
  assert.equal(m.stats.decisions, out.length);
  assert.equal(m.stats.updates, out.length * 2);
  assert.ok(m.stats.updates < (out.length * m.stats.decisions) / 1000);
});
test('infinite-address chunks preserve every neighbouring seam in all axes and cache copies', async () => {
  const world = new ChunkedWFC([4, 3, 2], checker, 7),
    coords = [
      [0, 0, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
      [1, 1, 0],
      [1, 0, 1],
    ];
  const results = new Map();
  for (const p of coords) results.set(p.join(), await world.solveChunk(p));
  for (const p of coords)
    for (const [axis, stride] of [
      [0, 1],
      [1, 4],
      [2, 12],
    ]) {
      const q = [...p];
      q[axis]++;
      const next = results.get(q.join());
      if (!next) continue;
      const a = results.get(p.join());
      for (let z = 0; z < 2; z++)
        for (let y = 0; y < 3; y++)
          for (let x = 0; x < 4; x++) {
            const local = [x, y, z];
            if (local[axis] !== [3, 2, 1][axis]) continue;
            const i = x + 4 * (y + 3 * z);
            local[axis] = 0;
            const j = local[0] + 4 * (local[1] + 3 * local[2]);
            assert.equal(a[i] ^ next[j], 1, `axis ${axis}, stride ${stride}`);
          }
    }
  const first = await world.solveChunk([0, 0, 0]);
  first.fill(500);
  assert.notEqual((await world.solveChunk([0, 0, 0]))[0], 500);
  await world.solveChunk([-100000000001, 12345678901, 7000000000]);
  assert.equal(world.size, 10);
  world[Symbol.dispose]();
  assert.equal(world.size, 0);
});
test('failed/cancelled/concurrent chunks never commit partial state', async () => {
  const world = new ChunkedWFC([4, 4, 1], open(2));
  const active = world.solveChunk([0, 0, 0]);
  await assert.rejects(world.solveChunk([1, 0, 0]), (e) => e.code === 'failed');
  assert.throws(() => world.clear());
  await active;
  await assert.rejects(world.solveChunk([1, 0, 0], { signal: AbortSignal.abort() }), (e) => e.name === 'AbortError');
  assert.equal(world.size, 1);
  const impossible = new ChunkedWFC([2, 2, 1], [{ neighbors: Array.from({ length: 6 }, () => []) }]);
  await assert.rejects(impossible.solveChunk([0, 0, 0]), (e) => e.code === 'failed');
  assert.equal(impossible.size, 0);
  for (const p of [
    [Number.MAX_SAFE_INTEGER, 0, 0],
    [0, 0.5, 0],
  ])
    await assert.rejects(world.solveChunk(p), RangeError);
  assert.throws(() => new HeapWFC([1, 1, 1], open(2)).solve({ pins: [{ position: [1, 0, 0], tile: 0 }] }), RangeError);
  assert.throws(
    () => new HeapWFC([1, 1, 1], open(2)).solve({ signal: AbortSignal.abort() }),
    (e) => e.name === 'AbortError',
  );
});

test('256x256 chunk world generates without allocating a monolithic wave and checks every shared edge', async () => {
  const world = new ChunkedWFC([16, 16, 1], checker, 19),
    chunks = new Map();
  for (let cy = 0; cy < 16; cy++)
    for (let cx = 0; cx < 16; cx++) {
      const out = await world.solveChunk([cx, cy, 0]);
      for (let k = 0; k < 16; k++) {
        if (cx) assert.equal(out[k * 16] ^ chunks.get(`${cx - 1},${cy}`)[15 + k * 16], 1);
        if (cy) assert.equal(out[k] ^ chunks.get(`${cx},${cy - 1}`)[240 + k], 1);
      }
      chunks.set(`${cx},${cy}`, out);
    }
  assert.equal(world.size, 256);
  world.dispose();
});
