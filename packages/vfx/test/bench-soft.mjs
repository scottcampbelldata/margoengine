import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/vfx/test/bench-soft.mjs')
)
  process.exit(0);
// Frame cost of soft particles (run from the repository root after building packages; a benchmark, so it takes the GPU
// exclusively): the same one-million-particle system with and without `softness`, alternated, wall time per frame at
// 1280 x 720 including the floor depth pass the sampler reads.
//   node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node packages/vfx/test/bench-soft.mjs
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/vfx/test/browser-check.html', port: 5287 }),
  { page, hardware } = context;
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.benchSoft(1_000_000, 9, 40)),
    stats = (a) => {
      const s = [...a].sort((x, y) => x - y);
      return { median: s[s.length >> 1], min: s[0], max: s.at(-1) };
    };
  assert.deepEqual(r.errors, []);
  const plain = stats(r.plain),
    soft = stats(r.soft),
    report = { hardware, particles: 1_000_000, plain, soft, plainRuns: r.plain, softRuns: r.soft };
  await writeFile('test-results/vfx-soft-bench.json', JSON.stringify(report, null, 1));
  const f = (n) => n.toFixed(2);
  console.log(
    `plain ${f(plain.median)} ms/frame (${f(plain.min)}..${f(plain.max)}), soft ${f(soft.median)} ms/frame (${f(soft.min)}..${f(soft.max)})`,
  );
} finally {
  await context.close();
}
