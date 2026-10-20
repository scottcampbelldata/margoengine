// Voxel sandbox benchmark (real GPU). Loads the deterministic mode (?view=overview, seed 1, 10:00, fixed camera) at
// render distance 8 and 16 in headless Edge at 1920 x 1080 with the high tier (4x MSAA) and records, per distance:
// - spawn: ms from the streamer's start until every chunk in range is loaded, lit, meshed and uploaded (the renderer's
//   stats then stay unchanged for 30 frames; the time is the last change, not the check), median of `--loads` loads
//   after one warm-up load; also first voxel draw, all chunks loaded, and page time to the streamer's start;
// - frame CPU during the fill (every frame from the streamer's start until ready, all loads): median, p95, max;
// - frame CPU time (the sandbox's frame callback: update + engine.render), median and p95 of 300 frames, camera still;
// - GPU time of the voxel passes (opaque + cutout, translucent) from timestamp queries, median and p95 of 100 frames
//   (null when the adapter lacks timestamp-query);
// - a 10 s flight (600 frames at a fixed 1/60 s step, 11 blocks/s) while chunks stream in: frame CPU median, p95, max;
// - chunks (with quads, visible, loaded), quads, quad bytes, draws, chunk data bytes.
// Holds the GPU lock (scripts/gpu-lock.mjs) and waits for the quiet gate (scripts/quiet-gate.mjs) first; numbers taken
// without a quiet machine are labelled DIAGNOSTIC. Writes test-results/voxel-sandbox-bench.json.
//   node examples/voxel-sandbox/bench.mjs [--distances=8,16] [--loads=3] [--no-quiet]
// Run `npm run build:packages` first.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { acquire } from '../../scripts/gpu-lock.mjs';
import { cpuLoad, waitForQuiet } from '../../scripts/quiet-gate.mjs';

process.chdir(resolve(import.meta.dirname, '../..')); // the dev server serves the repository root
const option = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback,
  distances = option('distances', '8,16').split(',').map(Number),
  loads = Number(option('loads', 3)),
  port = 5243,
  path = '/examples/voxel-sandbox/index.html',
  url = (rd) => `http://127.0.0.1:${port}${path}?view=overview&rd=${rd}&quality=high&gpuTiming`;
const stats = (list) => {
  const sorted = [...list].sort((a, b) => a - b),
    at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    median: +at(0.5).toFixed(3),
    p95: +at(0.95).toFixed(3),
    max: +sorted.at(-1).toFixed(3),
    samples: sorted.length,
  };
};

const release = await acquire({ owner: 'voxel-sandbox-bench' });
let context;
try {
  let quiet;
  if (process.argv.includes('--no-quiet')) quiet = { diagnostic: true, reason: '--no-quiet' };
  else
    try {
      quiet = await waitForQuiet({ timeout: 900 });
    } catch (error) {
      quiet = { diagnostic: true, reason: error.message };
    }
  const label = quiet.diagnostic ? `DIAGNOSTIC (${quiet.reason})` : 'quiet-gate passed';
  console.log(`machine: ${label}`);
  context = await openBrowser({ startPath: path, port });
  const { page, hardware } = context,
    errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  const load = async (rd) => {
    await page.goto(url(rd));
    await page.waitForFunction(() => window.voxelSandbox?.ready, null, { timeout: 300_000, polling: 100 });
    return page.evaluate(() => ({
      timeline: window.voxelSandbox.timeline,
      stats: window.voxelSandbox.stats(),
      fillFrames: window.voxelSandbox.fillFrames,
    }));
  };
  console.log('warm-up load (Vite transforms, shader cache)');
  await load(distances[0]);
  const report = {
    benchmark: 'voxel-sandbox',
    recordedAt: new Date().toISOString(),
    machine: quiet,
    label,
    hardware: hardware.webgpu,
    browser: `${hardware.browserName} ${hardware.browserVersion}`,
    viewport: '1920x1080',
    tier: 'high (4x MSAA)',
    view: 'overview (seed 1, 10:00)',
    results: [],
  };
  for (const rd of distances) {
    const runs = [];
    for (let i = 0; i < loads; i++) {
      const r = await load(rd);
      runs.push(r);
      const fill = stats(r.fillFrames);
      console.log(
        `rd ${rd} load ${i + 1}: spawn ${r.timeline.spawn.toFixed(0)} ms (all loaded ${r.timeline.loaded.toFixed(0)}), fill frame CPU median ${fill.median} p95 ${fill.p95} max ${fill.max} ms over ${fill.samples}, ${JSON.stringify(r.stats)}`,
      );
    }
    const spawns = runs.map((r) => r.timeline.spawn),
      last = runs.at(-1);
    const cpu = await page.evaluate(() => window.voxelSandbox.frames(300)),
      gpu = await page.evaluate(() => window.voxelSandbox.gpuTiming(100)),
      flight = await page.evaluate(() => window.voxelSandbox.fly(600, 11));
    const row = {
      distance: rd,
      spawnMs: stats(spawns).median,
      spawnRunsMs: spawns.map((v) => Math.round(v)),
      firstDrawMs: Math.round(last.timeline.firstDraw),
      allLoadedMs: Math.round(last.timeline.loaded),
      fillFrameCpuMs: stats(runs.flatMap((r) => r.fillFrames)),
      pageToStreamerMs: Math.round(last.timeline.startedAt),
      frameCpuMs: stats(cpu),
      voxelGpuMs: gpu ? stats(gpu) : null,
      flight: { blocksPerSecond: 11, frameCpuMs: stats(flight.cpu), statsAfter: flight.stats },
      chunks: last.stats.chunks,
      visible: last.stats.visible,
      loaded: last.stats.loaded,
      quads: last.stats.quads,
      quadBytes: last.stats.bytes,
      draws: last.stats.draws,
      chunkBytes: last.stats.chunkBytes,
      canvas: last.stats.canvas,
      mesherWorkers: last.stats.mesherWorkers,
      streamerWorkers: last.stats.streamerWorkers,
    };
    report.results.push(row);
    console.log(JSON.stringify(row));
  }
  report.cpuLoadAfterPercent = cpuLoad();
  report.errors = errors.filter((e) => !e.includes('powerPreference'));
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/voxel-sandbox-bench.json', `${JSON.stringify(report, null, 1)}\n`);
  console.log(`${label}; wrote test-results/voxel-sandbox-bench.json`);
  if (report.errors.length) {
    console.error(report.errors.join('\n'));
    process.exitCode = 1;
  }
} finally {
  await context?.close();
  release();
}
