export function installBenchmark(render, details) {
  const times = new Float64Array(1200),
    counters = new Uint32Array(1200 * 4);
  let index = 0,
    last = 0,
    done,
    failed;
  const state = (window.benchmark = {
    ...details,
    ready: true,
    warmReady: false,
    complete: false,
    run() {
      return new Promise((resolve, reject) => {
        done = resolve;
        failed = reject;
        requestAnimationFrame(tick);
      });
    },
    measure() {
      last = 0;
      requestAnimationFrame(tick);
    },
    result() {
      return {
        ...details,
        frames: index,
        timestamps: Array.from(times),
        counts: Array.from(counters),
      };
    },
  });
  function tick(time) {
    try {
      const delta = last ? Math.min((time - last) / 1000, 0.1) : 0;
      last = time;
      render(delta, counters, index * 4);
      times[index++] = time;
      if (index === 200) {
        state.warmReady = true;
        return;
      }
      if (index === 1200) {
        state.complete = true;
        done();
        return;
      }
      requestAnimationFrame(tick);
    } catch (error) {
      state.error = String(error);
      failed(error);
    }
  }
}
