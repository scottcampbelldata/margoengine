// Real-GPU checks of @margoengine/compute (one GPU job at a time; from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/compute/tests/compute-browser.mjs
// The page (compute-browser.js) checks map, reduce, scan, sort, argsort, sortByKey and histogram against CPU references
// at sizes around every block boundary, kernels bound by name, coded GPU errors, AbortSignal, disposal, the 2D grid
// past 65,535 workgroups and device sharing with an engine; compute-extras-browser.js checks linalg, fft, signal,
// random, stream and frame. Results go to test-results/compute-browser.json.
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
    () => typeof window.runComputeTests === 'function' && typeof window.runExtrasTests === 'function',
  );
  const core = await page.evaluate(() => window.runComputeTests());
  const extras = await page.evaluate(() => window.runExtrasTests());
  const report = {
    checks: [...core.checks, ...extras.checks],
    timings: { ...core.timings, ...extras.timings },
    adapter: core.adapter,
  };
  assert.deepEqual(errors, []);
  // The two shaders broken on purpose must have failed (their labels are excused only when they do).
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  assert.deepEqual(context.wgsl.expected.sort(), ['expect-error:bad kernel', 'expect-error:bad map']);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/compute-browser.json', JSON.stringify({ hardware, ...report }, null, 2));
  // The site demos built on this package start, finish their first result and log no errors.
  for (const demo of ['compute-lab']) {
    await page.goto(new URL(`/examples/${demo}.html`, page.url()).href);
    await page.waitForFunction(() => document.querySelector('#viewport')?.dataset.ready === 'true', null, {
      timeout: 120_000,
    });
    await page.waitForTimeout(500);
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
