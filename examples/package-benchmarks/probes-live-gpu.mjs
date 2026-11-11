// Real-GPU check of live reflection capture in @margoengine/environment/probes (AC power, GPU lock, after
// npm run build:packages):
//   node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/probes-live-gpu.mjs [--bench]
// probes-live.html: a room of six walls each radiating its linear colour, one 128 px reflection probe at the centre in
// live mode, and a magenta box moved into and out of the probe's +x view.
// 1. Latency: for 1, 2 and 6 faces per frame, and for every point of the 6-face refresh cycle, the frames until the
//    probe's octahedral texel toward the box turns magenta after the box moves in (and back after it moves out). One
//    live probe shows a change within 2 refreshes: 2 * ceil(6 / facesPerFrame) frames.
// 2. Per-frame GPU cost (--bench, quiet-gated): timestamp queries on every pass the capture encodes, per frame, for
//    frames with only faces and frames with the prefilter; the main frame's own passes (Stats); and one bake (six faces
//    plus the full-source convolution) for comparison.
// Writes examples/package-benchmarks/results/probes-live-gpu.json and test-results/probes-live-*.png.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { cpuLoad, waitForQuiet } from '../../scripts/quiet-gate.mjs';
import { powerOnlineText as ac } from './parts/power.mjs';
import { distribution } from '../../scripts/lib/percentile.mjs';

const bench = process.argv.includes('--bench');
const powerBefore = ac();
assert.notEqual(powerBefore, 'False', 'run on AC power only');
const failures = [],
  expect = (ok, message) => {
    if (!ok) {
      failures.push(message);
      console.log('FAIL ' + message);
    }
  };
// Nearest rank (scripts/lib/percentile.mjs); no samples give null, a non-finite sample throws.
const stats = (values) => {
  if (!values.length) return null;
  const d = distribution(values);
  return { count: d.count, median: +d.median.toFixed(4), p95: +d.p95.toFixed(4), max: +d.max.toFixed(4) };
};

const context = await openBrowser({ startPath: '/LICENSE', port: 5274 }),
  { page } = context,
  pageErrors = [];
const report = {
  benchmark: 'probes-live-gpu',
  recordedAt: new Date().toISOString(),
  canvas: [960, 540],
  probe: { resolution: 128, samples: 256 },
  powerOnline: { before: powerBefore },
};
try {
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.goto('http://127.0.0.1:5274/examples/package-benchmarks/probes-live.html', { timeout: 300000 });
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  report.hardware = context.hardware ?? (await page.evaluate(() => navigator.userAgent));
  const into = [1.2, 1.5, 0],
    look = [1, 0, 0];
  report.latency = [];
  for (const facesPerFrame of [1, 2, 6]) {
    const setup = await page.evaluate((o) => window.check.setup(o), { facesPerFrame });
    assert.deepEqual(setup.errors, []);
    expect(setup.refreshes >= 1, `${facesPerFrame} faces/frame: live capture refreshed the probe while warming up`);
    const bound = 2 * Math.ceil(6 / facesPerFrame),
      appear = [],
      vanish = [];
    for (let phase = 0; phase < Math.ceil(6 / facesPerFrame); phase++) {
      await page.evaluate((n) => window.check.skip(n), phase);
      const shown = await page.evaluate((o) => window.check.move(o), { to: into, look, present: true });
      assert.deepEqual(shown.errors, []);
      appear.push(shown.frames);
      if (facesPerFrame === 1 && phase === 0)
        await page
          .locator('canvas[aria-label="Interactive 3D scene"]')
          .screenshot({ path: 'test-results/probes-live-box-in.png' });
      const gone = await page.evaluate((o) => window.check.move(o), { to: null, look, present: false });
      assert.deepEqual(gone.errors, []);
      vanish.push(gone.frames);
    }
    const row = { facesPerFrame, boundFrames: bound, appearFrames: appear, vanishFrames: vanish };
    report.latency.push(row);
    console.log(JSON.stringify(row));
    expect(
      appear.every((n) => n !== null && n <= bound),
      `${facesPerFrame} faces/frame: box shows within ${bound} frames (${appear})`,
    );
    expect(
      vanish.every((n) => n !== null && n <= bound),
      `${facesPerFrame} faces/frame: box leaves within ${bound} frames (${vanish})`,
    );
  }
  await page
    .locator('canvas[aria-label="Interactive 3D scene"]')
    .screenshot({ path: 'test-results/probes-live-box-out.png' });
  if (bench) {
    // Timings count only after the quiet gate (AC, CPU <= 20% for 20 s, waited up to 3 min); otherwise diagnostic.
    try {
      report.quietGate = await waitForQuiet({ timeout: 180 });
    } catch (error) {
      report.quietGate = { passed: false, timingsAreDiagnostic: true, reason: error.message };
    }
    report.cpuLoadAtStart = cpuLoad();
    report.cost = [];
    for (const facesPerFrame of [1, 2, 6]) {
      await page.evaluate((o) => window.check.setup(o), { facesPerFrame });
      await page.evaluate((o) => window.check.move(o), { to: into, look, present: true });
      const run = await page.evaluate((n) => window.check.bench(n), 180);
      assert.deepEqual(run.errors, []);
      const faceOnly = run.rows.filter((r) => r.passes && !r.filterMs),
        withFilter = run.rows.filter((r) => r.filterMs);
      const row = {
        facesPerFrame,
        frames: run.rows.length,
        captureMsPerFrame: stats(run.rows.map((r) => r.captureMs + r.filterMs)),
        faceOnlyFramesMs: stats(faceOnly.map((r) => r.captureMs)),
        prefilterFramesMs: stats(withFilter.map((r) => r.captureMs + r.filterMs)),
        prefilterComputeMs: stats(withFilter.map((r) => r.filterMs)),
        mainFrameGpuMs: stats(run.main),
      };
      report.cost.push(row);
      console.log(JSON.stringify(row));
    }
    const bakes = [];
    for (let i = 0; i < 3; i++) {
      const b = await page.evaluate(() => window.check.bake());
      assert.deepEqual(b.errors, []);
      bakes.push({ facesMs: +b.captureMs.toFixed(4), exactPrefilterMs: +b.filterMs.toFixed(4) });
    }
    report.bakeForComparison = bakes;
    console.log(JSON.stringify({ bake: bakes }));
  }
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}
report.powerOnline.after = ac();
assert.notEqual(report.powerOnline.after, 'False', 'still on AC power');
await writeFile(resolve(import.meta.dirname, 'results/probes-live-gpu.json'), JSON.stringify(report, null, 2) + '\n');
assert.deepEqual(failures, [], 'live probe checks failed');
console.log('live probes GPU check passed');
