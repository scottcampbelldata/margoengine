// GPU cost of the precise f32 functions against the WGSL builtins (AC power, after npm run build:packages, GPU alone):
//   node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/precise-math-gpu.mjs
// Part one: every element-wise function of @margoengine/compute on 16,777,216 values, createCompute() against
// createCompute({ fastMath: true }), the package's own dispatch and shader, timed by GPU timestamps on the compute pass.
// Part two: the path tracer's panorama and fisheye rays, a whole traced sample as shipped against the same page with
// the ray generation's precise calls swapped for the builtins in the served shader text. The repository's code is not
// changed. Arms take turns inside each round so clock and heat drift falls on both alike; each row is the median of the
// rounds, each round the mean of its faster half of trials. The camera lens makes no precise call: it is the control.
// PRECISE_ROUNDS=1 gives a quick trial. Writes results/precise-math-gpu.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { cpuLoad, waitForQuiet } from '../../scripts/quiet-gate.mjs';
import { acPower } from './parts/power.mjs';

const ROUNDS = Number(process.env.PRECISE_ROUNDS ?? 5),
  COUNT = 1 << 24,
  TRIALS = 12,
  TRACE = { width: 1920, height: 1080, samples: 8, trials: 6 },
  BOUNCES = [1, 4];
assert.notEqual(acPower(), false, 'run on AC power only');

const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1],
  // The mean of the faster half: a pass the timer rounds to one 0.066 ms tick averages out, and a pass another job
  // on the machine slowed does not count.
  settled = (values) => {
    const fastest = [...values].sort((a, b) => a - b).slice(0, Math.ceil(values.length / 2));
    return fastest.reduce((sum, v) => sum + v, 0) / fastest.length;
  },
  round3 = (value) => +value.toFixed(3);

const report = {
  benchmark: 'precise-math-gpu',
  recordedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
  rounds: ROUNDS,
  count: COUNT,
  trace: TRACE,
};
try {
  report.quietGate = await waitForQuiet({ timeout: 180 });
} catch (error) {
  report.quietGate = { passed: false, timingsAreDiagnostic: true, reason: error.message };
}
report.cpuLoadAtStart = cpuLoad();

const context = await openBrowser({ startPath: '/examples/package-benchmarks/precise-math-gpu.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
report.hardware = hardware.webgpu;
report.browser = `${hardware.browserName} ${hardware.browserVersion}`;
page.setDefaultTimeout(600_000);
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const url = page.url();
const fresh = async () => {
  await page.goto(url);
  await page.waitForFunction(() => window.ready === true);
};
try {
  const compute = {};
  for (let round = 0; round < ROUNDS; round++) {
    await fresh();
    const { rows } = await page.evaluate((o) => window.computeCost(o), { count: COUNT, trials: TRIALS });
    for (const [name, row] of Object.entries(rows)) {
      const c = (compute[name] ??= { precise: [], fast: [], differ: row.differ });
      c.precise.push(settled(row.precise));
      c.fast.push(settled(row.fast));
    }
  }
  report.compute = Object.fromEntries(
    Object.entries(compute).map(([name, c]) => {
      const precise = median(c.precise),
        fast = median(c.fast);
      return [name, { preciseMs: round3(precise), fastMs: round3(fast), ratio: +(precise / fast).toFixed(2), differ: +c.differ.toFixed(4) }];
    }),
  );
  console.table(report.compute);

  report.tracer = {};
  for (const bounces of BOUNCES) {
    const arms = { precise: {}, builtin: {} };
    for (let round = 0; round < ROUNDS; round++)
      for (let turn = 0; turn < 2; turn++) {
        const arm = (turn + round) % 2 ? 'builtin' : 'precise';
        await fresh();
        const result = await page.evaluate((o) => window.tracerCost(o), { ...TRACE, builtin: arm === 'builtin', bounces });
        if (arm === 'builtin') assert.ok(result.swapped > 0, 'the builtin arm swapped no call');
        for (const [lens, row] of Object.entries(result.rows)) {
          const a = (arms[arm][lens] ??= { ms: [], mean: row.mean });
          a.ms.push(settled(row.times));
        }
      }
    report.tracer[`${bounces} bounces`] = Object.fromEntries(
      Object.keys(arms.precise).map((lens) => {
        const precise = median(arms.precise[lens].ms),
          builtin = median(arms.builtin[lens].ms);
        return [
          lens,
          {
            preciseMsPerSample: round3(precise),
            builtinMsPerSample: round3(builtin),
            extraPercent: +(((precise - builtin) / builtin) * 100).toFixed(1),
            meanLevels: [arms.precise[lens].mean, arms.builtin[lens].mean].map(round3),
          },
        ];
      }),
    );
    console.table(report.tracer[`${bounces} bounces`]);
  }
  assert.deepEqual(pageErrors, []);
  const out = process.env.PRECISE_OUT ?? 'examples/package-benchmarks/results/precise-math-gpu.json';
  await writeFile(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${out}`);
} finally {
  await context.close();
}
