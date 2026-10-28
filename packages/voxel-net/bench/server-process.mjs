// The bench's server process (bench/run.mjs forks it): a VoxelServer on the sandbox's terrain settings with the
// scenario's spawn rule. It reports its port, then on 'start' and 'stop' measures a window and sends the numbers back.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { VoxelServer } from '../dist/server.js';
import { testBlocks } from '../tests/blocks.js';

const { scenario, workers } = JSON.parse(process.argv[2]);
// A per-player random column: spread over a disc of 1,024 blocks, or a crowd within 32 blocks of the origin.
const radius = scenario === 'crowd' ? 32 : 1024;
function spawn(id) {
  let h = Math.imul(id, 0x9e3779b1) ^ 0x5bd1e995;
  const next = () => {
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const r = radius * Math.sqrt(next()),
    a = 2 * Math.PI * next();
  return [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))];
}

const server = new VoxelServer({
  blocks: testBlocks(),
  generator: { seed: 1, seaLevel: 0, height: 8, amplitude: 32, scale: 192, caves: 0.3, trees: 0.012 },
  spawn,
  maxPlayers: 5000,
  // Every bot connects from 127.0.0.1, so the per-address cap on joining connections would throttle the join rate.
  maxPerAddress: 1000,
  maxPending: 1000,
  ...(workers ? { workers } : {}),
});
let errors = 0;
server.onError = (error) => {
  if (errors++ < 5) console.error(error);
};
const { port } = await server.listen(0, '127.0.0.1');
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
    // Tick times of the join phase: everything before the window.
    process.send({ type: 'join-ticks', tickTimes: server.metrics.tickTimes });
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
  } else if (message.type === 'exit') server.close().then(() => process.exit(0));
});
process.send({ type: 'ready', port });
