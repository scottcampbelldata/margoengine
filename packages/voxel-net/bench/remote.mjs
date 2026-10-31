// The real network bench: no server is forked. Bots on this machine join a running server through whatever stands in
// front of it, in rising steps, staying connected from one step to the next. Server numbers come from its /metrics.
//   node bench/run.mjs --url=wss://host --metrics=https://host/metrics --blocks=path/to/blocks.ts
//     [--scenario=crowd|spread] [--counts=25,50,100] [--join-rate=3] [--window=300] or [--steps=100@1.7:120,300@3.3:120]
//     [--view=8] [--edit-interval=2] [--spread-radius=1024] [--travel=walk|fly] [--drop-after=N] [--fake-addresses] [--max-seconds=10800] [--nice=10] [--out=FILE]
// --fake-addresses: each bot sends its own X-Real-IP, so a shard run with --proxied counts them as separate people. Only for
// a shard on this machine's loopback (a proxied shard reads that header from loopback connections only).
// --metrics takes a comma list to summarize the shards of several boxes in one run; the list's boxes share one token.
// The metrics token comes from the environment, PLAZA_METRICS_TOKEN, never from an argument.
import { fork } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, setPriority, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mergeMetrics, parseMetricsUrls, parseSteps, parseTarget, summarizeCloses, summarizeSamples } from './remote-args.mjs';

const BOTS_PER_PROCESS = 50,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  round = (v, d = 2) => (v === null || v === undefined ? v : Math.round(v * 10 ** d) / 10 ** d);
const quantiles = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b),
    q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: round(q(0.5)), p95: round(q(0.95)), p99: round(q(0.99)), max: round(s.at(-1)) };
};

// Bytes this machine has received, every interface but loopback. Linux only; elsewhere the bots' own count stands in.
async function nicBytes() {
  try {
    const text = await readFile('/proc/net/dev', 'utf8');
    return text
      .split('\n')
      .slice(2)
      .filter((line) => line.includes(':') && !/^\s*(lo|docker|veth|br-|virbr|tailscale)/.test(line))
      .reduce((sum, line) => sum + Number(line.split(':')[1].trim().split(/\s+/)[0]), 0);
  } catch {
    return null;
  }
}
const cpuTimes = () => cpus().map(({ times: t }) => ({ busy: t.user + t.nice + t.sys + t.irq, idle: t.idle }));

export async function runRemote(arg) {
  // Below normal on a machine with other work; bot processes inherit it.
  if (arg('nice')) setPriority(Number(arg('nice')));
  const scenario = arg('scenario', 'crowd'),
    steps = parseSteps({
      steps: arg('steps'),
      counts: arg('counts', '25,50,100,200').split(',').map(Number),
      joinRate: Number(arg('join-rate', 3)),
      window: Number(arg('window', 300)),
    }),
    target = parseTarget(arg('url'), arg('origin')),
    metricsUrls = parseMetricsUrls(arg('metrics')),
    token = process.env.PLAZA_METRICS_TOKEN,
    out = arg('out', fileURLToPath(new URL('./results-remote.json', import.meta.url))),
    blocks = arg('blocks'),
    maxSeconds = Number(arg('max-seconds', 10_800)),
    dropAfter = Number(arg('drop-after', 0)),
    overStop = Number(arg('steps-past-budget', 1)),
    settings = {
      target,
      scenario,
      view: Number(arg('view', 8)),
      editInterval: Number(arg('edit-interval', 2)),
      spreadRadius: Number(arg('spread-radius', 1024)),
      travel: arg('travel', 'walk'),
      fakeAddresses: !!arg('fake-addresses'),
      leash: scenario === 'spread' ? 32 : 64,
      observerEvery: 8,
      blocks,
    };
  if (!blocks) throw new TypeError('Pass --blocks=FILE, a module whose defineBlocks() gives the server block types');

  const children = [],
    progress = [],
    began = performance.now(),
    results = { date: new Date().toISOString(), scenario, machine: { cores: availableParallelism() }, steps: [] },
    save = () => writeFile(out, `${JSON.stringify(results, null, 1)}\n`),
    stopAll = () => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    };
  // The hard limit of the whole run: every bot process goes with it.
  const limit = setTimeout(() => {
    console.log(`hard limit of ${maxSeconds} s reached, stopping every bot`);
    stopAll();
    process.exit(2);
  }, maxSeconds * 1000);
  process.on('SIGTERM', () => {
    stopAll();
    process.exit(143);
  });
  const sum = (key) => progress.reduce((t, m) => t + (m?.[key] ?? 0), 0);
  const all = (type, send) =>
    Promise.all(
      children
        .filter((c) => c.connected)
        .map(
          (child) =>
            new Promise((done) => {
              const on = (m) => {
                if (m.type !== type) return;
                child.off('message', on);
                done(m);
              };
              child.on('message', on);
              child.send(send);
            }),
        ),
    );
  async function sampleBox(url) {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`metrics ${res.status}`);
    return res.json();
  }
  // One box stopping mid-hold must not cost the other box's numbers: only all of them failing is a failed sample.
  async function sampleMetrics() {
    if (!metricsUrls.length) return undefined;
    const answers = await Promise.allSettled(metricsUrls.map(sampleBox));
    if (answers.every((answer) => answer.status === 'rejected')) throw answers[0].reason;
    return mergeMetrics(answers.map((answer) => answer.value));
  }

  let finishing = false,
    total = 0,
    first = 1,
    over = 0;
  for (const step of steps) {
    const stepName = `${scenario} ${step.count}`,
      delta = step.count - total,
      processes = Math.ceil(delta / BOTS_PER_PROCESS);
    console.log(`${stepName}: ${delta} more at ${step.joinRate}/s`);
    const joinStart = Date.now();
    await all('marked', { type: 'mark' });
    for (let p = 0; p < processes; p++) {
      const share = Math.floor(delta / processes) + (p < delta % processes ? 1 : 0),
        slot = children.length,
        child = fork(
          fileURLToPath(new URL('./remote-bot.mjs', import.meta.url)),
          [JSON.stringify({ ...settings, count: share, first, joinRate: step.joinRate / processes })],
          { serialization: 'advanced' },
        );
      child.on('message', (m) => {
        if (m.type === 'progress') progress[slot] = m;
      });
      child.on('exit', (code) => {
        if (code && !finishing) {
          console.error(`bot process ${slot} failed with ${code}; stopping`);
          stopAll();
          process.exit(3);
        }
      });
      children.push(child);
      first += share;
    }
    total = step.count;
    // Join phase: samples go on through it, since a surge is measured here.
    const joinSamples = [],
      deadline = performance.now() + (delta / step.joinRate) * 1000 + 180_000 + (scenario === 'spread' ? 420_000 : 0),
      settled = () =>
        sum('loaded') + sum('failed') + sum('waiting') >= total - sum('closed') &&
        sum('joined') + sum('failed') + sum('waiting') >= total &&
        (settings.travel !== 'fly' ||
          scenario !== 'spread' ||
          sum('arrived') >= 0.9 * (total - sum('closed') - sum('waiting')));
    let shown = 0;
    await wait(2000);
    while (performance.now() < deadline && !settled()) {
      await sampleMetrics().then(
        (m) => m && joinSamples.push(m),
        () => {},
      );
      if (performance.now() - shown > 15_000) {
        shown = performance.now();
        console.log(
          `  joined ${sum('joined')} loaded ${sum('loaded')} arrived ${sum('arrived')} waiting ${sum('waiting')} closed ${sum('closed')} failed ${sum('failed')}`,
        );
      }
      await wait(2000);
    }
    const joinReports = await all('report', { type: 'report' }),
      joinEnd = Date.now();

    // The hold.
    await all('marked', { type: 'mark' });
    const holdStart = Date.now(),
      samples = [],
      machine = [],
      nic0 = await nicBytes();
    let cpu0 = cpuTimes();
    for (const until = holdStart + step.window * 1000; Date.now() < until; ) {
      await sampleMetrics().then(
        (m) => m && samples.push({ at: m.at, load: m.load, online: m.counters?.online, shards: m.shards }),
        (error) => samples.push({ at: Date.now(), error: error.message }),
      );
      const cpu1 = cpuTimes(),
        perCore = cpu1.map((c, i) => {
          const busy = c.busy - cpu0[i].busy,
            idle = c.idle - cpu0[i].idle;
          return busy / Math.max(1, busy + idle);
        });
      cpu0 = cpu1;
      machine.push({
        at: Date.now(),
        peakCore: Math.max(...perCore),
        mean: perCore.reduce((a, v) => a + v, 0) / perCore.length,
      });
      await wait(2000);
    }
    const nic1 = await nicBytes(),
      holdReports = await all('report', { type: 'report' }),
      holdEnd = Date.now();
    const r = summarizeStep(
      step,
      total,
      joinStart,
      joinEnd,
      holdStart,
      holdEnd,
      joinSamples,
      samples,
      joinReports,
      holdReports,
      machine,
      nic0,
      nic1,
    );
    r.minutes = round((performance.now() - began) / 60_000, 1);
    results.steps.push(r);
    await save();
    console.log(
      `  ${r.server.shards.map((s) => `s${s.index} ${s.players}p tick ${round(s.tickP50, 1)}/${round(s.tickP95, 1)}/${round(s.tickMax, 0)} ms ${round(s.ticksPerSecond, 2)}/s`).join('; ')}` +
        ` | live ${r.players.live} waiting ${r.players.waiting} rtt ${r.players.rttMs?.median}/${r.players.rttMs?.p95} edit ${r.players.editToOthersMs?.median}/${r.players.editToOthersMs?.p95}` +
        ` corr/min ${r.players.correctionsPerPlayerPerMinute} closes ${JSON.stringify(r.players.closes)}` +
        ` | down ${r.bots.downMbit} Mbit bots busy ${r.bots.processBusyMax} cpu ${r.bots.machineCpuMean} peak ${r.bots.machineCpuPeak}` +
        `${r.server.inBudget ? '' : ' OVER BUDGET'}${r.bots.saturated ? ' BOTS SATURATED' : ''}`,
    );
    if (r.bots.saturated) {
      console.log('  the bot machine is the limit here: stopping the rise');
      results.stoppedBy = 'bot machine';
      break;
    }
    const challenged = joinReports.concat(holdReports).some((rep) => rep.join.other > 0);
    if (challenged) {
      console.log('  /join answered something that is not JSON (a proxy limit or challenge): stopping');
      results.stoppedBy = 'proxy answer';
      break;
    }
    if (!r.server.inBudget && metricsUrls.length && ++over > overStop) {
      results.stoppedBy = 'over budget';
      break;
    }
  }
  if (dropAfter > 0) {
    await all('marked', { type: 'mark' });
    const each = Math.ceil(dropAfter / children.length);
    for (const child of children) if (child.connected) child.send({ type: 'drop', count: each });
    await wait(45_000);
    const reports = await all('report', { type: 'report' });
    results.afterDrop = {
      dropped: dropAfter,
      enteredAfterFull: reports.reduce((a, rep) => a + rep.enteredAfterFull, 0),
      full: reports.reduce((a, rep) => a + rep.join.full, 0),
      waiting: reports.reduce((a, rep) => a + rep.waiting, 0),
      live: reports.reduce((a, rep) => a + rep.live, 0),
    };
    console.log(`after drop ${JSON.stringify(results.afterDrop)}`);
  }
  results.machine.memoryFreeMB = round(freemem() / 2 ** 20, 0);
  results.machine.memoryTotalMB = round(totalmem() / 2 ** 20, 0);
  await save();
  finishing = true;
  for (const child of children) if (child.connected) child.send({ type: 'exit' });
  await wait(1500);
  stopAll();
  clearTimeout(limit);
  console.log(`wrote ${out}`);
  process.exit(0);
}

function joinSide(reports) {
  const j = { ok: 0, full: 0, starting: 0, limited: 0, other: 0, error: 0 };
  for (const rep of reports) for (const key of Object.keys(j)) j[key] += rep.join[key];
  return {
    ...j,
    answerMs: quantiles(reports.flatMap((rep) => rep.join.ms)),
    fullAnswerMs: quantiles(reports.flatMap((rep) => rep.join.fullMs)),
    bodies: reports.flatMap((rep) => rep.join.bodies).slice(0, 3),
    connectErrors: reports.flatMap((rep) => rep.connectErrors).slice(0, 5),
    enteredAfterFull: reports.reduce((a, rep) => a + rep.enteredAfterFull, 0),
    spawnMs: quantiles(reports.flatMap((rep) => rep.joinTimes.map((t) => t.spawnMs))),
    fullViewMs: quantiles(reports.flatMap((rep) => rep.joinTimes.map((t) => t.fullViewMs))),
    socketOpenMs: quantiles(reports.flatMap((rep) => rep.joinTimes.map((t) => t.openMs))),
    closes: closes(reports),
  };
}
function closes(reports) {
  const counts = {};
  for (const rep of reports)
    for (const [code, reason] of rep.closes) counts[`${code} ${reason}`] = (counts[`${code} ${reason}`] ?? 0) + 1;
  return counts;
}

// Each observer's receipt matched to the latest send of that cell and state by another bot on this machine.
function editDelays(reports) {
  const sends = new Map();
  for (const rep of reports)
    for (const [sender, time, x, y, z, state] of rep.edits) {
      const key = `${x},${y},${z},${state}`;
      if (!sends.has(key)) sends.set(key, []);
      sends.get(key).push([time, sender]);
    }
  for (const list of sends.values()) list.sort((a, c) => a[0] - c[0]);
  const delays = [];
  for (const rep of reports)
    for (let i = 0; i < rep.receipts.length; i += 6) {
      const [observer, time, x, y, z, state] = rep.receipts.slice(i, i + 6),
        list = sends.get(`${x},${y},${z},${state}`);
      if (!list) continue;
      let best;
      for (const [t, sender] of list) if (t <= time && sender !== observer) best = t;
      if (best !== undefined && time - best < 5000) delays.push(time - best);
    }
  return delays;
}

function summarizeStep(
  step,
  total,
  joinStart,
  joinEnd,
  holdStart,
  holdEnd,
  joinSamples,
  samples,
  joinReports,
  holdReports,
  machine,
  nic0,
  nic1,
) {
  const seconds = (holdEnd - holdStart) / 1000,
    server = summarizeSamples(samples.filter((s) => !s.error)),
    live = holdReports.reduce((a, rep) => a + rep.live, 0),
    bytesIn = holdReports.reduce((a, rep) => a + rep.bytesIn, 0),
    processBusyMax = Math.max(...holdReports.map((rep) => rep.elu)),
    machineCpuMean = machine.length ? machine.reduce((a, m) => a + m.mean, 0) / machine.length : 0,
    machineCpuPeak = machine.length ? Math.max(...machine.map((m) => m.peakCore)) : 0,
    serverOut = server.shards.reduce((a, s) => a + (s.bytesOutPerSecond ?? 0), 0),
    joinServer = summarizeSamples(
      joinSamples.map((m) => ({ at: m.at, shards: m.shards })),
      0,
    );
  return {
    target: step.count,
    joinRate: step.joinRate,
    holdSeconds: round(seconds, 0),
    window: { joinStart, joinEnd, holdStart, holdEnd },
    server: {
      inBudget: server.inBudget,
      shards: server.shards,
      metricErrors: samples.filter((s) => s.error).length,
      outMbit: round((serverOut * 8) / 1e6),
      duringJoin: joinServer.shards,
    },
    join: { seconds: round((joinEnd - joinStart) / 1000, 0), ...joinSide(joinReports) },
    players: {
      live,
      waiting: holdReports.reduce((a, rep) => a + rep.waiting, 0),
      rttMs: quantiles(holdReports.flatMap((rep) => rep.rtts)),
      editToOthersMs: quantiles(editDelays(holdReports)),
      correctionsPerPlayerPerMinute: round(
        holdReports.reduce((a, rep) => a + rep.corrections, 0) / Math.max(1, live) / (seconds / 60),
        3,
      ),
      closes: closes(holdReports),
      drops: holdReports.reduce((a, rep) => a + rep.drops.length, 0),
      resumes: holdReports.reduce((a, rep) => a + rep.resumes.length, 0),
      chunksResent: holdReports.reduce((a, rep) => a + rep.resumes.reduce((n, [, chunks]) => n + chunks, 0), 0),
      closeAges: summarizeCloses(
        holdReports.flatMap((rep) => rep.closes.map(([code, reason, age]) => ({ code, reason, age }))),
      ),
      joinDuringHold: joinSide(holdReports),
    },
    bots: {
      processes: holdReports.length,
      processBusyMax: round(processBusyMax, 3),
      cpuCores: round(holdReports.reduce((a, rep) => a + rep.cpuSeconds, 0) / seconds, 2),
      machineCpuMean: round(machineCpuMean, 3),
      machineCpuPeak: round(machineCpuPeak, 3),
      downMbit: round((bytesIn * 8) / seconds / 1e6),
      nicDownMbit: nic0 === null || nic1 === null ? null : round(((nic1 - nic0) * 8) / seconds / 1e6),
      // What the server wrote and the bots did not read in the hold: under 90% means the path or the bots fall behind.
      deliveredOfServerOut: serverOut ? round(bytesIn / seconds / serverOut, 3) : null,
      saturated: processBusyMax > 0.9 || machineCpuMean > 0.85,
    },
  };
}
