// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/lighting2d/tests/browser-check.mjs
// Each light on a 32 x 16 target is within 1/255 of the CPU form per pixel, and shadow pixels are exactly the CPU's.
// Results: test-results/lighting2d-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/lighting2d/tests/browser-check.html', port: 5345 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const result = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/lighting2d-browser.json', JSON.stringify({ hardware, result }, null, 1));
  const failed = Object.entries(result.checks).filter(([, check]) => check.wrong !== 0);
  assert.deepEqual(failed, [], 'every pixel matches the CPU form');
  assert.ok(result.shadowed > 20, `the wall shadows ${result.shadowed} pixels`);
  assert.ok(result.lit > 100, `the light reaches ${result.lit} pixels`);
  assert.equal(result.sizes, 'state', 'normals of another size name their fix');
  assert.equal(result.validation, null, 'no validation errors');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log('ok lighting2d:', Object.keys(result.checks).length, 'pixel checks, 0 wrong, 0 validation errors');
} finally {
  await context.close();
}
