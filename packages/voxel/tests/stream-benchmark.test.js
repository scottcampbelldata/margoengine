// Generation speed, printed and not asserted: noiseTerrain per chunk on this thread, then a VoxelStreamer filling a
// 565-chunk range (distance 6, vertical 2) from the built terrain worker with 1, 2 and 3 Node worker threads. Prints the
// machine's CPU use during each run (other jobs share it).
import test from 'node:test';
import { cpus } from 'node:os';
import { BlockTypes, VoxelChunk, VoxelWorld } from '../dist/index.js';
import { noiseTerrain } from '../dist/generate.js';
import { VoxelStreamer } from '../dist/stream.js';
import { NodeWebWorker } from './worker-support.js';

const blocks = new BlockTypes();
for (const name of ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves']) blocks.define(name);
const busy = () =>
  cpus().reduce(
    (sum, { times }) => [sum[0] + times.idle, sum[1] + times.user + times.nice + times.sys + times.irq],
    [0, 0],
  );
const load = (before) => {
  const [idle, work] = busy();
  return `${Math.round((100 * (work - before[1])) / (idle - before[0] + work - before[1]))}% CPU`;
};

test('generation benchmark (printed)', async (t) => {
  const previous = globalThis.Worker;
  globalThis.Worker = NodeWebWorker;
  t.after(() => (globalThis.Worker = previous));
  const terrain = { seed: 1, trees: 0.02 },
    fn = noiseTerrain(terrain);
  let n = 0,
    cpu = busy(),
    start = performance.now();
  const packed = [];
  for (let cy = -2; cy <= 1; cy++)
    for (let cz = 0; cz < 6; cz++)
      for (let cx = 0; cx < 6; cx++, n++) {
        const chunk = new VoxelChunk();
        fn(chunk, cx, cy, cz, { blocks: blocks.table });
        packed.push(chunk.pack());
      }
  const generate = (performance.now() - start) / n;
  start = performance.now();
  for (const p of packed) VoxelChunk.unpack(p);
  console.log(
    `noiseTerrain on this thread: ${generate.toFixed(2)} ms per chunk (${n} chunks, y -64..63); VoxelChunk.unpack of its result on the main thread ${((1000 * (performance.now() - start)) / n).toFixed(0)} us; ${load(cpu)}, ${cpus().length} logical cores`,
  );
  for (const workers of [1, 2, 3]) {
    const world = new VoxelWorld({ blocks }),
      streamer = new VoxelStreamer({
        world,
        generator: terrain,
        workers,
        distance: 6,
        verticalDistance: 2,
        chunksPerFrame: Infinity,
      });
    streamer.viewers = [[1000 * workers, 0, 0]];
    let main = 0,
      updates = 0;
    cpu = busy();
    start = performance.now();
    do {
      const t0 = performance.now();
      streamer.update();
      main += performance.now() - t0;
      updates++;
      await new Promise((resolve) => setImmediate(resolve));
    } while (streamer.pending > 0);
    const seconds = (performance.now() - start) / 1000,
      chunks = world.dirty.size;
    console.log(
      `VoxelStreamer, ${workers} worker(s): ${Math.round(chunks / seconds)} chunks/s (${chunks} chunks in ${seconds.toFixed(2)} s; update() ${((1000 * main) / updates).toFixed(0)} us per call over ${updates} calls; ${load(cpu)})`,
    );
    await streamer.dispose();
  }
});
