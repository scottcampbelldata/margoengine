// The measurement the allocation probes share (support/*-allocation-probe.mjs, run with --expose-gc,
// --allow-natives-syntax and --no-concurrent-recompilation). For each shape, a driver `run(count)` that makes `count`
// calls of one kernel: heap growth and collections over five windows of 20,000 calls. Returns one entry per shape:
// { name, clean, windows: [{ collections, grown }], turbofan, status }.
import { GCProfiler } from 'node:v8';
import { v8Tiers } from '../../../../scripts/support/v8-tiers.mjs';

const { isTurbofan, status } = v8Tiers();

export function kernelWindows(shapes) {
  const results = [];
  for (const [name, run] of Object.entries(shapes)) {
    run(20000);
    // The drivers compute fractional inputs, which unoptimized code boxes: a call of run() that starts in the
    // interpreter allocates about 16 B per iteration until on-stack replacement lands (some 6,000 iterations), and that
    // is the driver's garbage, not the kernel's. Run until run() itself has Turbofan code, at most 2,000 times,
    // so each window enters optimized code from its first call.
    for (let round = 0; round < 2000 && !isTurbofan(run); round++) run(100);
    const windows = [];
    let clean = false;
    // Each window starts from an empty young generation: even 16 bytes per call would grow the heap by 320 KB.
    for (let attempt = 0; attempt < 5 && !clean; attempt++) {
      globalThis.gc();
      const profiler = new GCProfiler(),
        before = process.memoryUsage().heapUsed;
      profiler.start();
      run(20000);
      const { statistics } = profiler.stop(),
        grown = process.memoryUsage().heapUsed - before;
      windows.push({ collections: statistics.length, grown });
      clean = statistics.length === 0 && grown < 64 * 1024;
    }
    results.push({ name, clean, windows, turbofan: isTurbofan(run), status: status(run) });
  }
  return results;
}
