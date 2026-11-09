import { speedTest } from '../../../scripts/support/speed-test.mjs';
// Get/set throughput, printed and not asserted (timings vary by machine). Single thread, well under a second.
import { BlockTypes, VoxelChunk, VoxelWorld } from '../dist/index.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rate = (n, ms) => `${(((n / ms) * 1e3) / 1e6).toFixed(1)} M/s`;

speedTest('benchmark: chunk and world get/set throughput (printed)', (t) => {
  const next = random(1),
    n = 400000,
    cells = Int32Array.from({ length: n * 3 }, () => Math.floor(next() * 32)),
    states = Uint32Array.from({ length: n }, () => Math.floor(next() * 12));
  const chunk = new VoxelChunk();
  let start = performance.now();
  for (let i = 0; i < n; i++) chunk.set(cells[3 * i], cells[3 * i + 1], cells[3 * i + 2], states[i]);
  const set = performance.now() - start;
  let sum = 0;
  start = performance.now();
  for (let i = 0; i < n; i++) sum += chunk.get(cells[3 * i], cells[3 * i + 1], cells[3 * i + 2]);
  const get = performance.now() - start;
  start = performance.now();
  for (let i = 0; i < 100; i++) VoxelChunk.unpack(chunk.pack());
  const round = (performance.now() - start) / 100;
  const blocks = new BlockTypes();
  for (let i = 1; i < 12; i++) blocks.define(`b${i}`);
  const world = new VoxelWorld({ blocks }),
    span = (i) => cells[i] * 4 - 64; // -64..60: 4 x 4 x 4 chunks
  start = performance.now();
  for (let i = 0; i < n; i++) world.setBlock(span(3 * i), span(3 * i + 1), span(3 * i + 2), states[i]);
  const worldSet = performance.now() - start;
  start = performance.now();
  for (let i = 0; i < n; i++) sum += world.getBlock(span(3 * i), span(3 * i + 1), span(3 * i + 2));
  const worldGet = performance.now() - start;
  // A column scan stays in one chunk: the cached-chunk path.
  start = performance.now();
  for (let i = 0; i < n; i++) sum += world.getBlock(5, i & 31, 9);
  const scan = performance.now() - start;
  t.diagnostic(
    `chunk (12 states, 4-bit): set ${rate(n, set)}, get ${rate(n, get)}; pack+unpack ${round.toFixed(3)} ms`,
  );
  t.diagnostic(`world, random cells in 64 chunks: setBlock ${rate(n, worldSet)}, getBlock ${rate(n, worldGet)}`);
  t.diagnostic(`world, one column: getBlock ${rate(n, scan)} (checksum ${sum})`);
});
