// voxel-net capacity bench (design: packages/voxel-net/DESIGN.md, "Bots and the bench"). For each scenario and bot
// count: a server process, bot processes joining at a steady rate, a wait until every bot has its whole view, then a
// measured window of steady play. Counts go up until the 20 Hz budget breaks (p95 tick over 50 ms, or under 19.5 ticks
// per second), with one bisection step. Writes bench/results.json.
//
//   node bench/run.mjs [--scenarios=spread,crowd] [--counts=50,100,200,400] [--window=30] [--join-rate=25]
//                      [--until-break=1] [--max=3000] [--workers=8] [--out=bench/results.json] [--profile=dir]
// --profile writes a V8 CPU profile of each server process into that folder.
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const options = {
  scenarios: arg('scenarios', 'spread,crowd').split(','),
  counts: arg('counts', '50,100,200,400').split(',').map(Number),
  window: Number(arg('window', 30)),
  joinRate: Number(arg('join-rate', 25)),
  untilBreak: arg('until-break', '1') === '1',
  max: Number(arg('max', 3000)),
  workers: arg('workers') ? Number(arg('workers')) : undefined,
  out: arg('out', fileURLToPath(new URL('./results.json', import.meta.url))),
  profile: arg('profile'),
  observerEvery: 8,
  editInterval: 2,
  botsPerProcess: 50,
  maxProcesses: 12,
};
const here = (file) => fileURLToPath(new URL(file, import.meta.url)),
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const quantiles = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b),
    q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: round(q(0.5)), p95: round(q(0.95)), p99: round(q(0.99)), max: round(s.at(-1)) };
};
const next = (child, type) =>
  new Promise((done) => {
    const on = (m) => {
      if (m.type !== type) return;
      child.off('message', on);
      done(m);
    };
    child.on('message', on);
  });

async function run(scenario, count) {
  const server = fork(here('./server-process.mjs'), [JSON.stringify({ scenario, workers: options.workers })], {
      serialization: 'advanced',
      execArgv: options.profile
        ? ['--cpu-prof', `--cpu-prof-dir=${options.profile}`, `--cpu-prof-name=${scenario}-${count}.cpuprofile`]
        : [],
    }),
    { port } = await next(server, 'ready'),
    processes = Math.min(options.maxProcesses, Math.ceil(count / options.botsPerProcess)),
    bots = [],
    progress = [];
  for (let p = 0, first = 1; p < processes; p++) {
    const share = Math.floor(count / processes) + (p < count % processes ? 1 : 0),
      child = fork(
        here('./bot-process.mjs'),
        [
          JSON.stringify({
            url: `ws://127.0.0.1:${port}`,
            count: share,
            first,
            joinRate: options.joinRate / processes,
            scenario,
            observerEvery: options.observerEvery,
            editInterval: options.editInterval,
          }),
        ],
        { serialization: 'advanced' },
      );
    child.on('message', (m) => {
      if (m.type === 'progress') progress[p] = m;
    });
    bots.push(child);
    first += share;
  }
  // Join phase: until every bot has its whole view (or a deadline).
  const began = performance.now(),
    deadline = began + (count / options.joinRate) * 1000 + 180_000,
    sum = (k) => progress.reduce((t, m) => t + (m?.[k] ?? 0), 0);
  let shown = 0;
  while (performance.now() < deadline && sum('loaded') + sum('failed') + sum('closed') < count) {
    await wait(500);
    if (performance.now() - shown > 10_000) {
      shown = performance.now();
      console.log(
        `  ${scenario} ${count}: joined ${sum('joined')}, spawned ${sum('spawned')}, loaded ${sum('loaded')}`,
      );
    }
  }
  const joinSeconds = (performance.now() - began) / 1000,
    joinStatus = { joined: sum('joined'), spawned: sum('spawned'), loaded: sum('loaded'), failed: sum('failed') };
  server.send({ type: 'join-ticks' });
  const joinTicks = (await next(server, 'join-ticks')).tickTimes;
  // Measured window.
  server.send({ type: 'start' });
  await next(server, 'started');
  for (const b of bots) b.send({ type: 'start' });
  await wait(options.window * 1000);
  const reports = bots.map((b) => next(b, 'report')),
    serverReport = next(server, 'report');
  for (const b of bots) b.send({ type: 'stop' });
  server.send({ type: 'stop' });
  const s = await serverReport,
    b = await Promise.all(reports);
  for (const child of [...bots, server]) child.send({ type: 'exit' });
  await wait(1500);
  for (const child of [...bots, server]) if (child.exitCode === null) child.kill();
  return summarize(scenario, count, joinSeconds, joinStatus, joinTicks, s, b);
}

function summarize(scenario, count, joinSeconds, joinStatus, joinTicks, s, reports) {
  const players = s.counts.players,
    allBots = reports.flatMap((r) => r.bots),
    rate = s.ticks / s.seconds,
    intervals = s.tickStarts.slice(1).map((t, i) => t - s.tickStarts[i]),
    out = Object.values(s.bytesOut).reduce((a, v) => a + v, 0);
  // Edit delay: each observer's receipt matched to the latest send of that cell and state by another bot.
  const sends = new Map();
  for (const bot of allBots)
    for (const [sender, time, x, y, z, state] of bot.edits) {
      const key = `${x},${y},${z},${state}`;
      if (!sends.has(key)) sends.set(key, []);
      sends.get(key).push([time, sender]);
    }
  for (const list of sends.values()) list.sort((a, c) => a[0] - c[0]);
  const delays = [];
  for (const r of reports)
    for (let i = 0; i < r.receipts.length; i += 6) {
      const [observer, time, x, y, z, state] = r.receipts.slice(i, i + 6),
        list = sends.get(`${x},${y},${z},${state}`);
      if (!list) continue;
      let best;
      for (const [t, sender] of list) if (t <= time && sender !== observer) best = t;
      if (best !== undefined && time - best < 5000) delays.push(time - best);
    }
  const tick = quantiles(s.tickTimes),
    within = tick && tick.p95 <= 50 && rate >= 19.5;
  return {
    scenario,
    bots: count,
    playersInWindow: players,
    withinBudget: !!within,
    join: {
      secondsForAll: round(joinSeconds, 1),
      ...joinStatus,
      welcomeMs: quantiles(allBots.filter((x) => x.times.welcome).map((x) => x.times.welcome - x.times.connect)),
      spawnMs: quantiles(allBots.filter((x) => x.times.spawn).map((x) => x.times.spawn - x.times.connect)),
      fullViewMs: quantiles(allBots.filter((x) => x.times.loaded).map((x) => x.times.loaded - x.times.connect)),
      tickMsDuringJoin: quantiles(joinTicks),
    },
    window: {
      seconds: round(s.seconds, 1),
      ticksPerSecond: round(rate),
      skippedCatchUps: s.skipped,
      tickWorkMs: tick,
      tickIntervalMs: quantiles(intervals),
      mainThreadBusy: round(s.elu, 3),
      mainThreadBusyMsPerTick: round((s.elu * 1000) / rate),
      eventLoopDelayP99Ms: round(s.loopDelayP99),
      processCpuCores: round(s.cpuSeconds / s.seconds),
      memory: {
        rssMB: round(s.memory.rss / 2 ** 20, 1),
        peakRssMB: round(s.peakRss / 2 ** 20, 1),
        heapUsedMB: round(s.memory.heapUsed / 2 ** 20, 1),
        ...s.counts,
        cacheMB: round(s.counts.cacheBytes / 2 ** 20, 1),
      },
      bytesOutPerSecond: round(out / s.seconds, 0),
      bytesOutPerClientPerSecond: round(out / s.seconds / players, 0),
      bytesOutByTypePerSecond: Object.fromEntries(
        Object.entries(s.bytesOut).map(([k, v]) => [k, round(v / s.seconds, 0)]),
      ),
      bytesInPerSecond: round(s.bytesIn / s.seconds, 0),
      bytesInPerClientPerSecond: round(s.bytesIn / s.seconds / players, 0),
      receivedPerBotPerSecond: quantiles(
        allBots.map((x) => Object.values(x.received).reduce((a, v) => a + v, 0) / s.seconds),
      ),
      editToOtherClientMs: quantiles(delays),
      editsAcceptedPerSecond: round(s.editsAccepted / s.seconds, 1),
      editsDeniedPerSecond: round(s.editsDenied / s.seconds, 1),
      correctionsPerPlayerPerMinute: round(s.corrections / players / (s.seconds / 60), 3),
      chunksGeneratedPerSecond: round(s.chunksGenerated / s.seconds, 1),
      serverErrors: s.errors,
      botClosed: allBots.filter((x) => x.closeCode !== undefined).length,
      botProcesses: reports.length,
      botProcessBusyMax: round(Math.max(...reports.map((r) => r.elu)), 3),
      botProcessCpuCores: round(reports.reduce((a, r) => a + r.cpuSeconds, 0) / s.seconds, 2),
    },
  };
}

const results = {
  date: new Date().toISOString(),
  machine: {
    cpu: cpus()[0]?.model.trim(),
    logicalCores: availableParallelism(),
    memoryGB: round(totalmem() / 2 ** 30, 1),
    node: process.version,
    platform: process.platform,
  },
  settings: {
    ...options,
    out: undefined,
    tickRate: 20,
    view: '6 chunks across (a circle), 3 up and down',
    simulation: '3 chunks across, 2 up and down',
    playerDistance: 96,
    terrain: 'noiseTerrain seed 1, the sandbox settings without plants',
    spread: 'spawn uniformly over a disc of 1,024 blocks radius, wander freely',
    crowd: 'spawn within 32 blocks of the origin, walk back once past 64 blocks',
    bots: 'walk, jump when blocked, swim up; edit every 2 s alternating break and place; decode chunks within 1 chunk; 1 in 8 decode player updates (observers)',
  },
  caveats: [
    'Server and bots share one PC and talk over loopback: no network latency, loss or bandwidth limit; bots compete with the server for CPU.',
    'Bytes out and in are counted by the server per WebSocket message (frame headers included, TCP/IP not).',
    'Edit-to-other-client delay is measured from the sending bot to observer bots on one machine clock (performance.timeOrigin + now); it includes waiting for the next tick.',
    'Join times are measured while the other bots are still joining (25 per second).',
  ],
  runs: [],
};
const save = () => writeFile(options.out, `${JSON.stringify(results, null, 1)}\n`);

for (const scenario of options.scenarios) {
  const counts = [...options.counts];
  let good, bad;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i];
    console.log(`${scenario} ${count} bots`);
    const r = await run(scenario, count);
    results.runs.push(r);
    await save();
    const w = r.window;
    console.log(
      `  tick median ${w.tickWorkMs?.median} p95 ${w.tickWorkMs?.p95} ms, ${w.ticksPerSecond}/s, busy ${w.mainThreadBusy}, ` +
        `${w.processCpuCores} cores, rss ${w.memory.rssMB} MB, out ${Math.round(w.bytesOutPerSecond / 1024)} KiB/s, ` +
        `join p95 ${r.join.fullViewMs?.p95} ms, edit delay p95 ${w.editToOtherClientMs?.p95} ms, ` +
        `bots busy ${w.botProcessBusyMax}${r.withinBudget ? '' : '  OVER BUDGET'}`,
    );
    if (r.withinBudget) good = Math.max(good ?? 0, count);
    else bad = Math.min(bad ?? Number.POSITIVE_INFINITY, count);
    if (w.botProcessBusyMax > 0.9) {
      console.log('  bot processes saturated: they, not the server, may be the limit');
      r.botsSaturated = true;
    }
    if (bad !== undefined && i === counts.length - 1 && good !== undefined && bad - good > 100) {
      const middle = Math.round((good + bad) / 2 / 50) * 50;
      if (middle > good && middle < bad && !counts.includes(middle)) counts.push(middle);
    }
    if (options.untilBreak && bad === undefined && i === counts.length - 1 && count < options.max)
      counts.push(Math.min(options.max, count < 1000 ? count + 200 : count + 400));
  }
  results[`${scenario}Limit`] = { lastWithinBudget: good ?? null, firstOverBudget: bad ?? null };
  await save();
}
console.log(`wrote ${options.out}`);
