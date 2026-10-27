// Real-GPU sweep of the precise maths (bug 29; one GPU job at a time, from the repository root after building
// packages): node scripts/gpu-lock.mjs run --owner=<you> -- node packages/compute/tests/compute-precise-sweep.mjs
// preciseSin, preciseCos and preciseTan over every binade from 2^-12 to 2^127 and precisePow at extreme exponents
// (compute-precise-sweep-browser.js), against double precision. Prints one "N over bound" line per function and fails
// when N is above 0 for any. Results go to test-results/compute-precise-sweep.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const context = await openBrowser({ startPath: '/packages/compute/tests/compute-precise-sweep.html', port: 5243 });
const { page, hardware } = context;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.setDefaultTimeout(300_000);
try {
  await page.waitForFunction(() => typeof window.runPreciseSweep === 'function');
  const started = Date.now();
  const result = await page.evaluate(() => window.runPreciseSweep());
  assert.deepEqual(errors, []);
  console.log(`adapter ${JSON.stringify(hardware.webgpu)}`);
  for (const line of result.lines) console.log(`ok - ${line}`);
  console.log(`precise sweep passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/compute-precise-sweep.json', JSON.stringify({ hardware, ...result }, null, 2));
} finally {
  await context.close();
}
