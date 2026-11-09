import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const reports = [];
for (const compat of [false, true]) {
  const context = await openBrowser({
      startPath: '/packages/voxel-pathtracer/tests/history-taps.html',
      port: 'free',
      compat,
      ...(compat && process.platform === 'win32' ? { args: ['--use-angle=vulkan'] } : {}),
    }),
    errors = [];
  context.page.on('pageerror', (error) => errors.push(error.message));
  try {
    await context.page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    const result = await context.page.evaluate(() => window.run());
    reports.push({ compat, hardware: context.hardware, result, errors });
  } finally {
    await context.close();
  }
}
await writeFile('test-results/voxel-pathtracer-history-taps.json', JSON.stringify(reports, null, 2));
const failed = [];
for (const report of reports) {
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.result.errors, []);
  assert.deepEqual(report.result.messages, []);
  assert.equal(report.result.replaced, true, 'actual replacement device');
  for (const phase of ['first', 'restored']) {
    assert.equal(report.result[phase].length, 112, 'all masks, HDR taps and exhausted/zero history');
    for (const row of report.result[phase]) {
      // Eight float32 ulps cover the weighted sum, normalization and blend under
      // WGSL's division bound. The history inputs and half packing are exact.
      const bound = 8 * 2 ** (Math.floor(Math.log2(Math.abs(row.expected))) - 23);
      if (
        row.actual.slice(0, 3).some((value) => !Number.isFinite(value) || Math.abs(value - row.expected) > bound) ||
        row.actual[3] !== row.expectedWeight
      )
        failed.push({ compat: report.compat, phase, ...row, bound });
    }
  }
}
console.log(JSON.stringify({ cases: 448, failures: failed.length, firstFailures: failed.slice(0, 4) }));
assert.equal(failed.length, 0, 'each history tap must pass its own surface mask');
