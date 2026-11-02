// A time budget on how fast code is, for a test that runs while the machine does other work. A wall clock counts the
// time this thread waits for a CPU: one biomes tile, about 30 ms alone, read 714.8 ms during a busy run with GPU jobs on
// the PC and 816.8 ms pinned to one CPU beside 7 busy processes, where its CPU time stayed at 8 to 58 ms. Neither of the
// other clocks Node offers will do: process.cpuUsage adds the JIT and GC threads (66 ms against this thread's 39 ms on
// the same run), and performance.eventLoopUtilization reads 0 for work that never gives the event loop a turn and
// counts waiting for a CPU as active when it does (1,269 ms beside this thread's 94 ms of CPU).
//
// What it does not count: work on another thread. In Node the code under test must run on this thread for its time to
// show. Windows charges CPU time by clock tick (15.6 ms), so one reading needs a budget of 100 ms or more: average
// repeated work to measure less. A busy machine still costs some CPU time (a busy sibling hyperthread, cold caches),
// so leave room, about 4 times a quiet reading, and no more than that lets a tenfold slowdown through.
//
//   MARGO_CPU_BUDGET_SLOWDOWN=10   makes every timer burn and report 10 times the CPU it measured: every budget in a
//                                  test run should then fail, which shows it would catch that slowdown.
//   MARGO_CPU_BUDGET_TRACE=1       prints each reading, its wall time and where it was taken, to set a budget from. Far
//                                  less CPU than wall on a quiet machine means the work ran on another thread.

const slowdown = Number(process.env.MARGO_CPU_BUDGET_SLOWDOWN ?? 1);

const threadMs = () => {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
};

/**
 * Starts a CPU timer for this thread. The returned function reads the milliseconds of CPU this thread has used since,
 * leaving out any time it spent waiting for a CPU, sleeping or waiting for I/O.
 *
 * @example
 * const cpu = cpuTimer();
 * work();
 * const ms = cpu();
 * assert.ok(ms < 200, `work took ${ms.toFixed(1)} ms of CPU`);
 */
export function cpuTimer() {
  const start = threadMs(),
    wall = performance.now();
  return () => {
    let ms = threadMs() - start;
    if (slowdown > 1) {
      for (const end = threadMs() + ms * (slowdown - 1); threadMs() < end; );
      ms = threadMs() - start;
    }
    if (process.env.MARGO_CPU_BUDGET_TRACE) {
      const at = new Error().stack
        ?.split('\n')[2]
        ?.trim()
        .replace(/^at .*?\(?(?=file:)/, '');
      console.error(`cpu-budget ${ms.toFixed(1)} ms wall ${(performance.now() - wall).toFixed(1)} ms ${at}`);
    }
    return ms;
  };
}
