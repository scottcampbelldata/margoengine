// DIAGNOSTIC (temporary, never land): which work makes one frame of flythrough-check's slowSends flight (2 ms sends,
// 0.02 ms per kB texture writes) take about 5.7 ms on a slow laptop, where the check allows 3.5.
//   node scripts/gpu-lock.mjs run --owner=<id> --max=20 -- node packages/biomes/tests/flythrough-spike.mjs
// Env: FLIGHTS (default 8), PACE (ms of idle wait before each frame, as a slow GPU makes the page wait; default 0), THROTTLE (CPU throttling rate, default none), TRACE=0 (no Chrome trace), SLOW (ms, frames
// at or over it are broken down, default 3).
// Per flight: frames, sends, view frame max. Per slow frame: every step with its start and length, the time no step
// accounts for, the longest stall inside a simulated send or write (the thread not running), the heap change, and the
// Chrome trace events (GC, compiles) on the page thread inside the frame. Writes test-results/biomes-spike.json.
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const FLIGHTS = Number(process.env.FLIGHTS ?? 8),
  SLOW = Number(process.env.SLOW ?? 3),
  TRACE = process.env.TRACE !== '0';
const context = await openBrowser({
    startPath: '/packages/biomes/tests/flythrough-spike.html',
    port: 'free',
    args: ['--enable-precise-memory-info'],
  }),
  { page, browser, hardware } = context;
page.on('pageerror', (e) => console.log('pageerror', e.message));
const out = { hardware, flights: [] };
const f2 = (v) => v.toFixed(2);
try {
  console.log(
    'adapter',
    JSON.stringify(hardware.webgpu),
    'cores',
    await page.evaluate(() => navigator.hardwareConcurrency),
  );
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  const cdp = await page.context().newCDPSession(page);
  if (process.env.THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE) });
  for (let f = 0; f < FLIGHTS; f++) {
    const b = browser ?? page.context().browser();
    if (TRACE)
      await b.startTracing(page, {
        categories: [
          'devtools.timeline',
          'blink.user_timing',
          'v8',
          'disabled-by-default-v8.gc',
          'disabled-by-default-v8.compile',
        ],
      });
    const r = await page.evaluate((pace) => window.spike(2, 0.02, pace), Number(process.env.PACE ?? 0));
    const events = [];
    if (TRACE) {
      const trace = JSON.parse((await b.stopTracing()).toString('utf8')),
        list = trace.traceEvents ?? trace,
        marks = new Map();
      let tid = -1;
      for (const e of list)
        if (e.cat?.includes('blink.user_timing') && /^v[se]\d+_\d+$/.test(e.name)) {
          marks.set(e.name, e.ts);
          tid = e.tid;
        }
      // Complete events (and begin/end pairs) on the page thread.
      const open = new Map();
      for (const e of list) {
        if (e.tid !== tid) continue;
        if (e.ph === 'X' && e.dur > 0) events.push({ name: e.name, ts: e.ts, dur: e.dur });
        else if (e.ph === 'B') open.set(e.name, e.ts);
        else if (e.ph === 'E' && open.has(e.name)) {
          events.push({ name: e.name, ts: open.get(e.name), dur: e.ts - open.get(e.name) });
          open.delete(e.name);
        }
      }
      for (const fr of r.frames) {
        const s = marks.get(`vs${r.flight}_${fr.i}`),
          e = marks.get(`ve${r.flight}_${fr.i}`);
        fr.trace = s === undefined || e === undefined ? null : { s, e };
      }
    }
    const max = Math.max(...r.frames.map((fr) => fr.total)),
      sends = r.frames.reduce((a, fr) => a + fr.posts, 0),
      slow = r.frames.filter((fr) => fr.total >= SLOW),
      gapMax = Math.max(...r.frames.map((fr) => fr.gap));
    console.log(
      `flight ${f}: ${r.frames.length} frames in ${(r.wall / 1000).toFixed(1)} s, ${sends} posts in frames, view frame max ${f2(max)} ms, ${slow.length} frames >= ${SLOW} ms, longest stall in a spin ${f2(gapMax)} ms`,
    );
    if (TRACE) {
      // Garbage collection on the page thread: top-level GC events (MinorGC, MajorGC and V8.GC* pauses), anywhere in
      // the flight and inside view frames.
      const gc = events.filter((e) =>
          /^(MinorGC|MajorGC|V8\.GC_(SCAVENGER|MC_COMPLETE|MARK_COMPACTOR|MINOR_MC)$|V8\.GCScavenger|V8\.GCFinalizeMC|V8\.GCCompactor)/.test(
            e.name,
          ),
        ),
        names = new Map();
      for (const e of gc)
        names.set(e.name, [(names.get(e.name)?.[0] ?? 0) + 1, Math.max(names.get(e.name)?.[1] ?? 0, e.dur / 1000)]);
      let inFrames = 0,
        worst = 0;
      for (const fr of r.frames) {
        if (!fr.trace) continue;
        const t = gc
          .filter((e) => e.ts < fr.trace.e && e.ts + e.dur > fr.trace.s && /^(MinorGC|MajorGC)$/.test(e.name))
          .reduce((a, e) => a + e.dur / 1000, 0);
        fr.gc = t;
        fr.traced = true;
        if (t > 0) inFrames++;
        worst = Math.max(worst, t);
      }
      console.log(
        `  GC (${r.frames.filter((x) => x.traced).length} frames traced): ${[...names].map(([n, [c, m]]) => `${n} x${c} max ${f2(m)}`).join(', ')}; view frames with GC ${inFrames}, most GC in one ${f2(worst)} ms; traced view time ${f2(r.frames.reduce((a, x) => a + (x.trace ? (x.trace.e - x.trace.s) / 1000 : 0), 0))} ms vs measured ${f2(r.frames.reduce((a, x) => a + x.total, 0))} ms; GC within 1 ms of a view frame ${gc.filter((e) => /^(MinorGC|MajorGC)$/.test(e.name) && r.frames.some((x) => x.trace && e.ts < x.trace.e + 1000 && e.ts + e.dur > x.trace.s - 1000)).length}`,
      );
    }
    const flight = { flight: f, wall: r.wall, frames: r.frames.length, max, sends, slow: [] };
    for (const fr of slow) {
      // Top-level steps (a post inside a run, a write inside an objects step are parts of it).
      const parent = (b, a) =>
          (b[0].startsWith('run:') && a[0].startsWith('post:')) ||
          (b[0].startsWith('obj:') && !a[0].startsWith('obj:')),
        top = fr.ev.filter(
          (a) =>
            !fr.ev.some((b) => b !== a && parent(b, a) && b[1] <= a[1] + 0.05 && b[1] + b[2] >= a[1] + a[2] - 0.05),
        );
      const accounted = top.reduce((a, s) => a + s[2], 0),
        inside = fr.trace
          ? events
              .filter((e) => e.ts < fr.trace.e && e.ts + e.dur > fr.trace.s && e.dur >= 100)
              .map((e) => `${e.name} ${(e.dur / 1000).toFixed(2)}`)
          : [];
      const line = {
        i: fr.i,
        total: fr.total,
        plan: fr.plan,
        arrived: fr.arrived,
        posts: fr.posts,
        stall: fr.gap,
        unaccounted: fr.total - accounted,
        heapMB: (fr.h1 - fr.h0) / 1048576,
        steps: fr.ev.map(
          ([k, at, d, kb, real]) =>
            `${k}@${f2(at)}+${f2(d)}${kb ? ` ${kb}kB` : ''}${real === undefined ? '' : ` (real ${f2(real)})`}`,
        ),
        trace: [...new Set(inside)].slice(0, 30),
      };
      flight.slow.push(line);
      console.log(
        `  frame ${fr.i}: ${f2(fr.total)} ms interval ${f2(fr.iv)} plan=${fr.plan} arrived=${fr.arrived} pending=${fr.pending} posts=${fr.posts} stall=${f2(fr.gap)} unaccounted=${f2(line.unaccounted)} heap ${line.heapMB.toFixed(2)} MB`,
      );
      console.log(`    steps: ${line.steps.join(', ')}`);
      if (line.trace.length) console.log(`    trace (>=0.1 ms): ${line.trace.join(', ')}`);
    }
    out.flights.push(flight);
  }
} finally {
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/biomes-spike.json', JSON.stringify(out, null, 1));
  await context.close();
}
