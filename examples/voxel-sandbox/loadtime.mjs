// Plaza load time: where the seconds go, against a local router and shard (never the live server: anything else this page
// asks for is refused and counted). It builds the page, serves it gzipped like the live nginx, and puts one TCP pipe in
// front of the page, the router and the shard, sharing one rate and delay, so WebSockets are held to the connection too
// (Chromium's own network emulation does not reliably cover them). Each new connection waits 2 round trips, for TCP and
// TLS. CPU throttling is Chromium's, applied to the page and its workers; the GPU stays this PC's.
//   node examples/voxel-sandbox/loadtime.mjs [--profiles=a,b] [--runs=3] [--out=file] [--no-build] [--headed] [--bots=n]
// --bots=n has n walking, building bots on the shard during every run, each in their own view of it.
// Run it from a checkout after `npm run build:packages`, holding a GPU slot. Emulation is not a phone: relative numbers.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { freePort } from '../../scripts/browser.js';
import { killTree } from '../../scripts/support/shutdown.mjs';

const option = (name, fallback) => {
    const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  },
  LIMIT = Number(option('limit', 14)) * 60_000,
  RUNS = Number(option('runs', 3)),
  HEADLESS = !option('headed'),
  BOTS = Number(option('bots', 0)),
  ROOT = resolve(import.meta.dirname, '../..'),
  DIST = resolve(ROOT, String(option('dist', 'test-results/plaza-load-dist'))),
  IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const desktop = { viewport: { width: 1280, height: 720 } },
  phone = {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE,
  };
/** Rate in Mbps, delay as one round trip in ms, CPU slowdown. */
const PROFILES = {
  'desktop-open': { down: 0, up: 0, rtt: 0, cpu: 1, context: desktop },
  'desktop-10': { down: 10, up: 5, rtt: 40, cpu: 1, context: desktop },
  'desktop-10-high': { down: 10, up: 5, rtt: 40, cpu: 1, context: desktop, query: '&quality=high' },
  // Two mesher workers: what an iPhone's reported core count gives (this PC would start four).
  'phone-open': { down: 0, up: 0, rtt: 0, cpu: 1, context: phone, query: '&workers=2' },
  'phone-4g': { down: 9, up: 3, rtt: 60, cpu: 4, context: phone, query: '&workers=2' },
  'phone-slow4g': { down: 1.6, up: 0.75, rtt: 150, cpu: 6, context: phone, query: '&workers=2' },
};

setTimeout(() => {
  console.error('loadtime: stopped at its time limit');
  process.exit(124);
}, LIMIT).unref();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** One connection's worth of shape: every pipe shares the two directions' rates. */
class Link {
  rate = { down: 0, up: 0 };
  rtt = 0;
  #queues = { down: [], up: [] };
  #sent = { down: 0, up: 0 };
  #timer;
  set({ down, up, rtt }) {
    this.rate = { down: (down * 1e6) / 8, up: (up * 1e6) / 8 };
    this.rtt = rtt;
    this.#sent = { down: 0, up: 0 };
    for (const way of ['down', 'up']) this.#queues[way].length = 0;
    clearInterval(this.#timer);
    let last = performance.now();
    this.#timer = setInterval(() => {
      const now = performance.now(),
        dt = (now - last) / 1000;
      last = now;
      for (const way of ['down', 'up']) this.#drain(way, dt);
    }, 4);
    this.#timer.unref();
  }
  // Bytes leave the queue at the rate, then take half a round trip to arrive.
  #drain(way, dt) {
    const rate = this.rate[way],
      queue = this.#queues[way];
    let budget = rate ? rate * dt + this.#sent[way] : Number.POSITIVE_INFINITY;
    while (queue.length && budget > 0) {
      const item = queue[0],
        take = Math.min(budget, item.data.length);
      budget -= take;
      if (item.at > performance.now()) break;
      const part = item.data.subarray(0, take),
        to = item.to;
      if (this.rtt) setTimeout(() => to.writable && to.write(part), this.rtt / 2);
      else if (to.writable) to.write(part);
      item.data = item.data.subarray(take);
      if (!item.data.length) queue.shift();
    }
    this.#sent[way] = queue.length && budget > 0 && Number.isFinite(budget) ? Math.min(budget, rate * 0.05) : 0;
  }
  send(way, data, to, at = 0) {
    this.#queues[way].push({ data, to, at });
  }
}

// The page, as nginx would serve it: gzip for what compresses. Set in the argument: headers on top.
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
  },
  zipped = new Map();
function serve() {
  const server = createHttp((request, response) => {
    const url = new URL(request.url, 'http://x');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/\\/g, '/');
    path = path.replace(/^\/plaza\/?/, '/');
    if (path === '/' || !path) path = '/index.html';
    const file = join(DIST, path);
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!zipped.has(file)) zipped.set(file, gzipSync(readFileSync(file), { level: 6 }));
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-encoding': 'gzip',
      'cache-control': 'no-store',
      // The page's resource timing reads sizes across its own origin only; this is one origin.
      vary: 'accept-encoding',
    });
    response.end(zipped.get(file));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

async function startRouter(shardPipePort) {
  const [routerPort, shardPort] = [await freePort(), await freePort()],
    data = mkdtempSync(join(tmpdir(), 'plaza-load-')),
    child = spawn(
      process.execPath,
      [
        'examples/voxel-sandbox/server/router.mjs',
        `--data=${data}`,
        `--port=${routerPort}`,
        `--shard-port=${shardPort}`,
        '--origins=*',
        `--public-url=ws://127.0.0.1:${shardPipePort()}/s/{i}`,
        ...(BOTS ? [`--per-identity=${BOTS + 16}`] : []),
      ],
      { cwd: ROOT, stdio: 'ignore' },
    );
  for (let tries = 0; ; tries++) {
    const answer = await fetch(`http://127.0.0.1:${routerPort}/join`).then(
      (r) => r.json(),
      () => ({}),
    );
    if (answer.url) break;
    if (tries > 120) throw new Error('the router never found a shard');
    // fixed-wait: polling the router, which has no event for its first shard being ready
    await sleep(250);
  }
  const bots = BOTS
    ? spawn(process.execPath, [import.meta.filename, `--bot-child=ws://127.0.0.1:${shardPort}`, `--bots=${BOTS}`], {
        cwd: ROOT,
        stdio: 'ignore',
      })
    : undefined;
  // fixed-wait: the bots settle in; there is no event for "the shard is busy"
  if (BOTS) await sleep(8000);
  return {
    routerPort,
    shardPort,
    close: async () => {
      if (bots) await killTree(bots);
      await killTree(child);
      rmSync(data, { recursive: true, force: true });
    },
  };
}

// The CPU slowdown on the page and on every worker it starts.
async function throttle(context, page, rate) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  if (rate === 1) return cdp;
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    const send = (method, params = {}) =>
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method, params }) });
    if (targetInfo.type === 'worker')
      send('Emulation.setCPUThrottlingRate', { rate }).finally(() => send('Runtime.runIfWaitingForDebugger'));
    else send('Runtime.runIfWaitingForDebugger');
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  return cdp;
}

const cpuTimes = () => cpus().reduce((a, c) => [a[0] + c.times.idle, a[1] + c.times.user + c.times.sys], [0, 0]);

async function run(browser, name, profile, pipes, router, repeat) {
  const context = await browser.newContext(profile.context),
    page = await context.newPage(),
    outside = [],
    errors = [];
  await context.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname) && !url.protocol.startsWith('data'),
    (route) => {
      outside.push(route.request().url());
      return route.abort();
    },
  );
  page.on('pageerror', (e) => errors.push(e.message));
  await throttle(context, page, profile.cpu);
  const url = `http://127.0.0.1:${pipes.page.port}/plaza/?plaza=http://127.0.0.1:${pipes.router.port}&timing${profile.query ?? ''}`,
    cpu0 = cpuTimes();
  await page.goto(url, { waitUntil: 'commit' });
  let timedOut = false;
  await page
    .waitForFunction(() => window.voxelSandbox?.timing?.marks.meshed, null, { timeout: 150_000, polling: 250 })
    .catch(() => {
      timedOut = true;
    });
  const cpu1 = cpuTimes(),
    result = await page.evaluate(async () => {
      const s = window.voxelSandbox,
        t = s?.timing?.read();
      return {
        ...t,
        solo: !s?.online,
        stats: s?.stats(),
        panel: document.getElementById('timing')?.textContent,
        resources: performance
          .getEntriesByType('resource')
          .map((e) => [
            e.name.replace(/^.*\//, ''),
            Math.round(e.startTime),
            Math.round(e.responseEnd),
            e.encodedBodySize,
          ]),
        spin: await (async () => {
          const spin = `const end=performance.now()+200;let n=0;while(performance.now()<end)n++;`,
            worker = new Worker(URL.createObjectURL(new Blob([`${spin}postMessage(n)`]))),
            inWorker = await new Promise((done) => {
              worker.onmessage = (e) => done(e.data);
            });
          worker.terminate();
          return { main: new Function(`${spin}return n`)(), worker: inWorker };
        })(),
      };
    }),
    panel = result.panel;
  if (option('shots')) await page.screenshot({ path: `test-results/plaza-load-${name}-${repeat}.png` });
  await context.close();
  return {
    name,
    repeat,
    timedOut,
    outside,
    errors,
    busy: +((cpu1[1] - cpu0[1]) / (cpu1[1] - cpu0[1] + cpu1[0] - cpu0[0])).toFixed(2),
    panel,
    ...result,
  };
}

const median = (list) => {
  const s = list.filter((v) => v !== undefined).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
};

// --- main
process.chdir(ROOT);
if (option('bot-child')) {
  const { VoxelBot } = await import('@margoengine/voxel-net/bot'),
    { defineBlocks } = await import('./src/blocks.ts'),
    blocks = defineBlocks().blocks,
    bots = [];
  for (let i = 0; i < BOTS; i++) {
    bots.push(
      await VoxelBot.connect({
        url: option('bot-child'),
        blocks,
        name: 'Quiet Otter',
        view: 6,
      }).catch(() => undefined),
    );
    for (const bot of bots) bot?.update?.(0.02);
    await sleep(20);
  }
  setInterval(() => {
    for (const bot of bots) bot?.update?.(0.05);
  }, 50);
  await new Promise(() => {});
}
if (!option('no-build')) {
  rmSync(DIST, { recursive: true, force: true });
  await new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [resolve('node_modules/vite/bin/vite.js'), 'build', '--base=./', '--outDir', DIST, '--emptyOutDir'],
      { cwd: resolve('examples/voxel-sandbox'), stdio: 'inherit' },
    );
    child.once('exit', (code) => (code ? fail(new Error(`vite build exited with ${code}`)) : done()));
  });
}
const wanted = String(option('profiles', Object.keys(PROFILES).join(','))).split(','),
  link = new Link(),
  http = await serve(),
  pipes = {
    page: undefined,
    router: undefined,
    shard: undefined,
  },
  out = option('out') || join('test-results', `plaza-load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
  all = [];
// The router and shard get pipes of their own, whose targets are known only once it runs.
let shardTarget = 0,
  routerTarget = 0;
const relay = (target) => {
  const sockets = new Set(),
    server = createServer((client) => {
      const upstream = createConnection(target(), '127.0.0.1'),
        opens = performance.now() + link.rtt * 2;
      client.setNoDelay(true);
      upstream.setNoDelay(true);
      sockets.add(client).add(upstream);
      client.on('data', (data) => link.send('up', data, upstream, opens));
      upstream.on('data', (data) => link.send('down', data, client));
      for (const [a, b] of [
        [client, upstream],
        [upstream, client],
      ]) {
        a.on('error', () => b.destroy());
        a.on('close', () => setTimeout(() => b.destroy(), link.rtt + 50));
      }
    });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      }),
    ),
  );
};
pipes.page = await relay(() => http.address().port);
pipes.router = await relay(() => routerTarget);
pipes.shard = await relay(() => shardTarget);

const browser = await chromium.launch({
  channel: 'msedge',
  headless: HEADLESS,
  args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
try {
  console.log(`gpu: ${await nvidia()}`);
  for (const name of wanted) {
    const profile = PROFILES[name];
    if (!profile) throw new RangeError(`No profile ${name}; use ${Object.keys(PROFILES)}`);
    link.set(profile);
    for (let i = 0; i < RUNS; i++) {
      // Odd runs: a new world (nothing generated yet). Even runs: the same world again, its area generated.
      for (const temperature of ['cold', 'warm']) {
        let router;
        if (temperature === 'cold') {
          globalThis.router?.close && (await globalThis.router.close());
          router = globalThis.router = await startRouter(() => pipes.shard.port);
          routerTarget = router.routerPort;
          shardTarget = router.shardPort;
        } else router = globalThis.router;
        const result = await run(browser, name, profile, pipes, router, `${temperature}${i}`);
        result.temperature = temperature;
        all.push(result);
        const m = result.marks ?? {};
        console.log(
          `${name} ${temperature}${i}: move ${((m.move ?? 0) / 1000).toFixed(2)} s, all received ${((m.loaded ?? 0) / 1000).toFixed(2)}, drawn ${((m.meshed ?? 0) / 1000).toFixed(2)}, chunks ${result.counts?.chunks}, ${Math.round((result.counts?.chunkBytes ?? 0) / 1024)} KB, busy ${result.busy}${result.solo ? ' SOLO' : ''}${result.timedOut ? ' TIMED OUT' : ''}${result.outside.length ? ` OUTSIDE ${result.outside}` : ''}${result.errors.length ? ` ERRORS ${result.errors}` : ''}`,
        );
        mkdirSync(join(out, '..'), { recursive: true });
        writeFileSync(out, JSON.stringify(all, null, 1));
      }
    }
  }
} finally {
  console.log(`gpu: ${await nvidia()}`);
  await browser.close();
  await globalThis.router?.close();
  for (const p of Object.values(pipes)) p.close();
  http.close();
}
// The medians, one row per phase.
const groups = {};
for (const r of all) (groups[`${r.name} ${r.temperature}`] ??= []).push(r);
const keys = [
    'html',
    'js',
    'probe',
    'module',
    'adapter',
    'device',
    'engine',
    'setup',
    'frame',
    'join',
    'open',
    'welcome',
    'chunk',
    'spawn',
    'pipelines',
    'draw',
    'move',
    'near',
    'loaded',
    'meshed',
  ],
  names = Object.keys(groups),
  lines = [`| phase (s, median) | ${names.join(' | ')} |`, `| --- |${names.map(() => ' --- |').join('')}`];
for (const key of keys)
  lines.push(
    `| ${key} | ${names
      .map((n) => {
        const value = median(groups[n].map((r) => r.marks?.[key]));
        return value === undefined ? '-' : (value / 1000).toFixed(2);
      })
      .join(' | ')} |`,
  );
writeFileSync(out.replace(/\.json$/, '.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
console.log(`Wrote ${out}`);
process.exit(0);

async function nvidia() {
  return new Promise((done) => {
    const child = spawn('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('error', () => done('no nvidia-smi'));
    child.on('close', () => done(text.trim()));
  });
}
