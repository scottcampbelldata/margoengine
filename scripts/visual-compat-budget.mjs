// The frame budget of the visual check's WebGL2 compatibility run (docs/webgl2-compat-demos.md), a timing step of its
// own: the same demos as npm run visual:compat (scripts/support/visual-compat-pages.js), each opened natively and on the
// layer, and the frame cost of its still frame measured on both paths.
//   npm run visual:compat:budget [-- --only=dof,earth] [--budget=50] [--chunk=8] [--chunk-minutes=15] [--write]
// Frame cost: the main-thread time of each animation frame's callbacks (the layer translates and replays the frame's GL
// calls there) and the interval between frames, median of 60 frames after the still frame settles. A demo fails when
// its median frame on the layer costs more than `--budget=<ms>` (default 50, the per-frame budget check for integrated
// GPUs) and at least twice its native frame. A demo that refuses the layer, or that its page keeps on WebGPU, has no
// frame on the layer and is only reported.
// Timing on a shared GPU measures the other slots' work too (khronos-NodePerformanceTest read 86 ms against 50 beside
// other suites, 2026-10-30), so this step holds the GPU exclusively, and in chunks: `--chunk` demos per hold (default
// 8), each hold with a hard limit of `--chunk-minutes` (default 15; over it the run stops and fails, naming the chunk),
// released between chunks so other agents' GPU work runs in between. Run inside a shared hold it fails at once.
// Reads the site build (site/dist, from npm run build:site; check:merge builds it first) and builds nothing itself.
// `--write` records the frame column of docs/webgl2-compat-demos.md's table; the pixel columns are visual:compat's.
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { acquire } from './gpu-lock.mjs';
import { browserLabel, launchBrowser } from './lib/browser.mjs';
import { closeAll } from './support/shutdown.mjs';
import { rewriteTable } from './support/visual-compat-doc.js';
import { frameCost, openCase, selectCases, startServers } from './support/visual-compat-pages.js';
import { frameProblems } from './support/visual-compat-status.js';

const root = resolve(import.meta.dirname, '..'),
  out = resolve(root, 'test-results/visual-compat');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = (arg('only') ?? '').split(',').filter(Boolean),
  write = process.argv.includes('--write'),
  budget = Number(arg('budget') ?? 50),
  chunkSize = Number(arg('chunk') ?? 8),
  chunkMinutes = Number(arg('chunk-minutes') ?? 15);
const cases = selectCases(only),
  chunks = [];
for (let i = 0; i < cases.length; i += chunkSize) chunks.push(cases.slice(i, i + chunkSize));

let release = () => {};
process.on('exit', () => release());
let servers = [],
  browser,
  origins;
let exitCode = 0;
const rows = [],
  begun = Date.now();
try {
  await mkdir(out, { recursive: true });
  for (const [n, chunk] of chunks.entries()) {
    const label = `chunk ${n + 1} of ${chunks.length} (${chunk.map((c) => c.id).join(', ')})`;
    const waited = Date.now();
    release = await acquire({
      mode: 'exclusive',
      owner: `visual-compat-budget ${n + 1}/${chunks.length}`,
      max: chunkMinutes + 2,
    });
    const held = Date.now();
    // Hard limit per hold: over it the run stops, and the exit handler releases the GPU.
    const limit = setTimeout(() => {
      console.error(`visual:compat:budget: ${label} held the GPU over ${chunkMinutes} min, stopped`);
      process.exit(1);
    }, chunkMinutes * 60_000);
    try {
      if (!browser) {
        const started = await startServers(cases);
        servers = started.servers;
        origins = started;
        browser = await launchBrowser({ headless: true, args: ['--enable-unsafe-webgpu'] });
        console.log(`visual:compat:budget: ${browserLabel()} ${browser.version()}, ${cases.length} demos`);
      }
      for (const c of chunk) rows.push(await measure(c));
    } finally {
      clearTimeout(limit);
      release();
      release = () => {};
    }
    console.log(
      `visual:compat:budget: ${label}: waited ${((held - waited) / 1000).toFixed(0)} s, held the GPU ${((Date.now() - held) / 1000).toFixed(0)} s`,
    );
  }
  if (rows.some((r) => r.problems.length)) exitCode = 1;
  await writeFile(resolve(out, 'frames.json'), JSON.stringify({ budget, rows }, null, 1) + '\n');
  if (write) await writeDoc(rows);
  console.log(
    `visual:compat:budget: ${rows.length} demos, ${rows.filter((r) => r.problems.length).length} failing, ${((Date.now() - begun) / 60_000).toFixed(1)} min`,
  );
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await closeAll({ browser, servers }).catch((error) => console.warn(error.message));
  release();
}
process.exit(exitCode);

/** One demo's frame cost on both paths and its budget problems. */
async function measure(c) {
  const row = { id: c.id, errors: [] };
  const timed = async (compat) => {
    let opened;
    try {
      opened = await openCase(browser, c, { compat, timed: true, ...origins });
      if (opened.refused || opened.off) return { skipped: opened.refused ? 'refused' : 'webgpu only' };
      return { cost: await frameCost(opened.page) };
    } catch (error) {
      opened ??= error;
      row.errors.push(`${compat ? 'layer' : 'native'}: ${String(error.message ?? error).split('\n')[0]}`);
      return {};
    } finally {
      if (opened?.errors) row.errors.push(...opened.errors.map((e) => `${compat ? 'layer' : 'native'}: ${e}`));
      await opened?.context?.close();
    }
  };
  const native = await timed(false),
    layer = native.cost ? await timed(true) : {};
  if (native.cost && layer.cost) row.frame = { native: native.cost, compat: layer.cost };
  row.skipped = layer.skipped;
  row.problems = row.frame
    ? frameProblems(row.frame, budget)
    : layer.skipped
      ? []
      : [row.errors.find((e) => e.includes('capture: ')) ?? 'no frame measured'];
  const f = row.frame;
  console.log(
    `${row.problems.length ? 'FAIL' : 'ok  '} ${c.id}: ${f ? `frame work ${f.native.work.toFixed(2)} / ${f.compat.work.toFixed(2)} ms, interval ${f.native.interval.toFixed(1)} / ${f.compat.interval.toFixed(1)} ms` : (row.skipped ?? 'no frame')}${row.problems.length ? `: ${row.problems.join('; ')}` : ''}`,
  );
  return row;
}

/** Records the frame column of the demos measured; the other columns and rows stay as they are. */
async function writeDoc(measured) {
  const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} ms` : '-');
  await rewriteTable((rows) => {
    for (const r of measured) {
      const cells = rows.get(r.id);
      if (!cells) continue;
      cells[4] = r.frame
        ? `${ms(r.frame.native.work)} / ${ms(r.frame.compat.work)}; ${ms(r.frame.native.interval)} / ${ms(r.frame.compat.interval)}`
        : '-';
    }
  });
}
