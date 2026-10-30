// Heap bytes per call, in windows of `calls` calls made by `run(calls)`, for the allocation probes (--expose-gc).
// A window inside which V8 collected garbage under-reports (the collection frees what the window allocated), so a
// frame that allocates more can read as allocating less: such windows are left out (v8.GCProfiler sees every
// collection) and measured again. The probes run with a 16 MB young generation (--min-semi-space-size=16), so a
// window that allocates a few kilobytes per call is never collected, and --single-threaded-gc, so no sweeper thread
// frees pages while a window counts.
import { GCProfiler, getHeapStatistics } from 'node:v8';

/**
 * `windows` clean measurements: bytes per call over `run(calls)` each, after a forced collection and less the cost of
 * reading the heap size. Throws when V8 collected garbage inside more than `windows` attempts.
 */
export function heapWindows(run, calls = 1000, windows = 5) {
  const heap = () => getHeapStatistics().used_heap_size;
  heap();
  const r0 = heap(),
    read = heap() - r0,
    bytes = [];
  let collected = 0;
  while (bytes.length < windows) {
    globalThis.gc();
    const profiler = new GCProfiler();
    profiler.start();
    const before = heap();
    run(calls);
    const after = heap();
    if (profiler.stop().statistics.length === 0) bytes.push((after - before - read) / calls);
    else if (++collected > windows)
      throw new Error(
        `V8 collected garbage inside ${collected} of ${collected + bytes.length} windows of ${calls} calls: each call ` +
          `allocates so much that no window stays clean (${Math.round((after - before) / calls)} B per call left after ` +
          'the last collection, an under-count).',
      );
  }
  return bytes;
}
