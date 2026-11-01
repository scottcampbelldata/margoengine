// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/pixel/tests/render3d-check.mjs
// A cube at 32 x 32: the outline falls exactly where the CPU finds depth edges and creases from the depth read back, the
// rest is the view's colour; off, the output is the colour; a captured sheet has N frames of the right size; a compositor
// layer takes the picture; a device loss. Results: test-results/render3d-browser.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/pixel/tests/render3d-check.html', port: 5344 }),
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
  await writeFile('test-results/render3d-browser.json', JSON.stringify({ hardware, result }, null, 1));
  const failed = Object.entries(result.checks).filter(([, check]) => check.wrong !== 0);
  assert.deepEqual(failed, [], 'every pixel matches the CPU reference');
  assert.ok(result.outlined > 20, `the outline drew ${result.outlined} pixels`);
  assert.ok(result.creases > 0, `the creases drew ${result.creases} more pixels`);
  assert.ok(result.covered > 100, `the cube covers ${result.covered} pixels`);
  assert.equal(result.notAttached, 'state', 'a view read before attach names its fix');
  assert.equal(result.validation, null, 'no validation errors');
  assert.ok(result.otherScene > 100, `the other scene covers ${result.otherScene} pixels`);
  assert.deepEqual(
    result.fourSamples,
    { corner: 0, middle: 255, validation: null },
    'four samples per pixel clear to transparent',
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(pageErrors, []);
  console.log('ok render3d:', Object.keys(result.checks).length, 'exact checks, 0 wrong pixels, 0 validation errors');
} finally {
  await context.close();
}
