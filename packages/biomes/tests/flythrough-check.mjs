// Goal G3 as a budget test (run from the repository root after building packages, in a shared GPU slot):
//   node packages/biomes/tests/flythrough-check.mjs
// A 300 km/h flight over the zero-configuration world with tiles made by workers as the camera goes must add at most
// 0.3 ms to the slowest 1 percent of frames and at most 1 ms to the worst frame, against the same flight with every
// tile made before it starts; the page's copying of arrived tiles stays within its 0.25 ms frame budget (one tile at a
// time when a single tile takes longer, reported). Writes test-results/biomes-flythrough.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

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

const context = await openBrowser({ startPath: '/packages/biomes/tests/flythrough-check.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.check.run()),
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
  assert.ok(
    streamed.every((s) => s.frames > 600),
    `real-time flights of ${streamed.map((s) => s.frames)} frames`,
  );
  assert.ok(result.p99Added <= 0.3, `streaming added ${result.p99Added.toFixed(3)} ms to the 99th percentile frame`);
  assert.ok(result.maxAdded <= 1, `streaming added ${result.maxAdded.toFixed(3)} ms to the worst frame`);
  console.log(
    `ok biomes flythrough: p99 +${result.p99Added.toFixed(2)} ms, worst +${result.maxAdded.toFixed(2)} ms (medians of 3 flights each)`,
  );
} finally {
  await context.close();
}
