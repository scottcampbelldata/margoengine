// Real-GPU proof (from the repository root after building packages; check:gpu-packages takes the GPU lock around it):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/webgl2-compat/test/adapter-browser.mjs
// Core on a device at compatibility level draws the same frame as at the full level, picks and comes back from a device
// restore at the same level. Package results are the table in docs/limits.md. Results: test-results/compat-adapter.json.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/adapter.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const result = await page.evaluate(() => window.check.run());
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/compat-adapter.json', JSON.stringify({ hardware, result }, null, 1));
  console.log(JSON.stringify(result, null, 1));
  assert.equal(result.fullLimits.core, true, 'the plain device has the full level');
  // WebKit has no compatibility level: a request for one gets a full device, which WebGPU allows.
  const level = process.env.MARGO_BROWSER === 'webkit';
  assert.equal(result.limits.core, level, 'this device really is at compatibility level');
  assert.equal(result.different, 0, 'the frame is the same at both levels');
  assert.equal(result.pick, true, 'pick finds the mesh');
  assert.equal(result.miss, true, 'pick finds nothing off the mesh');
  assert.deepEqual(result.afterLoss.core, level, 'a restored device stays at compatibility level');
  assert.equal(result.afterLoss.replaced, true);
  assert.ok(result.afterLoss.drew > 60, 'a restored device draws');
  assert.deepEqual(result.coreErrors, []);
  // Each of these runs on the level; docs/known-bugs.md lists the packages that do not yet.
  for (const name of ['core alone', 'materials createMesh', 'materials createInstancedMesh'])
    assert.match(result.packages[name], /^ok, [1-9]/, name);
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}
