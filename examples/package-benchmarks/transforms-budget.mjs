import { deferSpeed, isSpeedEntry } from '../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('examples/package-benchmarks/transforms-budget.mjs')
)
  process.exit(0);
// Moving transforms per frame within a CPU budget (item 53.1). How many meshes can move every frame (each one's
// position.y and rotation.y through the setters) while core's whole CPU frame stays within the budget: the onFrame
// callback, the Wasm kernel tick (world matrices, bounds, frustum culling), instance patching and the renderer's
// frame on a stand-in device (tests/support/still-gpu.mjs), so the figure is the engine's CPU work, not the GPU's.
// All meshes share one geometry and material (one instanced draw). For each count: 120 warm-up frames, then 300 timed
// frames; the figure is the median frame. A binary search finds the largest count whose median fits the budget.
// Options: --budget=<ms> (default 4, a quarter of a 60 Hz frame), --frames=<n>, --warmup=<n>, --out=<file>.
// Run on a quiet machine: `node scripts/gpu-lock.mjs run --exclusive --owner=<id> -- node examples/package-benchmarks/transforms-budget.mjs --out=examples/package-benchmarks/results/transforms-budget.json`.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';

const root = process.env.MARGO_ROOT ?? resolve(import.meta.dirname, '../..');
const { Engine, TransformStore, box } = await import(`file://${root}/packages/core/dist/extension.js`);
const { frameDriver, stillRenderer } = await import(`file://${root}/tests/support/still-gpu.mjs`);

const args = process.argv.slice(2),
  option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback,
  budget = Number(option('budget', 4)),
  frames = Number(option('frames', 300)),
  warmup = Number(option('warmup', 120)),
  out = option('out', null);

/** Median CPU milliseconds of one frame with `count` meshes moving through the setters. */
async function frameTime(count) {
  const run = frameDriver(),
    { canvas, renderer } = stillRenderer(),
    engine = new Engine(canvas, await TransformStore.create(count + 16), renderer, undefined, null),
    geometry = box(0.4, 0.4, 0.4),
    movers = new Array(count),
    clock = new Float64Array(1),
    side = Math.ceil(Math.cbrt(count)),
    half = (side - 1) / 4;
  // A cube of meshes 0.5 apart, all inside the view, so every mesh is also patched into the instance buffer.
  for (let i = 0; i < count; i++) {
    const mesh = engine.createMesh().setGeometry(geometry);
    mesh.position.set(
      (i % side) / 2 - half,
      (Math.floor(i / side) % side) / 2 - half,
      Math.floor(i / side / side) / 2 - half,
    );
    movers[i] = mesh;
  }
  engine.camera.position = [0, 0, 4 * half + 5];
  engine.camera.far = 10 * half + 100;
  engine.onFrame((_, delta) => {
    const time = (clock[0] += delta / 1000);
    for (let i = 0; i < count; i++) {
      const mesh = movers[i];
      mesh.rotation.y = time + i * 0.001;
      mesh.position.y = (Math.floor(i / side) % side) / 2 - half + 0.1 * Math.sin(time * 2 + i * 0.01);
    }
  });
  engine.start();
  run(warmup);
  const times = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = performance.now();
    run(1);
    times[f] = performance.now() - start;
  }
  const drawCalls = engine.stats.drawCalls,
    visible = engine.stats.visible;
  engine.dispose();
  times.sort();
  return { count, median: times[frames >> 1], p90: times[Math.floor(frames * 0.9)], drawCalls, visible };
}

const rows = [];
const measure = async (count) => {
  const row = await frameTime(count);
  rows.push(row);
  console.log(
    `${String(count).padStart(8)} moving: median ${row.median.toFixed(3)} ms, p90 ${row.p90.toFixed(3)} ms, ${row.drawCalls} draws, ${row.visible} visible`,
  );
  return row.median <= budget;
};
// Bracket by doubling, then bisect to 1 % of the count.
let low = 1000,
  high = 1000;
if (!(await measure(low))) throw new RangeError(`1,000 moving meshes already take over ${budget} ms`);
while (await measure((high *= 2))) low = high;
while (high - low > Math.max(100, low * 0.01)) {
  const middle = Math.round((low + high) / 2 / 100) * 100;
  if (await measure(middle)) low = middle;
  else high = middle;
}
const commit = (() => {
  try {
    const hash = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
    return { commit: hash, dirty: dirty.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
})();
const result = {
  ...commit,
  date: new Date().toISOString().slice(0, 10),
  method:
    'Node, core dist, stand-in GPU device (tests/support/still-gpu.mjs); every mesh sets position.y and rotation.y each frame; one shared geometry and material; every mesh in view; median of the timed frames',
  node: process.version,
  cpu: cpus()[0].model.trim(),
  threads: cpus().length,
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  budgetMs: budget,
  warmup,
  frames,
  movingWithinBudget: low,
  rows: rows.sort((a, b) => a.count - b.count),
};
console.log(`${low} moving transforms per frame within ${budget} ms of CPU`);
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
