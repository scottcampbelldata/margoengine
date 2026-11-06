// Real-GPU checks of @margoengine/compute (one GPU job at a time; from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/compute/tests/compute-browser.mjs
// The page (compute-browser.js) checks map, reduce, scan, sort, argsort, sortByKey and histogram against CPU references
// at sizes around every block boundary, kernels bound by name, coded GPU errors, AbortSignal, disposal, the 2D grid
// past 65,535 workgroups and device sharing with an engine; compute-extras-browser.js checks linalg, fft, signal,
// random, stream and frame; compute-cpu-browser.js runs the same operations on the CPU backend and the GPU and
// compares them; compute-subgroups-browser.js checks the subgroup kernels against the default ones and
// compute-nn-browser.js the network layers against the CPU backend; compute-graph-browser.js the graph algorithms
// against sequential references.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

// The dev server serves the repository root, whichever folder `npm run test:browser` starts in.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const context = await openBrowser({ startPath: '/packages/compute/tests/compute.html', port: 5241 });
const { page, hardware } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.setDefaultTimeout(600_000);
try {
  await page.waitForFunction(
    () =>
      typeof window.runComputeTests === 'function' &&
      typeof window.runExtrasTests === 'function' &&
      typeof window.runCpuParityTests === 'function' &&
      typeof window.runPreciseTests === 'function' &&
      typeof window.runSubgroupTests === 'function' &&
      typeof window.runNnTests === 'function' &&
      typeof window.runGraphTests === 'function',
  );
  // The precise maths first: every other check of a transcendental function rests on it.
  const precise = await page.evaluate(() => window.runPreciseTests());
  const core = await page.evaluate(() => window.runComputeTests());
  const extras = await page.evaluate(() => window.runExtrasTests());
  const cpu = await page.evaluate(() => window.runCpuParityTests());
  const subgroups = await page.evaluate(() => window.runSubgroupTests());
  const nn = await page.evaluate(() => window.runNnTests());
  const graph = await page.evaluate(() => window.runGraphTests());
  const report = {
    checks: [...precise.checks, ...core.checks, ...extras.checks, ...cpu.checks, ...subgroups.checks, ...nn.checks, ...graph.checks],
    timings: { ...core.timings, ...extras.timings, ...cpu.timings },
    adapter: core.adapter,
    preciseMath: precise.results,
    subgroups: subgroups.subgroups,
  };
  assert.deepEqual(errors, []);
  // The two shaders broken on purpose must have failed (their labels are excused only when they do).
  await page.evaluate(() => Promise.all(globalThis.__margoWgslReports ?? []));
  assert.deepEqual(context.wgsl.expected.sort(), ['expect-error:bad kernel', 'expect-error:bad map']);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/compute-browser.json', JSON.stringify({ hardware, ...report }, null, 2));
  // The site demos built on this package start, finish their first result and log no errors.
  for (const demo of ['compute-lab']) {
    await page.goto(new URL(`/examples/${demo}.html`, page.url()).href);
    await page.waitForFunction(() => document.querySelector('#viewport')?.dataset.ready === 'true', null, {
      timeout: 120_000,
    });
    // Settled: no pipeline still compiling (scripts/support/gpu-ready.js counts them) and every WGSL report in.
    await page.waitForFunction(() => (globalThis.__margoPipelines?.pending ?? 0) === 0, null, { timeout: 120_000 });
    await page.evaluate(() => Promise.all(globalThis.__margoWgslReports ?? []));
    const status = await page.evaluate(() => document.querySelector('#status')?.textContent ?? '');
    assert.deepEqual(errors, [], `${demo}: ${status}`);
    assert.doesNotMatch(status, /Could not/, `${demo}: ${status}`);
    report.checks.push(`demo ${demo} runs: ${status}`);
  }
  for (const name of report.checks) console.log(`ok - ${name}`);
  console.log(JSON.stringify(report.timings, null, 2));
  console.log(`${report.checks.length} compute browser checks passed`);
} finally {
  await context.close();
}
