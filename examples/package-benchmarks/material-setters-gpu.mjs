// Real-GPU check of PbrMaterial.set (run on AC power, holding the GPU lock, after npm run build:packages):
//   node examples/package-benchmarks/material-setters-gpu.mjs
// A red box is drawn, then material.set({color: blue}); the very next frame must show blue with no pipeline or bind
// group created in between. Frames go to test-results/material-setters-*.png.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { openBrowser } from '../../scripts/browser.js';
import { decodePNG } from '../../tests/support/png.js';

const ac = () =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline',
    ],
    { encoding: 'utf8' },
  ).trim();
assert.equal(ac(), 'True', 'measure on AC power only');
const context = await openBrowser({ startPath: '/examples/package-benchmarks/material-setters.html', port: 5221 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const center = async (name) => {
    const png = await decodePNG(
        await page.locator('canvas').screenshot({ path: `test-results/material-setters-${name}.png` }),
      ),
      i = (128 * png.width + 128) * 4;
    return Array.from(png.data.slice(i, i + 3));
  };
  const before = await page.evaluate(() => window.check.before()),
    red = await center('before');
  const after = await page.evaluate(() => window.check.after()),
    blue = await center('after');
  console.log(
    JSON.stringify({
      gpu: hardware.webgpu,
      browser: hardware.browserName + ' ' + hardware.browserVersion,
      before: { ...before, pixel: red },
      after: { ...after, pixel: blue },
    }),
  );
  assert.deepEqual([...before.errors, ...after.errors, ...pageErrors], []);
  assert.ok(red[0] > 100 && red[2] < 40, 'red before');
  assert.ok(blue[2] > 100 && blue[0] < 40, 'blue on the next frame');
  assert.deepEqual(after.created, before.created, 'no pipeline or bind group created by the change');
} finally {
  await context.close();
}
assert.equal(ac(), 'True', 'still on AC power');
console.log('material setters GPU check passed');
