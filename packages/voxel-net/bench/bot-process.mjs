// The bench's bot process (bench/run.mjs forks several): joins its share of bots at a steady rate, plays them at 60
// updates per second, and reports join times, bytes, edits sent and (for observer bots) edits received.
import { performance } from 'node:perf_hooks';
import { clock, VoxelBot } from '../dist/bot.js';
import { testBlocks } from '../tests/blocks.js';

const { url, count, first, joinRate, scenario, observerEvery, editInterval } = JSON.parse(process.argv[2]);
const blocks = testBlocks(),
  bots = [],
  receipts = []; // [bot index, time, x, y, z, state] of edits observers received in the window
let measuring = false,
  failed = 0;

// Play every bot at 60 updates per second.
let last = performance.now();
setInterval(() => {
  const now = performance.now(),
    dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const bot of bots) bot.update(dt);
}, 16);

// Progress for the coordinator: how many have spawned and loaded their whole view.
setInterval(() => {
  process.send({
    type: 'progress',
    joined: bots.length,
    spawned: bots.filter((b) => b.times.spawn).length,
    loaded: bots.filter((b) => b.times.loaded).length,
    closed: bots.filter((b) => b.closeCode !== undefined).length,
    failed,
  });
}, 500).unref();

let start;
process.on('message', (message) => {
  if (message.type === 'start') {
    measuring = true;
    start = {
      at: clock(),
      cpu: process.cpuUsage(),
      elu: performance.eventLoopUtilization(),
      bots: bots.map((b) => ({
        received: { ...b.client.stats.received },
        sent: b.client.stats.sent,
        corrections: b.client.stats.corrections,
        edits: b.edits.length,
      })),
    };
  } else if (message.type === 'stop') {
    measuring = false;
    const end = clock(),
      cpu = process.cpuUsage(start.cpu),
      seconds = (end - start.at) / 1000;
    process.send({
      type: 'report',
      seconds,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      elu: performance.eventLoopUtilization(start.elu).utilization,
      failed,
      bots: bots.map((b, i) => {
        const s = start.bots[i] ?? { received: {}, sent: 0, corrections: 0, edits: 0 };
        return {
          id: b.id,
          times: b.times,
          closeCode: b.closeCode,
          received: Object.fromEntries(
            Object.entries(b.client.stats.received).map(([k, v]) => [k, v - (s.received[k] ?? 0)]),
          ),
          sent: b.client.stats.sent - s.sent,
          corrections: b.client.stats.corrections - s.corrections,
          edits: b.edits.slice(s.edits).map((e) => [b.id, e.time, e.x, e.y, e.z, e.state]),
        };
      }),
      receipts,
    });
  } else if (message.type === 'exit') {
    for (const bot of bots) bot.close();
    setTimeout(() => process.exit(0), 200);
  }
});

// Join at joinRate per second.
for (let i = 0; i < count; i++) {
  const id = first + i,
    observer = id % observerEvery === 0;
  VoxelBot.connect({
    url,
    blocks,
    name: `bot${id}`,
    players: observer,
    editInterval,
    ...(scenario === 'crowd' ? { home: [0, 0], leash: 64 } : {}),
  }).then(
    (bot) => {
      bot.id = id;
      bot.client.onError = (error) => {
        if (failed++ < 3) console.error(error);
      };
      if (observer)
        bot.client.onBlocks = (changes) => {
          if (!measuring) return;
          const t = clock();
          for (let k = 0; k < changes.length; k += 4)
            receipts.push(id, t, changes[k], changes[k + 1], changes[k + 2], changes[k + 3]);
        };
      bots.push(bot);
    },
    (error) => {
      failed++;
      console.error(error.message);
    },
  );
  await new Promise((done) => setTimeout(done, 1000 / joinRate));
}
