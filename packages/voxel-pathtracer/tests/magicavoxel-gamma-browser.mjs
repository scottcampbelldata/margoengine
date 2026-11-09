import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const results = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
    startPath: '/packages/voxel-pathtracer/tests/magicavoxel-gamma.html',
    port: 'free',
    ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
  });
  const pageErrors = [];
  context.page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate((compat) => window.run(compat), compat);
    console.log(JSON.stringify({ compat, hardware: context.hardware, result }));
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.messages, []);
    for (const row of result.coverage) {
      if (row.lifecycle) {
        assert.equal(row.replaced, true, 'device replaced');
        assert.equal(row.different, 0, 'gamma bytes survive device replacement');
      } else if (row.name) {
        for (const channel of row.actual) assert.ok(Math.abs(channel - row.expected) < 1 / 255 / 2);
      } else {
        assert.deepEqual(row.actual, [row.reference], `gamma ${row.gamma} exact reference byte`);
        assert.deepEqual(row.alpha, [255]);
      }
    }
    results.push({ compat, hardware: context.hardware, result });
  } finally {
    await context.close();
  }
}
await writeFile('test-results/voxel-pathtracer-magicavoxel-gamma.json', JSON.stringify(results, null, 2));
