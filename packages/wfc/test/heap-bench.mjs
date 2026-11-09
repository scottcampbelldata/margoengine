import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/wfc/test/heap-bench.mjs')
)
  process.exit(0);
// Paired, interleaved CPU comparison. Loaded-machine diagnostics, never a release speed claim.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { hostname, cpus } from 'node:os';
import { HeapWFC } from '../dist/chunks.js';
const ids = Array.from({ length: 8 }, (_, i) => i);
const cases = [
  {
    name: 'open-eight',
    dims: [192, 192, 1],
    tiles: ids.map(() => ({ neighbors: Array.from({ length: 6 }, () => ids) })),
  },
  {
    name: 'parity-eight',
    dims: [64, 64, 4],
    tiles: ids.map((t) => ({ neighbors: Array.from({ length: 6 }, () => ids.filter((u) => (u & 1) !== (t & 1))) })),
  },
];
const rows = [];
for (const c of cases) {
  const js = new HeapWFC(c.dims, c.tiles),
    wasm = await HeapWFC.create(c.dims, c.tiles, { backend: 'wasm' });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(js.solve({ seed: i }), wasm.solve({ seed: i }));
  }
  const rounds = [];
  for (let round = 0; round < 7; round++) {
    const times = { typescript: [], wasm: [] };
    let expected;
    for (let repeat = 0; repeat < 3; repeat++)
      for (const model of (round + repeat) & 1 ? [wasm, js] : [js, wasm]) {
        const before = performance.now(),
          out = model.solve({ seed: 100 + round });
        times[model.backend].push(performance.now() - before);
        if (expected) assert.deepEqual(out, expected);
        else expected = out;
      }
    assert.deepEqual(js.stats, wasm.stats);
    rounds.push({
      typescriptMinMs: Math.min(...times.typescript),
      wasmMinMs: Math.min(...times.wasm),
      hash: createHash('sha256').update(new Uint8Array(expected.buffer)).digest('hex'),
      stats: { ...js.stats },
    });
  }
  rows.push({
    name: c.name,
    dimensions: c.dims,
    tiles: c.tiles.length,
    rounds,
    fasterEveryRound: rounds.every((r) => r.wasmMinMs < r.typescriptMinMs),
  });
}
const result = {
  machine: hostname(),
  cpu: cpus()[0].model,
  node: process.version,
  date: new Date().toISOString(),
  status: 'LOADED-MACHINE DIAGNOSTIC; paired/interleaved minima; no published release speed claim',
  rows,
};
if (process.argv.includes('--record'))
  writeFileSync(
    new URL('../../../docs/whitepaper/results/batch-69-heap.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n',
  );
console.log(JSON.stringify(result));
