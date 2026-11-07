// Runs the seeded charts through Sismic and compares every step with Margo, then rewrites traces.json.
// Needs a Python with sismic installed: MARGO_SISMIC_PYTHON=<python> npm run test:outside --workspace @margoengine/fsm
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { CHART_COUNT, makeChart, runMargo } from './charts.mjs';

const python = process.env.MARGO_SISMIC_PYTHON ?? 'python',
  folder = new URL('.', import.meta.url),
  charts = Array.from({ length: CHART_COUNT }, (_, seed) => makeChart(seed + 1));
const run = spawnSync(python, ['-I', new URL('sismic-run.py', folder).pathname.replace(/^\/(\w:)/, '$1')], {
  input: JSON.stringify(charts),
  encoding: 'utf8',
  maxBuffer: 1 << 28,
  timeout: 300000,
});
if (run.status !== 0) throw new Error(`Sismic run failed: ${run.stderr || run.error}`);
const traces = JSON.parse(run.stdout);
let steps = 0,
  differ = 0,
  moved = 0;
charts.forEach((chart, index) => {
  const margo = runMargo(chart),
    outside = traces[index];
  for (let i = 0; i < margo.length; i++) {
    steps++;
    if (i && outside[i] !== outside[i - 1]) moved++;
    if (margo[i] !== outside[i] && differ++ < 5)
      console.log(`seed ${index + 1} step ${i}: Margo [${margo[i]}] Sismic [${outside[i]}]`);
  }
});
const count = (state, test) => (test(state) ? 1 : 0) + state.children.reduce((sum, child) => sum + count(child, test), 0),
  total = (test) => charts.reduce((sum, chart) => sum + count(chart.root, test), 0);
console.log(
  JSON.stringify({
    charts: charts.length,
    steps,
    moved,
    differ,
    parallel: total((state) => state.parallel),
    shallow: total((state) => state.history === 'shallow'),
    deep: total((state) => state.history === 'deep'),
  }),
);
if (differ) process.exit(1);
writeFileSync(new URL('traces.json', folder), `${JSON.stringify(traces)}\n`);
