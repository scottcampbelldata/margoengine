// The clock of the flythrough check's slow-machine flight (slowSends), shared by the page and its unit test. That
// flight makes each send and texture write dearer with a busy wait and times the view's work in every frame. On an
// Intel Arc 140V laptop (8 cores) the page thread once stopped for 2.9 ms inside such a wait, before the r32float write
// the wait stood for, with no garbage collection, compile or task on the thread in the trace: the operating system had
// taken the thread away. The check counted those 2.9 ms as view work and failed (4.0 ms, and 5.6 and 5.8 ms in earlier
// runs, against 3.5). The view runs no code inside the check's own wait, so time the thread did not run there is not
// the view's; this clock keeps it apart. Time lost anywhere else (inside the view, or inside the real write) still
// counts, so a slow step is caught as before.

/** A gap between two clock reads in a busy wait over this many milliseconds is time the thread did not run. */
export const STALL_MS = 0.5;
/** One step of performance.now() in a page that is not cross-origin isolated, milliseconds. */
export const CLOCK_STEP = 0.1;

/**
 * A clock for timing frames under simulated costs.
 * @param {() => number} now Milliseconds (performance.now in the page).
 */
export function stallClock(now) {
  let stalled = 0;
  return {
    /**
     * Busy-waits until the thread has run for `ms` milliseconds. Two reads in this loop are microseconds apart, so a
     * gap over STALL_MS is the thread not running: one clock step of it counts as running (the loop may have run up
     * to a step across it), the rest as stalled, and the wait goes on until it has run its full time.
     * @param {number} ms
     */
    wait(ms) {
      let ran = 0,
        last = now();
      while (ran < ms) {
        const t = now(),
          gap = t - last;
        last = t;
        if (gap > STALL_MS) {
          stalled += gap - CLOCK_STEP;
          ran += CLOCK_STEP;
        } else ran += gap;
      }
    },
    /**
     * Runs `work` and times it: `total` on the clock, `stalled` the time the thread did not run inside this clock's
     * waits meanwhile, `own` the rest (the work's own time, the full simulated costs included).
     * @param {() => void} work
     */
    time(work) {
      const before = stalled,
        start = now();
      work();
      const total = now() - start,
        lost = stalled - before;
      return { total, stalled: lost, own: total - lost };
    },
  };
}
