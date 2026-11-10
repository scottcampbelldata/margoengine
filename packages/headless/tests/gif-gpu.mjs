import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const context = await openBrowser({ startPath: '/packages/headless/tests/gif-gpu.html', port: 5281 });
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  for (const compat of [false, true]) {
    const result = await context.page.evaluate((value) => window.check(value), compat);
    assert.deepEqual(result.errors, []);
    assert.equal(result.count, 3);
    assert.deepEqual(result.durations, [40000, 40000, 40000]);
    // Existing exporter median-cut correctness bars (capture.test.js), unchanged.
    for (const diff of result.differences) assert.ok(diff.mean <= 6 && diff.largest <= 24, JSON.stringify(diff));
    console.log('ok rendered GIF ' + (compat ? 'full WebGL2 compatibility' : 'native WebGPU'), result);
  }
} finally {
  await context.close();
}
