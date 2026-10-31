// What a bench server process does with a running VoxelServer: it answers bench/run.mjs over IPC, measuring one window of
// play between 'start' and 'stop'. server-process.mjs uses it, and so can a game's own server (run.mjs --server).
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/**
 * Reports to the parent process until it says 'exit'.
 * @param {import('../dist/server.js').VoxelServer} server The server, already listening.
 * @param {number} port Its port.
 * @param {{ close?: () => Promise<unknown> }} [options] `close` replaces `server.close()` at the exit.
 */
export function measureServer(server, port, { close = () => server.close() } = {}) {
  let errors = 0;
  const reported = server.onError;
  server.onError = (error) => {
    if (errors++ < 5) console.error(error);
    reported?.(error);
  };
  const started = performance.now();

  // Once a second: memory, and ticks and event-loop use over that second.
  const seconds = [];
  let elu = performance.eventLoopUtilization(),
    lastTicks = 0;
  setInterval(() => {
    const now = performance.eventLoopUtilization(),
      used = performance.eventLoopUtilization(now, elu),
      m = process.memoryUsage();
    elu = now;
    seconds.push({
      t: (performance.now() - started) / 1000,
      ticks: server.tick - lastTicks,
      elu: used.utilization,
      rss: m.rss,
      heap: m.heapUsed,
      players: server.counts.players,
    });
    lastTicks = server.tick;
  }, 1000).unref();

  let window;
  process.on('message', (message) => {
    if (message.type === 'start') {
      server.resetMetrics();
      const delay = monitorEventLoopDelay({ resolution: 5 });
      delay.enable();
      window = {
        at: performance.now(),
        tick: server.tick,
        cpu: process.cpuUsage(),
        elu: performance.eventLoopUtilization(),
        second: seconds.length,
        delay,
        joinTicks: undefined,
      };
      process.send({ type: 'started' });
    } else if (message.type === 'join-ticks') {
      // Tick times and bytes of the join phase: everything before the window.
      process.send({ type: 'join-ticks', tickTimes: server.metrics.tickTimes, bytesOut: server.metrics.bytesOut });
    } else if (message.type === 'stop') {
      const seconds_ = (performance.now() - window.at) / 1000,
        cpu = process.cpuUsage(window.cpu),
        used = performance.eventLoopUtilization(window.elu),
        m = server.metrics,
        memory = process.memoryUsage();
      window.delay.disable();
      process.send({
        type: 'report',
        seconds: seconds_,
        ticks: server.tick - window.tick,
        tickTimes: m.tickTimes,
        tickStarts: m.tickStarts,
        skipped: m.skipped,
        cpuSeconds: (cpu.user + cpu.system) / 1e6,
        elu: used.utilization,
        loopDelayP99: window.delay.percentile(99) / 1e6,
        bytesOut: m.bytesOut,
        bytesIn: m.bytesIn,
        corrections: m.corrections,
        editsAccepted: m.editsAccepted,
        editsDenied: m.editsDenied,
        chunksGenerated: m.chunksGenerated,
        counts: server.counts,
        memory: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external },
        perSecond: seconds.slice(window.second),
        peakRss: Math.max(...seconds.map((s) => s.rss), memory.rss),
        errors,
      });
    } else if (message.type === 'exit') close().then(() => process.exit(0));
  });
  process.send({ type: 'ready', port });
}
