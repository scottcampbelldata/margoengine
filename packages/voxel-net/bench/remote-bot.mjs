// One bot process of the real network bench (remote.mjs forks these): its share of bots ask /join as the page does, join
// through the proxy with the page's Origin, and play. A bot told full keeps asking, as the page does.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { clock, VoxelBot } from '../dist/bot.js';

const o = JSON.parse(process.argv[2]),
  { defineBlocks } = await import(pathToFileURL(o.blocks).href),
  { blocks } = defineBlocks(),
  bots = [],
  waiting = new Set();
let window = fresh(),
  stopped = false,
  connectFailed = 0;

function fresh() {
  return {
    at: clock(),
    cpu: process.cpuUsage(),
    elu: performance.eventLoopUtilization(),
    join: { ok: 0, full: 0, starting: 0, limited: 0, other: 0, error: 0, ms: [], fullMs: [], bodies: [] },
    joinTimes: [],
    rtts: [],
    closes: [],
    connectErrors: [],
    bytesBase: new Map(),
    receipts: [],
    edits: bots.map((b) => b.edits.length),
    corrections: bots.map((b) => b.client.stats.corrections),
    enteredAfterFull: 0,
  };
}

// Play every bot at 60 updates a second.
let last = performance.now();
setInterval(() => {
  const now = performance.now(),
    dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const bot of bots) bot.update(dt);
}, 16);

// One ping per bot every 5 s, the way round the whole path: bot, Cloudflare, nginx, the shard's event loop and back.
setInterval(() => {
  for (const bot of bots) {
    if (bot.closeCode !== undefined || bot.pingAt) continue;
    bot.pingAt = clock();
    bot.connection.ping();
  }
}, 5000).unref();

const near = (b) => {
  const p = b.client.player.position;
  return (p[0] - b.home[0]) ** 2 + (p[2] - b.home[1]) ** 2 <= o.leash ** 2;
};
setInterval(() => {
  process.send({
    type: 'progress',
    joined: bots.length,
    spawned: bots.filter((b) => b.times.spawn).length,
    loaded: bots.filter((b) => b.times.loaded).length,
    arrived: bots.filter((b) => b.times.spawn && near(b)).length,
    closed: bots.filter((b) => b.closeCode !== undefined).length,
    waiting: waiting.size,
    failed: connectFailed,
  });
}, 1000).unref();

async function ask(id) {
  const asked = clock();
  try {
    const res = await fetch(o.target.join, {
        headers: { Origin: o.target.origin },
        signal: AbortSignal.timeout(15_000),
      }),
      text = await res.text(),
      ms = clock() - asked;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      window.join.other++;
      if (window.join.bodies.length < 3) window.join.bodies.push(`${res.status}: ${text.slice(0, 200)}`);
      return { retry: 30_000 };
    }
    if (res.status === 429) {
      window.join.limited++;
      return { retry: 2000 };
    }
    if (res.status === 503) {
      window.join.starting++;
      return { retry: 2000 };
    }
    if (body.full) {
      window.join.full++;
      window.join.fullMs.push(ms);
      return { retry: (body.retryIn ?? 30) * 1000 };
    }
    window.join.ok++;
    window.join.ms.push(ms);
    return { url: body.url, asked };
  } catch (error) {
    window.join.error++;
    if (window.join.bodies.length < 3) window.join.bodies.push(error.message);
    return { retry: 30_000 };
  }
}

async function play(id) {
  const observer = id % o.observerEvery === 0;
  let asked = clock(),
    url = o.target.direct,
    refused = false;
  if (!url) {
    waiting.add(id);
    for (;;) {
      if (stopped) return;
      const answer = await ask(id);
      if (answer.url) {
        url = answer.url;
        asked = answer.asked;
        break;
      }
      if (answer.retry >= 30_000) refused = true;
      await new Promise((done) => setTimeout(done, answer.retry * (0.8 + 0.4 * Math.random())));
    }
    waiting.delete(id);
  }
  if (refused) window.enteredAfterFull++;
  const a = Math.random() * 2 * Math.PI,
    r = o.scenario === 'spread' ? o.spreadRadius * Math.sqrt(Math.random()) : 0,
    home = [r * Math.cos(a), r * Math.sin(a)];
  try {
    const bot = await VoxelBot.connect({
      url,
      blocks,
      name: 'Load Bot',
      view: o.view,
      players: observer,
      editInterval: o.editInterval,
      home,
      leash: o.leash,
      travelHome: o.scenario === 'spread' && o.travel === 'fly',
      headers: {
        Origin: o.target.origin,
        ...(o.fakeAddresses ? { 'X-Real-IP': `10.${(id >> 16) & 255}.${(id >> 8) & 255}.${id & 255}` } : {}),
      },
    });
    bot.id = id;
    bot.home = home;
    bot.asked = asked;
    bot.connection.onpong = () => {
      if (bot.pingAt) window.rtts.push(clock() - bot.pingAt);
      bot.pingAt = 0;
    };
    const closed = bot.connection.onclose;
    bot.connection.onclose = (code, reason) => {
      closed(code, reason);
      window.closes.push([code, reason]);
      console.log(
        `close ${code} ${reason} age ${Math.round((clock() - asked) / 1000)} s, ${bot.connection.bytesIn} bytes in, at ${new Date().toISOString()}`,
      );
    };
    bot.client.onLoaded = () => {
      bot.times.loaded = clock();
      window.joinTimes.push({
        joinMs: bot.times.connect - asked,
        openMs: bot.times.open - bot.times.connect,
        spawnMs: (bot.times.spawn ?? bot.times.loaded) - asked,
        fullViewMs: bot.times.loaded - asked,
      });
    };
    bot.client.onError = (error) => {
      if (window.connectErrors.length < 5) window.connectErrors.push(String(error?.message ?? error));
    };
    if (observer)
      bot.client.onBlocks = (changes) => {
        const t = clock();
        for (let k = 0; k < changes.length; k += 4)
          window.receipts.push(id, t, changes[k], changes[k + 1], changes[k + 2], changes[k + 3]);
      };
    window.bytesBase.set(bot, 0);
    bots.push(bot);
  } catch (error) {
    connectFailed++;
    if (window.connectErrors.length < 5) window.connectErrors.push(error.message);
  }
}

process.on('message', (message) => {
  if (message.type === 'mark') {
    window = fresh();
    window.bytesBase = new Map(bots.map((b) => [b, b.connection.bytesIn]));
    process.send({ type: 'marked' });
  } else if (message.type === 'report') {
    const cpu = process.cpuUsage(window.cpu),
      end = clock();
    let bytesIn = 0;
    for (const bot of bots) bytesIn += bot.connection.bytesIn - (window.bytesBase.get(bot) ?? 0);
    process.send({
      type: 'report',
      seconds: (end - window.at) / 1000,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      elu: performance.eventLoopUtilization(window.elu).utilization,
      bytesIn,
      join: window.join,
      joinTimes: window.joinTimes,
      rtts: window.rtts,
      closes: window.closes,
      connectErrors: window.connectErrors,
      enteredAfterFull: window.enteredAfterFull,
      corrections: bots.reduce((a, b, i) => a + b.client.stats.corrections - (window.corrections[i] ?? 0), 0),
      edits: bots.flatMap((b, i) =>
        b.edits.slice(window.edits[i] ?? 0).map((e) => [b.id, e.time, e.x, e.y, e.z, e.state]),
      ),
      receipts: window.receipts,
      live: bots.filter((b) => b.closeCode === undefined).length,
      waiting: waiting.size,
    });
  } else if (message.type === 'drop') {
    // Leave: some players go, so that those told full can come in.
    let left = message.count;
    for (const bot of bots) {
      if (left <= 0) break;
      if (bot.closeCode !== undefined) continue;
      bot.close();
      left--;
    }
  } else if (message.type === 'exit') {
    stopped = true;
    for (const bot of bots) bot.close();
    setTimeout(() => process.exit(0), 300);
  }
});
process.on('disconnect', () => process.exit(0));

// Arrivals at the asked rate; a slow join does not hold up the next player.
for (let i = 0; i < o.count; i++) {
  void play(o.first + i);
  await new Promise((done) => setTimeout(done, 1000 / o.joinRate));
}
