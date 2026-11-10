// Native WebGPU is unavailable beside ANGLE Vulkan in some Windows Chromium builds.
// Keep the native oracle on the same adapter in its own browser, then compare raw f32 bits on both ANGLE backends.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';

const path = '/packages/webgl2-compat/test/features.html';
const report = { native: null, backends: [] };
const native = await openBrowser({ startPath: path, port: 'free', compat: false, args: [] });
let oracle;
try {
  await native.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const result = await native.page.evaluate(() => window.check.run('implicitFootprint'));
  assert.equal(result.native.thrown, null);
  assert.deepEqual(result.native.errors, []);
  oracle = result.native.result;
  report.native = native.hardware;
} finally {
  await native.close();
}
for (const backend of ['d3d11', 'vulkan']) {
  const context = await openBrowser({ startPath: path, port: 'free', compat: false, args: [`--use-angle=${backend}`] });
  const errors = [];
  context.page.on('pageerror', (error) => errors.push(error.message));
  try {
    assert.match(context.hardware.webglRenderer, backend === 'd3d11' ? /Direct3D11/ : /Vulkan/);
    await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const result = await context.page.evaluate(() => window.check.runCompat('implicitFootprint'));
    assert.equal(result.thrown, null);
    assert.deepEqual(result.errors, []);
    assert.equal(result.gl, 0);
    assert.deepEqual(result.result, oracle, `${backend}: biased samples match native IEEE-754 bits`);
    assert.deepEqual(errors, []);
    report.backends.push({ backend, hardware: context.hardware, bits: result.result });
    console.log(`${backend}: 20 footprint probes, 1280 f32 words identical to native, no GPU errors`);
  } finally {
    await context.close();
  }
}
writeFileSync('test-results/review5-bias-bits.json', JSON.stringify(report, null, 2) + '\n');
