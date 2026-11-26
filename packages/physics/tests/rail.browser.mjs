import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const isolated = {
  name: 'rail-isolation',
  config: () => ({
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  }),
};
const { page, hardware, close } = await openBrowser({
  startPath: '/packages/physics/tests/rail.html',
  port: 'free',
  plugins: [isolated],
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => typeof window.railFrame === 'function', null, { timeout: 20000 });
  const first = await page.evaluate(() => window.railFrame(1));
  const before = await decodePNG(await page.locator('canvas').screenshot());
  const last = await page.evaluate(() => window.railFrame(61));
  const screenshot = await page.locator('canvas').screenshot();
  const after = await decodePNG(screenshot);
  const moved = last.distance - first.distance;
  assert.ok(first.shared && last.shared);
  assert.ok(Math.abs(moved - 4) < 1e-9);
  assert.ok(Math.abs(last.wheelTravel - first.wheelTravel - moved) < 1e-9);
  assert.ok(last.headHeight > 4.5 && Math.abs(last.headHeight - first.headHeight) > 0.002);
  assert.deepEqual([...errors, ...first.errors, ...last.errors], []);
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (delta > 25) changed++;
  }
  assert.ok(changed > 2000, `Rendered wagon moved only ${changed} pixels`);
  const output = 'test-results/dyn05-browser';
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/${hardware?.compat ? 'webgl2' : 'webgpu'}.png`, screenshot);
  console.log(JSON.stringify({ backend: hardware?.compat ? 'WebGL2' : 'WebGPU', moved, changed, ...last }));
  await page.evaluate(() => window.closeRail());
} finally {
  await close();
}
