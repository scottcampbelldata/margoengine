import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
const browser = await openBrowser({ startPath: '/tests/modern-xr.html' });
try {
  const verification = await browser.page.evaluate(async () => await window.xrVerification);
  assert.ok(!verification.error, verification.error);
  assert.ok(verification.result.frames >= 3);
  assert.deepEqual(verification.result.gpuErrors, []);
  await writeFile(
    'test-results/modern-xr.json',
    JSON.stringify({ hardware: browser.hardware, ...verification.result }, null, 2),
  );
  console.log('Real WebGPU stereo pixel readback and XR teardown passed', verification.result.centers);
} finally {
  await browser.close();
}
