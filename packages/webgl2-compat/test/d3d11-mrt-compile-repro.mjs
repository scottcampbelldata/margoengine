// Raw WebGL2 repro, no compatibility layer and no Margo code in the page (KB-L5a-10, KB6016e in docs/known-bugs.md):
// on ANGLE Direct3D 11 a program with several colour outputs compiles its pixel shader again at its first draw, on the
// browser's one GPU thread, one program after another; a 1-output program does not, nor does the same 7-output program
// drawn into one target. On ANGLE Vulkan none of them does. Not a gate: it prints, per ANGLE back end, each case's link
// time (all programs linked together) and every program's first and second draw time.
//
// Run: node scripts/run-with-timeout.mjs --max 10 -- node packages/webgl2-compat/test/d3d11-mrt-compile-repro.mjs
//   [--browser=chrome|msedge] [--angle=d3d11,vulkan] [--size=60] [--programs=3] [--trace=<file.json>]
// --trace records a Chrome trace of the first back end's run (categories gpu, gpu.angle, toplevel and disabled-by-default-gpu.*)
// and prints every pixel shader D3DCompile in it: its thread, time and the render targets it was compiled for.
import { chromium } from '@playwright/test';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const channel = arg('browser', 'chrome'),
  angles = arg('angle', 'd3d11,vulkan').split(','),
  size = Number(arg('size', 60)),
  programs = Number(arg('programs', 3)),
  tracePath = arg('trace', '');
const page = pathToFileURL(fileURLToPath(new URL('./d3d11-mrt-compile-repro.html', import.meta.url))).href;

const limit = setTimeout(() => {
  console.error('d3d11-mrt-compile-repro exceeded its 9 minute limit');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 540_000);

// The trace's pixel shader compiles (ANGLE's D3DCompile events, whose `source` argument is the HLSL): the thread each
// ran on, its time and the render targets (SV_TARGETn) its output struct declares, in the order they ran.
function pixelCompiles(trace) {
  const events = JSON.parse(trace).traceEvents ?? [],
    threads = new Map();
  for (const e of events)
    if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args?.name ?? '?');
  return events
    .filter((e) => e.ph === 'X' && e.name === 'D3DCompile' && /SV_TARGET/i.test(e.args?.source ?? ''))
    .sort((a, b) => a.ts - b.ts)
    .map((e) => ({
      thread: threads.get(`${e.pid}:${e.tid}`) ?? `${e.tid}`,
      ms: Math.round(e.dur / 1000),
      targets: new Set(e.args.source.match(/SV_TARGET\d*/gi).map((t) => t.toUpperCase())).size,
    }));
}

const t0 = performance.now(),
  at = () => `${((performance.now() - t0) / 1000).toFixed(1)} s`;
for (const [index, angle] of angles.entries()) {
  console.log(`[${at()}] launching --use-angle=${angle}`);
  const browser = await chromium.launch({ channel, headless: true, args: [`--use-angle=${angle}`] });
  try {
    const tab = await browser.newPage();
    await tab.goto(page);
    await tab.waitForFunction(() => window.reproReady);
    const tracing = tracePath && index === 0;
    if (tracing)
      await browser.startTracing(tab, {
        categories: [
          'gpu',
          'gpu.angle',
          'toplevel',
          'disabled-by-default-gpu.angle',
          'disabled-by-default-gpu.service',
        ],
      });
    const result = await tab.evaluate((o) => window.runRepro(o), { size, programs });
    console.log(`[${at()}] --use-angle=${angle}: ${result.renderer} (KHR_parallel_shader_compile ${result.parallel})`);
    for (const c of result.cases)
      console.log(
        `  ${c.name}: ${c.programs} programs linked in ${c.linkWallMs} ms; first draws ${c.firstDrawMs.join(', ')} ms` +
          ` (sum ${c.firstDrawSumMs}); second draws ${c.secondDrawMs.join(', ')} ms`,
      );
    if (tracing) {
      const trace = (await browser.stopTracing()).toString();
      writeFileSync(tracePath, trace);
      console.log(`  trace: ${tracePath}`);
      for (const e of pixelCompiles(trace))
        console.log(`    pixel shader D3DCompile on ${e.thread}: ${e.ms} ms, ${e.targets} target(s)`);
    }
  } finally {
    // Bounded teardown (bug 70): closeAll ends the browser within its budget and reports anything left behind.
    await closeAll({ browser });
  }
}
clearTimeout(limit);
process.exit(0); // process.exit: ends any browser that did not close in time (Playwright kills it at exit)
