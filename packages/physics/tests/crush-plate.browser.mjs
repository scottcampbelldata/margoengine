import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

function changedPixels(before, after) {
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const difference =
      Math.abs(before.data[i] - after.data[i]) +
      Math.abs(before.data[i + 1] - after.data[i + 1]) +
      Math.abs(before.data[i + 2] - after.data[i + 2]);
    if (difference > 12) changed++;
  }
  return changed;
}

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
  const changed = changedPixels(before, after);
  assert.ok(changed > 32, `The rendered plate differs by only ${changed} pixels`);
  assert.deepEqual(await page.evaluate(() => window.drawCrushPlate(false)), buckled);
  assert.deepEqual(await canvas.screenshot(), image);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/break03-buckled-plate-${buckled.compat ? 'webgl2' : 'webgpu'}.png`, image);
  console.log(`Crush plate ${buckled.compat ? 'WebGL2 layer' : 'WebGPU'}: ${changed} pixels, ${buckled.crest} m crest`);

  await page.waitForFunction(() => typeof window.drawLiveCrushPlate === 'function', null, { timeout: 20_000 });
  const loaded = await page.evaluate(() => window.drawLiveCrushPlate(false));
  const loadedImage = await canvas.screenshot();
  const released = await page.evaluate(() => window.drawLiveCrushPlate(true));
  const releasedImage = await canvas.screenshot();
  assert.equal(loaded.visible, 1);
  assert.equal(released.visible, 1);
  assert.ok(released.stroke > 0 && released.stroke < loaded.stroke);
  assert.ok(released.crest > 0 && released.crest < loaded.crest);
  assert.notDeepEqual(releasedImage, loadedImage);
  assert.deepEqual(await page.evaluate(() => window.drawLiveCrushPlate(false)), loaded);
  assert.deepEqual(await canvas.screenshot(), loadedImage);
  assert.deepEqual(errors, []);
  const device = buckled.compat ? 'webgl2' : 'webgpu';
  await writeFile(`test-results/break03-live-plate-loaded-${device}.png`, loadedImage);
  await writeFile(`test-results/break03-live-plate-released-${device}.png`, releasedImage);
  console.log(`Live plate crest ${loaded.crest} m loaded, ${released.crest} m after release.`);

  const flatDisc = await page.evaluate(() => window.drawIndentedPlate(true));
  const discControl = await canvas.screenshot();
  const dent = await page.evaluate(() => window.drawIndentedPlate(false));
  const dentImage = await canvas.screenshot();
  assert.equal(flatDisc.visible, 1);
  assert.equal(dent.visible, 1);
  assert.equal(dent.rim, 0);
  assert.ok(dent.stroke > 0 && dent.force > 0);
  const dentPixels = changedPixels(await decodePNG(discControl), await decodePNG(dentImage));
  assert.ok(dentPixels > 32, `The membrane dent differs by only ${dentPixels} pixels`);
  assert.deepEqual(await page.evaluate(() => window.drawIndentedPlate(false)), dent);
  assert.deepEqual(await canvas.screenshot(), dentImage);
  assert.deepEqual(errors, []);
  await writeFile(`test-results/break03-membrane-indentation-${device}.png`, dentImage);
  console.log(
    `Circular membrane: ${(1000 * dent.stroke).toFixed(2)} mm dent, ${dent.force.toFixed(0)} N reaction, ${dentPixels} changed pixels.`,
  );
  const nativeDent = await page.evaluate(() => window.drawNativeIndentation());
  const nativeImage = await canvas.screenshot();
  assert.equal(nativeDent.fractured, true);
  assert.equal(nativeDent.rim, 0);
  assert.ok(nativeDent.work > 0 && nativeDent.stroke > dent.stroke);
  assert.ok(changedPixels(await decodePNG(dentImage), await decodePNG(nativeImage)) > 32);
  assert.deepEqual(await page.evaluate(() => window.drawNativeIndentation()), nativeDent);
  assert.deepEqual(await canvas.screenshot(), nativeImage);
  await writeFile(`test-results/break03-native-membrane-${device}.png`, nativeImage);
  console.log(`Native membrane retained ${(1000 * nativeDent.stroke).toFixed(2)} mm at fracture.`);
  await page.waitForFunction(() => typeof window.drawLiveShell === 'function', null, { timeout: 20_000 });
  const restShell = await page.evaluate(() => window.drawLiveShell(true));
  const restShellImage = await decodePNG(await canvas.screenshot());
  const liveShell = await page.evaluate(() => window.drawLiveShell(false));
  const liveShellImage = await canvas.screenshot();
  const shellPixels = changedPixels(restShellImage, await decodePNG(liveShellImage));
  assert.equal(restShell.dent, 0);
  assert.equal(liveShell.visible, 1);
  assert.ok(liveShell.dent > 0.005 && shellPixels > 32);
  assert.deepEqual(await page.evaluate(() => window.drawLiveShell(false)), liveShell);
  assert.deepEqual(await canvas.screenshot(), liveShellImage);
  assert.deepEqual(errors, []);
  await writeFile(`test-results/break03-live-shell-${device}.png`, liveShellImage);
  console.log(
    `Distributed sheet: ${(1000 * liveShell.dent).toFixed(2)} mm live displacement, ${shellPixels} changed pixels.`,
  );
  await page.waitForFunction(() => typeof window.drawCohesiveSeam === 'function', null, { timeout: 20_000 });
  const intactSeam = await page.evaluate(() => window.drawCohesiveSeam(true));
  const intactSeamImage = await decodePNG(await canvas.screenshot());
  const tornSeam = await page.evaluate(() => window.drawCohesiveSeam(false));
  const tornSeamImage = await canvas.screenshot();
  const tearPixels = changedPixels(intactSeamImage, await decodePNG(tornSeamImage));
  assert.equal(intactSeam.openingArea, 0);
  assert.equal(tornSeam.broken, true);
  assert.ok(tornSeam.openingArea > 0.1 && tearPixels > 32);
  assert.deepEqual(await page.evaluate(() => window.drawCohesiveSeam(false)), tornSeam);
  assert.deepEqual(await canvas.screenshot(), tornSeamImage);
  assert.deepEqual(errors, []);
  await writeFile(`test-results/break03-sheet-seam-${device}.png`, tornSeamImage);
  console.log(`Cohesive seam: ${tornSeam.openingArea.toFixed(4)} m² opening, ${tearPixels} changed pixels.`);
} finally {
  await close();
}
