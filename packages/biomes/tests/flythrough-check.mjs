// Goal G3 as a budget test (run from the repository root after building packages):
//   node packages/biomes/tests/flythrough-check.mjs
// A 300 km/h flight over the zero-configuration world with tiles made by workers as the camera goes must add at most
// 0.3 ms to the slowest 1 percent of frames and at most 1 ms to the worst frame, against the same flight with every
// tile made before it starts; the page's copying of arrived tiles stays within its 0.25 ms frame budget (one tile at a
// time when a single tile takes longer, reported). Writes test-results/biomes-flythrough.json.
// A timing test: it holds the GPU exclusively (scripts/gpu-lock.mjs), so no other suite draws while it measures. Once
// it ran in a shared slot beside other agents' GPU tests and the worst frame grew by 2.6 ms (alone: +0.1 to +0.3 ms).
// Inside a shared hold the request throws; check:gpu-packages runs it as its own step under the exclusive lock.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { MAX_LIMIT, P99_LIMIT, settle } from './flythrough-limits.mjs';

const quantile = (list, q) => {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const summary = (run) => ({
  frames: run.times.length,
  p50: quantile(run.times, 0.5),
  p99: quantile(run.times, 0.99),
  max: Math.max(...run.times),
  intervalP99: quantile(run.intervals, 0.99),
  intervalMax: Math.max(...run.intervals),
  // Page-thread copying per arrived tile, and per frame that copied any.
  tileP50: run.tiles.length ? quantile(run.tiles, 0.5) : 0,
  tileP99: run.tiles.length ? quantile(run.tiles, 0.99) : 0,
  tileMax: run.tiles.length ? Math.max(...run.tiles) : 0,
  copyMax: run.copies.length ? Math.max(...run.copies) : 0,
});

const release = await acquire({
  owner: 'biomes-flythrough',
  mode: 'exclusive',
  timing: 'biomes flight frame-time budgets',
  max: 15,
});
const context = await openBrowser({ startPath: '/packages/biomes/tests/flythrough-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
  // The page's line per flight (six real-time flights, about 40 s each on the A6000 PC).
  else if (m.type() === 'info' && m.text().startsWith('flight ')) console.log(m.text());
});
await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    // Regression: a frame that planned new tiles sent every job at once, outside the copy budget, and a terrain tile
    // went in whole (192 kB of texture writes) in one step; on a laptop APU (Ryzen 7 7735HS, Radeon 680M) those frames
    // were the slowest 1 percent. With each send slowed to 2 ms and texture writes to 0.02 ms per kB (a whole tile
    // 3.8 ms, a band of rows 1 ms), the view's work per frame must stay within one send plus 1.5 ms (its 0.25 ms budget,
    // the plan, one step that began inside the budget), not one send per job planned or a whole tile.
    // The check once counted time the thread did not run inside its own busy waits as view work: on an Intel Arc 140V
    // laptop the thread stopped 2.9 ms inside the wait before a 16 kB r32float write (the write itself took 0.1 ms or
    // less) and the frame read 4.0 ms. The frame time leaves that out now and reports it (flythrough-clock.mjs); time
    // lost inside the view or a real write still counts.
    const SEND = 2,
      slow = await page.evaluate(([send, copy]) => window.check.slowSends(send, copy), [SEND, 0.02]);
    console.log(
      `slow sends: ${slow.sends} sends over ${slow.frames} frames, view frame max ${slow.max.toFixed(1)} ms (${slow.rawMax.toFixed(1)} ms on the clock; the thread did not run ${slow.stalled.toFixed(1)} ms inside the check's waits, in ${slow.stalls} frames, at most ${slow.stalledMax.toFixed(1)} ms in one)`,
    );
    console.log(
      `slowest texture write calls: ${Object.entries(slow.calls)
        .map(([format, ms]) => `${format} ${ms.toFixed(1)} ms`)
        .join(', ')}`,
    );
    // The worst frame taken apart, so a frame over the limit names its cause: two sends or a whole tile (about 200 kB)
    // in one frame is the view's scheduling, a slow real call is the browser or driver, neither is the view's own code.
    const w = slow.worst,
      worst = !w
        ? 'no frames'
        : `${w.own.toFixed(1)} ms of view time (${w.total.toFixed(1)} ms on the clock, ${w.stalled.toFixed(1)} ms not run inside the waits): ${w.sends} sends, ${w.writes} texture writes of ${w.kB.toFixed(0)} kB, ${w.calls.toFixed(1)} ms in the real postMessage and writeTexture calls`;
    console.log(`slow sends worst frame: ${worst}`);
    assert.ok(slow.sends >= 8, `the flight sent ${slow.sends} jobs`);
    assert.ok(
      slow.max <= SEND + 1.5,
      `the view spent ${slow.max.toFixed(1)} ms in one frame with ${SEND} ms sends: jobs or a whole tile went in beyond the frame budget (worst frame ${worst})`,
    );
    // Regression: a frame that planned also sent its new jobs and copied tiles in; plans come every few frames, and on a
    // laptop APU those frames were the slowest 1 percent (p99 +0.3 ms, at the limit). A frame that plans must send and
    // copy nothing, unless the frame before planned and did nothing too.
    // The check once counted a frame as planning when jobs on their way grew, so a plan that started no job looked like
    // a frame that did nothing; it counts the view's own plans now.
    const plan = await page.evaluate(() => window.check.planFrames());
    console.log(
      `plan frames: ${plan.plans} frames planned, ${plan.both} of them also sent or copied, ${plan.after} right after a plan`,
    );
    assert.ok(plan.plans >= 5, `the flight planned ${plan.plans} times`);
    assert.equal(plan.both, 0, `${plan.both} frames that planned also sent or copied`);
    assert.equal(plan.after, 0, `${plan.after} frames planned right after a frame that planned`);
    // Regression: the plan of a camera that stays put came every 30th frame, so it could fall the frame after a plan of
    // the moving camera, and that second plan sent and copied in the same frame (a laptop APU failed 1 run in 5 on it).
    // It comes 30 frames after the last plan now: a camera that plans every 29 frames never plans twice in a row.
    const beat = await page.evaluate(() => window.check.heartbeat());
    console.log(`plan every 29 frames: ${beat.plans} plans, ${beat.after} right after a plan`);
    assert.ok(beat.plans >= 8, `the camera planned ${beat.plans} times`);
    assert.equal(beat.after, 0, `${beat.after} frames planned right after a frame that planned`);
    // Regression: a step started whenever any budget was left, so a 2 ms send went out after a cheap copy step in the
    // same frame and the frame ran a whole send past its budget. A send now starts only when the budget left covers what
    // a send took lately: with sends of 2 ms and copying at full speed, a send goes first in its frame, after no texture
    // write, objects step or other job. The first send the view makes in a frame has no cost to go by yet (sends while
    // the view loads go out at once, not in frames), so it may follow another step: the count starts after it.
    const fast = await page.evaluate((send) => window.check.slowSends(send, 0), SEND);
    console.log(`fast copies, slow sends: ${fast.sends} sends, ${fast.late} after another step in their frame`);
    assert.ok(fast.sends >= 8, `the flight sent ${fast.sends} jobs`);
    assert.equal(fast.late, 0, `${fast.late} sends started after another step in the same frame`);
    // Regression: the view learned what a send costs from every send step, and a step that only queued its job behind a
    // busy worker costs microseconds: with workers stalled for seconds (a laptop's busy workers) a run of queued sends
    // faded the estimate until a send that woke a worker started late in a frame (late 1 in 3 of 5 runs before, on the
    // laptop APU in 3 of 6). Only sends that reached a worker count now.
    let stalled = 0;
    for (let i = 0; i < 2; i++) {
      const s = await page.evaluate((send) => window.check.slowSends(send, 0, 3000), SEND);
      console.log(`stalled workers: ${s.sends} sends, ${s.late} after another step in their frame`);
      assert.ok(s.sends >= 8, `the flight sent ${s.sends} jobs`);
      stalled += s.late;
    }
    assert.equal(stalled, 0, `${stalled} sends started after another step in the same frame with stalled workers`);
    // Regression: a copy step started only when the budget left covered the dearest copy step seen lately, so after one
    // dear step (a detail map, a pool growth) each frame stopped after one cheap step and copying spread over four times
    // as many frames (prefetched flights: view p50 0.2 ms, was 0.0). Copying goes on while budget is left: with detail
    // map writes slowed by 1 ms, no frame that copied stops short of its budget while copy steps wait.
    const pack = await page.evaluate(() => window.check.packing(1));
    console.log(`packing: ${pack.copied} frames copied, ${pack.short} stopped short of the budget with steps waiting`);
    assert.ok(pack.copied >= 20, `${pack.copied} frames copied`);
    assert.equal(pack.short, 0, `${pack.short} frames stopped copying with budget left and copy steps waiting`);
    // MARGO_BIOMES_WORKERS sets the worker count of the flights (default: the world's default, at most 4).
    const r = await page.evaluate(
        (workers) => window.check.run(workers),
        Number(process.env.MARGO_BIOMES_WORKERS) || 0,
      ),
      median = (list) => [...list].sort((a, b) => a - b)[list.length >> 1],
      streamed = r.streamed.map(summary),
      prefetched = r.prefetched.map(summary),
      of = (runs, key) => median(runs.map((s) => s[key])),
      result = {
        workers: r.workers,
        streamed,
        prefetched,
        // Median over the three flights of each kind.
        p99Added: of(streamed, 'p99') - of(prefetched, 'p99'),
        maxAdded: of(streamed, 'max') - of(prefetched, 'max'),
        tileP99: of(streamed, 'tileP99'),
        tileMax: Math.max(...streamed.map((s) => s.tileMax)),
        objects: [...r.streamed, ...r.prefetched].map((f) => f.objects),
      };
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/biomes-flythrough.json', JSON.stringify({ hardware, result }, null, 1));
    console.log(JSON.stringify({ ...result, streamed: undefined, prefetched: undefined }, null, 1));
    for (const [kind, runs] of [
      ['streamed', streamed],
      ['prefetched', prefetched],
    ])
      for (const s of runs)
        console.log(
          kind,
          `p99 ${s.p99.toFixed(1)} ms, worst ${s.max.toFixed(1)} ms, tile p99 ${s.tileP99.toFixed(2)} ms`,
        );
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(pageErrors, []);
    assert.ok(r.workers > 0, 'the world made its tiles on workers');
    // Frame timestamps never run backwards (an interval from performance.now() once did, and render refused its delta).
    for (const f of [...r.streamed, ...r.prefetched])
      assert.ok(
        f.intervals.every((i) => i >= 0),
        `a negative frame interval: ${Math.min(...f.intervals)} ms`,
      );
    assert.ok(
      streamed.every((s) => s.frames > 600),
      `real-time flights of ${streamed.map((s) => s.frames)} frames`,
    );
    assert.ok(
      settle(result.p99Added) <= P99_LIMIT,
      `streaming added ${result.p99Added.toFixed(3)} ms to the 99th percentile frame`,
    );
    assert.ok(
      settle(result.maxAdded) <= MAX_LIMIT,
      `streaming added ${result.maxAdded.toFixed(3)} ms to the worst frame`,
    );
    console.log(
      `ok biomes flythrough: p99 +${result.p99Added.toFixed(2)} ms, worst +${result.maxAdded.toFixed(2)} ms (medians of 3 flights each)`,
    );
  },
  async () => {
    try {
      await context.close();
    } finally {
      release();
    }
  },
);
// Every check printed OK on a laptop and the suite then sat until the runner killed it (600 s): what is open is named.
watchExit();
