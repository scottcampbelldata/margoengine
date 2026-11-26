import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, hardware, close } = await openBrowser({
  startPath: '/packages/physics/tests/crush-plate.html',
  port: 'free',
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForFunction(() => typeof window.drawCrushPlate === 'function', null, { timeout: 20_000 });
  const canvas = page.locator('canvas');
  const flat = await page.evaluate(() => window.drawCrushPlate(true));
  const before = await decodePNG(await canvas.screenshot());
  const buckled = await page.evaluate(() => window.drawCrushPlate(false));
  assert.equal(flat.visible, 1);
  assert.equal(buckled.visible, 1);
  assert.equal(buckled.compat, Boolean(hardware.compat));
  assert.ok(buckled.crest > 0);
  const image = await canvas.screenshot();
  const after = await decodePNG(image);
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const difference =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (difference > 12) changed++;
  }
  assert.ok(changed > 32, `The rendered plate differs by only ${changed} pixels`);
  assert.deepEqual(await page.evaluate(() => window.drawCrushPlate(false)), buckled);
  assert.deepEqual(await canvas.screenshot(), image);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/break03-buckled-plate-${buckled.compat ? 'webgl2' : 'webgpu'}.png`, image);
  console.log(`Crush plate ${buckled.compat ? 'WebGL2 layer' : 'WebGPU'}: ${changed} pixels, ${buckled.crest} m crest`);
} finally {
  await close();
}
