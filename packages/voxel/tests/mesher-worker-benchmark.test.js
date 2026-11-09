import { speedTest } from '../../../scripts/support/speed-test.mjs';
// VoxelMesher throughput on worker_threads, printed and not asserted: meshes per second with 1, 2 and 3 workers over
// 64 chunks of seeded random terrain (meshInput on this thread, meshChunk in the workers), with the machine's CPU load
// during each run, since other jobs share the machine. At most half the logical cores (workers plus this thread).
import { cpus } from 'node:os';
import { VoxelMesher } from '../dist/mesher.js';
import { NodeWebWorker, terrainWorld } from './worker-support.js';

const times = () =>
  cpus().reduce(
    ([busy, all], { times: t }) => {
      const total = t.user + t.nice + t.sys + t.idle + t.irq;
      return [busy + total - t.idle, all + total];
    },
    [0, 0],
  );

speedTest('benchmark: VoxelMesher meshes per second with 1, 2 and 3 workers (printed)', async (t) => {
  const previous = globalThis.Worker;
  globalThis.Worker = NodeWebWorker;
  t.after(() => (globalThis.Worker = previous));
  const { world, keys } = terrainWorld(8, 11),
    cores = cpus().length,
    rounds = 4;
  for (const workers of [1, 2, 3].filter((n) => n + 1 <= cores / 2)) {
    const mesher = new VoxelMesher({ workers });
    await Promise.all(keys.map((key) => mesher.mesh(world, key))); // starts the workers and warms them up
    const [busy0, all0] = times(),
      own0 = process.cpuUsage(),
      start = performance.now();
    let quads = 0;
    for (let r = 0; r < rounds; r++)
      for (const mesh of await Promise.all(keys.map((key, i) => mesher.mesh(world, key, i))))
        quads += (mesh.opaque.length + mesh.cutout.length + mesh.translucent.length) / 3;
    const ms = performance.now() - start,
      [busy1, all1] = times(),
      own = process.cpuUsage(own0),
      machine = (100 * (busy1 - busy0)) / (all1 - all0),
      mine = (100 * (own.user + own.system)) / 1000 / (ms * cores),
      count = rounds * keys.length;
    mesher.dispose();
    t.diagnostic(
      `${workers} worker${workers > 1 ? 's' : ''}: ${((count * 1000) / ms).toFixed(0)} meshes/s ` +
        `(${count} meshes, ${(quads / count) | 0} quads each, ${((ms * workers) / count).toFixed(2)} ms per mesh per worker); ` +
        `machine CPU ${machine.toFixed(0)}% busy over ${cores} logical cores, this process ${mine.toFixed(0)}% of it`,
    );
  }
});
