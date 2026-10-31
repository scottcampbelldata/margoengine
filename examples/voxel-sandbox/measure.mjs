// Plaza frame-time measure: per-pass GPU times (timestamp queries added from outside the page, so it works on any build,
// the live one included), frame CPU, frame interval, draw counts and walking speed, written to one file you can send.
//   node examples/voxel-sandbox/measure.mjs --live                         the live build, this machine's GPU, headed
//   node examples/voxel-sandbox/measure.mjs --local [--headless]           this checkout through the dev server
//   node examples/voxel-sandbox/measure.mjs --url=https://host/plaza/      any build
// Options: --size=1920x1080 (default on --local; a headed --live run uses the maximised window), --server=ws://host:port
// (online run against that shard instead of the page's router), --lag=ms (only with --server: a TCP pipe adding that delay
// each way), --only=poses,solo,online,speed, --out=file, --seconds=6.
// Run it from a checkout (it uses that checkout's @playwright/test and drives installed Edge). The result goes to
// test-results/plaza-measure-<computer>-<time>.json and .md, or --out.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { closeAll } from '../../scripts/support/shutdown.mjs';

const option = (name, fallback) => {
    const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    return hit === undefined ? fallback : hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  },
  LIMIT_MINUTES = Number(option('limit', 15)),
  LIVE = 'https://plaza.margoengine.com/plaza/',
  local = !!option('local'),
  seconds = Number(option('seconds', 6)),
  only = String(option('only', 'poses,solo,online,speed')).split(','),
  headless = !!option('headless'),
  lag = Number(option('lag', 0)),
  serverOption = option('server');
let base = option('url') || (option('live') ? LIVE : undefined);
if (!base && !local) {
  console.error('Say which build: --live, --local or --url=https://host/plaza/');
  process.exit(2);
}
const size = option('size', local ? '1920x1080' : undefined)
  ?.split('x')
  .map(Number);

// The poses (seed 1, no network, sun held still): Scott's canopy reading, then the sky, along the ground towards the
// plaza, down, and a high view over everything. x,y,z,yaw,pitch; y 0 stands on the ground at eye height.
const POSES = {
  canopy: '-41.3,17.62,18.3,3.14,1.0',
  sky: '2.5,0,2.5,0,1.5',
  horizon: '-41.3,0,18.3,-1.1,0.02',
  down: '-41.3,0,18.3,3.14,-1.4',
  high: '-60,42,70,2.6,-0.2',
};

// Runs in the page before any of its scripts. Adds timestamp writes to every pass while `__m.on`, counts draws (render
// bundles too), times copies between two empty compute passes, and the time from submit to the GPU finishing.
function instrument() {
  const S = (window.__m = {
      on: false,
      frames: [],
      intervals: [],
      submit: [],
      names: {},
      burn: 0,
      frame: 0,
      long: 0,
    }),
    views = new WeakMap(),
    bundles = new WeakMap(),
    CAP = 512;
  let device, set, resolveBuffer;
  const free = [];
  let frame = { n: 0, passes: [] },
    cur;
  const patch = (proto, name, wrap) => {
    const original = proto[name];
    proto[name] = function (...args) {
      return wrap.call(this, original, args);
    };
  };
  patch(GPUAdapter.prototype, 'requestDevice', async function (original, [d = {}]) {
    const features = [...(d.requiredFeatures ?? [])];
    if (this.features.has('timestamp-query') && !features.includes('timestamp-query')) features.push('timestamp-query');
    device = await original.call(this, { ...d, requiredFeatures: features });
    S.timestamps = device.features.has('timestamp-query');
    S.adapter = this.info
      ? { vendor: this.info.vendor, architecture: this.info.architecture, description: this.info.description }
      : {};
    return device;
  });
  patch(GPUTexture.prototype, 'createView', function (original, args) {
    const view = original.apply(this, args);
    views.set(view, this);
    return view;
  });
  const raf = window.requestAnimationFrame.bind(window);
  let lastTime = 0;
  window.requestAnimationFrame = (callback) =>
    raf((time) => {
      if (time !== lastTime) {
        S.frame++;
        if (S.on && lastTime) S.intervals.push(time - lastTime);
        lastTime = time;
        if (S.burn) {
          const until = performance.now() + S.burn;
          while (performance.now() < until);
        }
      }
      callback(time);
    });
  try {
    new PerformanceObserver((list) => {
      if (S.on) for (const e of list.getEntries()) S.long += e.duration;
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  const ready = () => {
    if (!S.timestamps) return false;
    set ??= device.createQuerySet({ type: 'timestamp', count: CAP });
    resolveBuffer ??= device.createBuffer({
      size: CAP * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    return frame.n + 2 <= CAP;
  };
  const describe = (d) => {
    const c = d.colorAttachments?.find(Boolean),
      z = d.depthStencilAttachment,
      t = views.get(c?.view ?? z?.view);
    return `${c ? t?.format : 'depth'}${d.colorAttachments?.length > 1 ? `+${d.colorAttachments.length - 1}` : ''} ${t?.width}x${t?.height} s${t?.sampleCount ?? 1}${z ? ` z:${z.depthLoadOp ?? 'ro'}` : ''}`;
  };
  const place = (kind, signature) => {
    const seen = frame.passes.filter((p) => p.signature === signature).length,
      key = `${signature} #${seen}`;
    if (!S.names[key]) {
      const stack = new Error().stack ?? '',
        hit = /\/packages\/([\w-]+)\/[^\s)]*/.exec(stack) ?? /\/examples\/([\w-]+)\/[^\s)]*/.exec(stack);
      S.names[key] = hit ? hit[1] : kind;
    }
    const pass = { key, kind, signature, at: frame.n, draws: 0, zero: 0, indirect: 0, indices: 0, bundles: 0 };
    frame.n += 2;
    frame.passes.push(pass);
    return pass;
  };
  patch(GPUCommandEncoder.prototype, 'beginRenderPass', function (original, [d]) {
    if (!S.on || !ready() || d.timestampWrites) return original.call(this, d);
    cur = place('render', describe(d));
    return original.call(this, {
      ...d,
      timestampWrites: { querySet: set, beginningOfPassWriteIndex: cur.at, endOfPassWriteIndex: cur.at + 1 },
    });
  });
  const plainCompute = GPUCommandEncoder.prototype.beginComputePass;
  patch(GPUCommandEncoder.prototype, 'copyTextureToTexture', function (original, args) {
    if (!S.on || !ready()) return original.apply(this, args);
    const t = args[0].texture,
      p = place('copy', `copy ${t?.width}x${t?.height}x${args[2].depthOrArrayLayers ?? 1} ${t?.format}`),
      stamp = (index) =>
        plainCompute.call(this, { timestampWrites: { querySet: set, beginningOfPassWriteIndex: index } }).end();
    stamp(p.at);
    const result = original.apply(this, args);
    stamp(p.at + 1);
    return result;
  });
  patch(GPUCommandEncoder.prototype, 'beginComputePass', function (original, [d = {}]) {
    if (!S.on || !ready() || d.timestampWrites) return original.call(this, d);
    cur = place('compute', 'compute');
    return original.call(this, {
      ...d,
      timestampWrites: { querySet: set, beginningOfPassWriteIndex: cur.at, endOfPassWriteIndex: cur.at + 1 },
    });
  });
  const count = (proto, name, f) =>
    patch(proto, name, function (original, args) {
      if (S.on && cur) f(cur, args);
      return original.apply(this, args);
    });
  const P = GPURenderPassEncoder.prototype;
  count(P, 'draw', (c, [n, i = 1]) => {
    c.draws++;
    c.indices += n * i;
  });
  count(P, 'drawIndexed', (c, [n, i = 1]) => {
    c.draws++;
    c.indices += n * i;
  });
  count(P, 'drawIndirect', (c) => c.indirect++);
  count(P, 'drawIndexedIndirect', (c) => c.indirect++);
  patch(P, 'executeBundles', function (original, [list]) {
    if (S.on && cur)
      for (const b of list) {
        cur.bundles++;
        cur.indirect += bundles.get(b)?.indirect ?? 0;
        cur.draws += bundles.get(b)?.draws ?? 0;
      }
    return original.call(this, list);
  });
  const B = GPURenderBundleEncoder.prototype,
    tally = new WeakMap(),
    of = (e) => {
      let t = tally.get(e);
      if (!t) tally.set(e, (t = { draws: 0, indirect: 0 }));
      return t;
    };
  patch(B, 'drawIndexedIndirect', function (original, args) {
    of(this).indirect++;
    return original.apply(this, args);
  });
  patch(B, 'drawIndirect', function (original, args) {
    of(this).indirect++;
    return original.apply(this, args);
  });
  patch(B, 'drawIndexed', function (original, args) {
    of(this).draws++;
    return original.apply(this, args);
  });
  patch(B, 'draw', function (original, args) {
    of(this).draws++;
    return original.apply(this, args);
  });
  patch(B, 'finish', function (original, args) {
    const bundle = original.apply(this, args);
    bundles.set(bundle, of(this));
    return bundle;
  });
  patch(GPUQueue.prototype, 'submit', function (original, [buffers]) {
    if (!S.on || !frame.n) return original.call(this, buffers);
    const done = frame,
      encoder = device.createCommandEncoder(),
      read =
        free.pop() ?? device.createBuffer({ size: CAP * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    frame = { n: 0, passes: [] };
    cur = undefined;
    encoder.resolveQuerySet(set, 0, done.n, resolveBuffer, 0);
    encoder.copyBufferToBuffer(resolveBuffer, 0, read, 0, done.n * 8);
    const start = performance.now(),
      result = original.call(this, [...buffers, encoder.finish()]);
    this.onSubmittedWorkDone().then(() => S.on && S.submit.push(performance.now() - start));
    read.mapAsync(GPUMapMode.READ, 0, done.n * 8).then(() => {
      const t = new BigInt64Array(read.getMappedRange(0, done.n * 8).slice(0));
      read.unmap();
      free.push(read);
      if (!S.on) return;
      const out = [];
      for (const p of done.passes)
        out.push({ ...p, ms: Number(t[p.at + 1] - t[p.at]) / 1e6, start: Number(t[p.at]) / 1e6 });
      S.frames.push(out);
    });
    return result;
  });
}

const median = (list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (list, q) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const round = (v, d = 2) => +v.toFixed(d);

/** One sample: `seconds` of frames with the timestamps on; the page's voxelSandbox stats around it. */
async function sample(page, label) {
  const raw = await page.evaluate(async (ms) => {
    const S = window.__m,
      sandbox = window.voxelSandbox,
      shadows = sandbox.scene?.shadows,
      hits = shadows?.stats?.cacheHits ?? 0,
      first = S.frame;
    S.frames = [];
    S.intervals = [];
    S.submit = [];
    S.long = 0;
    const cpuPromise = sandbox.frames(Math.max(10, Math.round((ms / 1000) * 20)));
    S.on = true;
    // fixed-wait: a measuring window, its length is what is being sampled
    await new Promise((done) => setTimeout(done, ms));
    S.on = false;
    const cpu = await Promise.race([cpuPromise, new Promise((done) => setTimeout(() => done([]), 3000))]);
    return {
      frames: S.frames,
      intervals: S.intervals,
      submit: S.submit,
      long: S.long,
      names: S.names,
      cpu,
      renders: S.frame - first,
      cacheHits: (shadows?.stats?.cacheHits ?? 0) - hits,
      staticDraws: shadows?.stats?.staticDraws ?? 0,
      stats: sandbox.stats(),
      look: sandbox.look,
      position: [...(sandbox.player?.position ?? [])],
      timestamps: S.timestamps,
      adapter: S.adapter,
      overlay: document.getElementById('overlay')?.hidden === false,
    };
  }, seconds * 1000);
  const passes = {},
    totals = [];
  for (const frame of raw.frames) {
    let sum = 0,
      begin = Infinity,
      end = 0;
    for (const p of frame) {
      const e = (passes[p.key] ??= {
        name: raw.names[p.key],
        kind: p.kind,
        ms: [],
        draws: p.draws,
        indirect: p.indirect,
        indices: p.indices,
        bundles: p.bundles,
      });
      e.ms.push(p.ms);
      e.draws = Math.max(e.draws, p.draws);
      e.indirect = Math.max(e.indirect, p.indirect);
      e.indices = Math.max(e.indices, p.indices);
      sum += p.ms;
      begin = Math.min(begin, p.start);
      end = Math.max(end, p.start + p.ms);
    }
    totals.push({ sum, span: end - begin });
  }
  const table = Object.entries(passes).map(([key, e]) => ({
    pass: e.name,
    key,
    framesWithIt: e.ms.length,
    medianMs: round(median(e.ms), 3),
    p95Ms: round(quantile(e.ms, 0.95), 3),
    draws: e.draws,
    indirect: e.indirect,
    indices: e.indices,
  }));
  const interval = median(raw.intervals);
  const result = {
    label,
    fps: round(interval ? 1000 / interval : 0, 1),
    frameIntervalMs: { median: round(interval), p95: round(quantile(raw.intervals, 0.95)) },
    frameCpuMs: { median: round(median(raw.cpu)), p95: round(quantile(raw.cpu, 0.95)) },
    gpuSumMs: round(median(totals.map((t) => t.sum))),
    gpuSpanMs: round(median(totals.map((t) => t.span))),
    submitToDoneMs: { median: round(median(raw.submit)), p95: round(quantile(raw.submit, 0.95)) },
    longTaskMs: round(raw.long, 0),
    framesTimed: raw.frames.length,
    shadowCacheHits: raw.cacheHits,
    overlayUp: raw.overlay,
    stats: raw.stats,
    position: raw.position,
    look: raw.look,
    passes: table,
  };
  console.log(
    `${label}: ${result.fps} FPS, CPU ${result.frameCpuMs.median} ms, GPU sum ${result.gpuSumMs} span ${result.gpuSpanMs} ms, submit-to-done ${result.submitToDoneMs.median} ms, draws ${raw.stats.draws}, visible ${raw.stats.visible}/${raw.stats.chunks}`,
  );
  return { result, adapter: raw.adapter, timestamps: raw.timestamps };
}

// Mouse movement under pointer lock until the page's yaw and pitch reach the target (0.0024 radians a pixel). The page
// reads only the movement, so the pointer is never brought back to the middle: that would undo the turn.
const pointer = { x: 400, y: 300 };
async function lookAt(page, yaw, pitch) {
  for (let i = 0; i < 12; i++) {
    const look = await page.evaluate(() => window.voxelSandbox.look),
      dx = Math.max(-200, Math.min(200, (look.yaw - yaw) / 0.0024)),
      dy = Math.max(-200, Math.min(200, (look.pitch - pitch) / 0.0024));
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    pointer.x += dx;
    pointer.y += dy;
    await page.mouse.move(pointer.x, pointer.y);
    // fixed-wait: the page reads pointer-lock movement on its next frame
    await page.waitForTimeout(80);
  }
}

// Ground speed with W held for `ms` at four headings, jumping over small ledges; the best heading is the speed (the rest
// may hit a hill or a tree). Then flight (Keys F, Space to get clear of the ground): the same steps with nothing to hit,
// so it shows lost time on its own. Expected: walk 4.317 blocks/s (jumps do not add to it), fly 11.
async function moved(page, ms) {
  return page.evaluate(async (time) => {
    const sandbox = window.voxelSandbox,
      at = () => [...(sandbox.online?.client.renderPosition ?? sandbox.player.renderPosition)],
      S = window.__m,
      f0 = S.frame,
      a = at(),
      t0 = performance.now();
    // fixed-wait: the length of the run is the measure
    await new Promise((done) => setTimeout(done, time));
    const b = at(),
      t = performance.now() - t0;
    return {
      speed: Math.hypot(b[0] - a[0], b[2] - a[2]) / (t / 1000),
      fps: ((S.frame - f0) * 1000) / t,
      corrections: sandbox.online?.client.stats.corrections ?? 0,
      at: b.map((v) => +v.toFixed(1)),
      chunkHere: !!sandbox.world.getChunk(Math.floor(b[0]) >> 5, Math.floor(b[1]) >> 5, Math.floor(b[2]) >> 5),
      chunkBelow: !!sandbox.world.getChunk(Math.floor(b[0]) >> 5, Math.floor(b[1] - 2) >> 5, Math.floor(b[2]) >> 5),
      flying: sandbox.player.flying,
      locked: document.pointerLockElement?.id === 'scene',
      velocity: [...sandbox.player.velocity].map((v) => +v.toFixed(2)),
      look: sandbox.look,
      at: b.map((v) => +v.toFixed(2)),
      // Solid cells touching the body's box grown by 0.1 (0.6 wide, 1.8 tall): a run near zero with these was stopped by
      // the world, not by lost time.
      touching: (() => {
        const out = [];
        for (const y of [b[1] - 0.05, b[1] + 0.9, b[1] + 1.85])
          for (const dx of [-0.4, 0, 0.4])
            for (const dz of [-0.4, 0, 0.4]) {
              const id = sandbox.world.getBlock(Math.floor(b[0] + dx), Math.floor(y), Math.floor(b[2] + dz));
              if (sandbox.world.blocks.get(id & 0xffff).solid) out.push(sandbox.world.blocks.get(id & 0xffff).name);
            }
        return [...new Set(out)];
      })(),
    };
  }, ms);
}
async function measureWalk(page, label, ms = 2500) {
  const look = await page.evaluate(() => window.voxelSandbox.look),
    rows = [];
  await page.keyboard.down('Space');
  for (const turn of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    await lookAt(page, look.yaw + turn, 0);
    await page.keyboard.down('KeyW');
    // fixed-wait: let the body reach its speed before timing it
    await page.waitForTimeout(600);
    const run = await moved(page, ms);
    await page.keyboard.up('KeyW');
    rows.push({ turn: round(turn), speed: round(run.speed), fps: round(run.fps, 1), corrections: run.corrections });
  }
  await page.keyboard.up('Space');
  await page.keyboard.press('KeyF');
  await page.keyboard.down('Space');
  // fixed-wait: climb clear of the ground
  await page.waitForTimeout(2000);
  await page.keyboard.up('Space');
  await page.keyboard.down('KeyW');
  // fixed-wait: let the body reach its speed before timing it
  await page.waitForTimeout(800);
  const fly = await moved(page, ms);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyF');
  // fixed-wait: fall back to the ground before the next run
  await page.waitForTimeout(2500);
  const best = Math.max(...rows.map((r) => r.speed));
  console.log(
    `${label}: walk ${best} blocks/s best heading (${rows.map((r) => r.speed).join(', ')}), fly ${round(fly.speed)} blocks/s, ${round(fly.fps, 1)} FPS, corrections ${fly.corrections}, locked ${fly.locked} velocity ${fly.velocity} at ${fly.at} look ${JSON.stringify(fly.look)} touching ${fly.touching}`,
  );
  return {
    label,
    best,
    fly: round(fly.speed),
    touching: fly.touching,
    fps: round(fly.fps, 1),
    corrections: fly.corrections,
    rows,
  };
}

async function lock(page) {
  const box = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  pointer.x = box.width / 2;
  pointer.y = box.height / 2;
  await page.mouse.click(pointer.x, pointer.y);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'scene', null, { timeout: 8000 });
  // fixed-wait: the overlay's removal reaches the compositor
  await page.waitForTimeout(300);
}

// A TCP pipe with `ms` of delay each way in front of a local shard.
async function delayPipe(target, ms) {
  const { hostname: host, port } = new URL(target.replace(/^ws/, 'http')),
    server = createServer((a) => {
      const b = createConnection(Number(port), host),
        queue = (from, to) => from.on('data', (data) => setTimeout(() => to.writable && to.write(data), ms));
      queue(a, b);
      queue(b, a);
      a.on('error', () => b.destroy());
      b.on('error', () => a.destroy());
      a.on('close', () => b.destroy());
      b.on('close', () => a.destroy());
    });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `ws://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// A hard limit on the whole run: a browser that stops answering must not hold the GPU or the terminal.
setTimeout(() => {
  console.error(`measure: stopped after ${LIMIT_MINUTES} minutes`);
  process.exit(124);
}, LIMIT_MINUTES * 60_000).unref();
const report = {
  host: hostname(),
  date: new Date().toISOString(),
  argv: process.argv.slice(2),
  base: undefined,
  runs: [],
  walks: [],
};
let stopServer = () => {};
if (local) {
  process.chdir(resolve(import.meta.dirname, '../..'));
  const { startDevServer } = await import(pathToFileURL(resolve('scripts/browser.js')).href),
    port = 5261,
    { close } = await startDevServer({ startPath: '/examples/voxel-sandbox/index.html', port });
  stopServer = close;
  base = `http://127.0.0.1:${port}/examples/voxel-sandbox/index.html`;
}
report.base = base;
const args = ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
try {
  const { gpuAdapterArg } = await import(pathToFileURL(resolve('scripts/lib/gpu-adapter.mjs')).href);
  const arg = await gpuAdapterArg?.();
  if (typeof arg === 'string') args.push(arg);
} catch {
  // No adapter helper in this checkout: Edge picks the adapter.
}
if (!headless) args.push('--start-maximized');
const browser = await chromium.launch({ channel: 'msedge', headless, args });
const context = await browser.newContext(
  size?.every((v) => v > 0) ? { viewport: { width: size[0], height: size[1] } } : { viewport: null },
);
const page = await context.newPage();
await page.addInitScript(instrument);
// The control: how fast this browser runs an empty page. A headless Edge on Windows gave 32 Hz here, so an FPS number means
// nothing above this cadence; the GPU columns do not depend on it.
await page.goto('about:blank');
report.emptyPage = await page.evaluate(
  () =>
    new Promise((done) => {
      const gaps = [];
      let last = 0;
      const tick = (t) => {
        if (last) gaps.push(t - last);
        last = t;
        if (gaps.length < 120) requestAnimationFrame(tick);
        else {
          gaps.sort((a, b) => a - b);
          Promise.resolve(navigator.getBattery?.())
            .then((b) => (b ? { charging: b.charging, level: b.level } : null))
            .catch(() => null)
            .then((battery) =>
              done({
                fps: +(1000 / gaps[60]).toFixed(1),
                screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
                battery: battery ?? null,
              }),
            );
        }
      };
      requestAnimationFrame(tick);
    }),
);
console.log('empty page', report.emptyPage);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const url = (query) => `${base}${base.includes('?') ? '&' : '?'}${query}`;
const SPAWN = { timeout: 180_000, polling: 200 };
const keep = ({ result, adapter, timestamps }) => {
  report.adapter ??= adapter;
  report.timestamps ??= timestamps;
  report.runs.push(result);
};
try {
  if (only.includes('poses'))
    for (const [name, pose] of Object.entries(POSES)) {
      await page.goto(url(`view=ground&pose=${pose}&rd=8&quality=low&seed=1`));
      await page.waitForFunction(() => window.voxelSandbox?.ready, null, SPAWN);
      keep(await sample(page, `pose ${name} (no network, sun still)`));
    }
  const play = async (label, query, poseAt) => {
    await page.goto(url(query));
    await page.waitForFunction(() => window.voxelSandbox?.spawned, null, SPAWN);
    await page.waitForFunction(() => window.voxelSandbox?.ready, null, SPAWN);
    if (poseAt)
      await page.evaluate((p) => {
        window.voxelSandbox.player.position = p;
      }, poseAt);
    keep(await sample(page, `${label}, overlay up`));
    await lock(page);
    keep(await sample(page, `${label}, overlay gone`));
    for (const [name, yaw, pitch] of [
      ['up', 3.14, 1.0],
      ['horizon', -1.1, 0.02],
      ['down', 3.14, -1.4],
    ]) {
      await lookAt(page, yaw, pitch);
      keep(await sample(page, `${label}, looking ${name}`));
    }
    return true;
  };
  if (only.includes('solo'))
    await play('solo', 'plaza=&rd=8&seed=1&reset', [-41.3, 16, 18.3]).catch((error) => {
      report.soloError = String(error);
      console.error(error);
    });
  let shard = serverOption,
    pipe;
  if (shard && lag) {
    pipe = await delayPipe(shard, lag);
    shard = pipe.url;
  }
  if (only.includes('online') && (shard || !local))
    await play('online', shard ? `server=${encodeURIComponent(shard)}&rd=8` : '').catch((error) => {
      report.onlineError = String(error);
      console.error(error);
    });
  if (only.includes('speed')) {
    const speed = async (label, query, burns) => {
      await page.goto(url(query));
      await page.waitForFunction(() => window.voxelSandbox?.spawned, null, SPAWN);
      await lock(page);
      for (const burn of burns) {
        await page.evaluate((ms) => {
          window.__m.burn = ms;
        }, burn);
        report.walks.push(await measureWalk(page, `${label}, main thread burning ${burn} ms a frame`));
      }
      await page.evaluate(() => {
        window.__m.burn = 0;
      });
    };
    if (!lag) await speed('solo', 'plaza=&rd=4&seed=1', [0, 40, 120]);
    if (shard || !local)
      await speed(
        `online${lag ? ` +${lag} ms each way` : ''}`,
        shard ? `server=${encodeURIComponent(shard)}&rd=4` : '',
        [0, 40, 120],
      );
  }
  pipe?.close();
} finally {
  report.errors = errors;
  const out =
    option('out') ||
    join('test-results', `plaza-measure-${hostname()}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 1));
  const lines = [
    `# Plaza measure, ${report.host}, ${report.date}`,
    `Build ${report.base}`,
    `GPU ${JSON.stringify(report.adapter)}, timestamps ${report.timestamps}`,
    `Empty page ${JSON.stringify(report.emptyPage)}`,
    '',
  ];
  for (const r of report.runs) {
    lines.push(
      `## ${r.label}`,
      `${r.fps} FPS (interval ${r.frameIntervalMs.median} ms, p95 ${r.frameIntervalMs.p95}); frame CPU ${r.frameCpuMs.median} ms; GPU passes sum ${r.gpuSumMs} ms, first to last ${r.gpuSpanMs} ms; submit to done ${r.submitToDoneMs.median} ms; long tasks ${r.longTaskMs} ms; shadow cache hits ${r.shadowCacheHits} of ${r.framesTimed} timed frames; canvas ${r.stats.canvas}; tier ${r.stats.tier}; visible ${r.stats.visible} of ${r.stats.chunks}; draws ${r.stats.draws}; quads ${r.stats.quads}`,
      '',
      '| pass | ms median | p95 | frames | draws | indirect | indices |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...r.passes.map(
        (p) =>
          `| ${p.pass} [${p.key}] | ${p.medianMs} | ${p.p95Ms} | ${p.framesWithIt} | ${p.draws} | ${p.indirect} | ${p.indices} |`,
      ),
      '',
    );
  }
  for (const w of report.walks)
    lines.push(
      `${w.label}: walk ${w.best} blocks/s best heading, fly ${w.fly} blocks/s${w.touching?.length ? ` (touching ${w.touching})` : ''}, ${w.fps} FPS, corrections ${w.corrections}`,
    );
  writeFileSync(out.replace(/\.json$/, '.md'), `${lines.join('\n')}\n`);
  console.log(`Wrote ${out} and its .md`);
  await closeAll({ browser });
  await stopServer();
}
