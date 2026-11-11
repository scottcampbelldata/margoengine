// GPU cost of @margoengine/compute's default kernels against useSubgroups (AC power, after npm run build:packages, GPU
// alone):
//   node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/compute-subgroups.mjs
// Sum, sum along an axis, cumsum, sort and argsort on 16,777,216 f32 values, every pass timed by GPU timestamps, the two
// routes taking turns inside each round so clock and heat drift falls on both alike. Each row is the median of the
// rounds, each round the mean of its faster half of trials. SUBGROUP_ROUNDS=1 gives a quick trial. Writes
// results/compute-subgroups.json; without a quiet machine the file says its timings are diagnostic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { waitForQuiet } from '../../scripts/quiet-gate.mjs';
import { acPower } from './parts/power.mjs';
import { median as nearestMedian } from '../../scripts/lib/percentile.mjs';

const ROUNDS = Number(process.env.SUBGROUP_ROUNDS ?? 5),
  COUNT = 1 << 24,
  TRIALS = 12;
assert.notEqual(acPower(), false, 'run on AC power only');

const median = (values) => nearestMedian(values),
  settled = (values) => {
    const fastest = [...values].sort((a, b) => a - b).slice(0, Math.ceil(values.length / 2));
    return fastest.reduce((sum, v) => sum + v, 0) / fastest.length;
  },
  round3 = (value) => +value.toFixed(3);

const report = {
  benchmark: 'compute-subgroups',
  recordedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  rounds: ROUNDS,
  count: COUNT,
};
try {
  report.quietGate = await waitForQuiet({ timeout: Number(process.env.SUBGROUP_QUIET_WAIT ?? 180) });
} catch (error) {
  report.quietGate = { passed: false, timingsAreDiagnostic: true, reason: error.message };
}

const context = await openBrowser({ startPath: '/packages/compute/tests/compute.html', port: 'free' }),
  { page, hardware } = context;
report.hardware = hardware.webgpu;
report.browser = `${hardware.browserName} ${hardware.browserVersion}`;
page.setDefaultTimeout(600_000);
try {
  await page.waitForFunction(() => typeof window.subgroupCost === 'function');
  const rounds = {};
  for (let round = 0; round < ROUNDS; round++) {
    const rows = await page.evaluate((o) => window.subgroupCost(o), { count: COUNT, trials: TRIALS });
    for (const [name, row] of Object.entries(rows)) {
      const r = (rounds[name] ??= { plain: [], subgroups: [] });
      r.plain.push(settled(row.plain));
      r.subgroups.push(settled(row.subgroups));
    }
  }
  report.rows = Object.fromEntries(
    Object.entries(rounds).map(([name, r]) => {
      const plain = median(r.plain),
        subgroups = median(r.subgroups);
      return [name, { plainMs: round3(plain), subgroupsMs: round3(subgroups), speedup: round3(plain / subgroups) }];
    }),
  );
} finally {
  await context.close();
}
await writeFile(resolve(import.meta.dirname, 'results/compute-subgroups.json'), `${JSON.stringify(report, null, 2)}\n`);
console.table(report.rows);
