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

async function fenderTake(device) {
  const { cue, approach, loaded, end, mass, speed } = await page.evaluate(() => window.openFender());
  async function draw(shotFrame, options = {}) {
    const { image, ...state } = await page.evaluate((input) => window.drawFender(input), { shotFrame, ...options });
    const png = Buffer.from(image, 'base64');
    assert.ok(state.visible >= 12);
    return { png, pixels: await decodePNG(png), state };
  }
  function same(actual, expected) {
    assert.deepEqual(actual.state, expected.state);
    assert.deepEqual(actual.pixels.data, expected.pixels.data);
  }

  const before = await draw(cue - 1);
  assert.deepEqual(before.state.velocity, [0, 0, 0]);
  assert.equal(before.state.inward, 0);
  assert.equal(before.state.plastic, 0);
  same(await draw(cue), before);

  const moving = await draw(approach, { action: 'save' });
  assert.ok(Math.abs(moving.state.velocity[2] + speed) < 1e-6);
  assert.equal(moving.state.compression, 0);
  assert.equal(moving.state.inward, 0);
  const contact = await draw(loaded);
  assert.ok(contact.state.inward > 0.01 && contact.state.compression > 0.002 && contact.state.plastic > 0);
  assert.ok(Math.abs(contact.state.velocity[2]) < 0.1 * speed, 'contact almost stops the carriage');
  const contactControl = await draw(loaded, { flatten: true });
  assert.deepEqual(contactControl.state, contact.state);
  const loadPixels = changedPixels(contact.pixels, contactControl.pixels);
  assert.ok(loadPixels > 50, `only ${loadPixels} pixels show the loaded fender skin`);

  const released = await draw(end);
  const after = released.state;
  assert.equal(after.compression, 0);
  assert.ok(after.velocity[2] > 0 && after.velocity[2] < speed, 'the integrated reaction returns the carriage');
  assert.ok(after.position[2] > before.state.position[2]);
  assert.ok(after.inward > 0.001 && after.inward < contact.state.inward);
  assert.ok(after.plastic >= contact.state.plastic);
  const speedNow = Math.hypot(...after.velocity);
  assert.ok(
    after.plastic < (mass * (speed ** 2 - speedNow ** 2)) / 2,
    'absorbed yield work fits the lost carriage energy',
  );
  // One accepted interval per tick. Allow f32 roundoff of the rigid velocity and forces over the whole sequence.
  const momentum = mass * (after.velocity[2] + speed);
  const roundoff = 4 * 2 ** -24 * after.tick * momentum;
  assert.ok(Math.abs(after.impulse - momentum) <= roundoff, 'contact impulse accounts for measured recoil');
  const unloadedControl = await draw(end, { flatten: true });
  assert.deepEqual(unloadedControl.state, after);
  const releasePixels = changedPixels(released.pixels, unloadedControl.pixels);
  assert.ok(releasePixels > 10, `only ${releasePixels} pixels show the unloaded skin`);
  const parked = await draw(end, { parked: true });
  assert.equal(parked.state.plastic, 0);
  assert.equal(parked.state.impulse, 0);
  assert.equal(parked.state.inward, 0);
  assert.deepEqual(parked.pixels.data, before.pixels.data);

  same(await draw(end + 10), released);
  same(await draw(approach, { action: 'restore' }), moving);
  same(await draw(loaded), contact);
  same(await draw(end), released);
  same(await draw(cue - 1), before);
  same(await draw(end), released);
  assert.deepEqual(await page.evaluate(() => window.closeFender()), { errors: [], validation: null });
  await writeFile(`test-results/break03-fender-loaded-${device}.png`, contact.png);
  await writeFile(`test-results/break03-fender-released-${device}.png`, released.png);
  console.log(
    `Dock fender ${device}: ${(1000 * contact.state.inward).toFixed(2)} mm loaded (${loadPixels} pixels), ` +
      `${(1000 * after.inward).toFixed(2)} mm unloaded (${releasePixels} pixels), ` +
      `${after.velocity[2].toFixed(4)} m/s recoil, ${after.plastic.toFixed(3)} J dissipated, ${after.hash}.`,
  );
}

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
  const lowFriction = await page.evaluate(() => window.drawGlancingShell(0));
  const lowFrictionImage = await decodePNG(await canvas.screenshot());
  const glancing = await page.evaluate(() => window.drawGlancingShell(0.28));
  const glancingImage = await canvas.screenshot();
  const glancingPixels = changedPixels(lowFrictionImage, await decodePNG(glancingImage));
  assert.deepEqual(lowFriction.omega, [0, 0, 0]);
  assert.equal(glancing.visible, 1);
  assert.ok(glancing.omega[1] > 0.05 && glancingPixels > 32);
  assert.deepEqual(await page.evaluate(() => window.drawGlancingShell(0.28)), glancing);
  assert.deepEqual(await canvas.screenshot(), glancingImage);
  await writeFile(`test-results/break03-friction-shell-${device}.png`, glancingImage);
  console.log(`Glancing sheet contact: ${glancingPixels} pixels, ${glancing.omega[1].toFixed(3)} rad/s spin.`);
  await page.evaluate(() => window.drawFoldedShell(false));
  const singleContactImage = await decodePNG(await canvas.screenshot());
  const multipleContact = await page.evaluate(() => window.drawFoldedShell(true));
  const multipleContactImage = await canvas.screenshot();
  const foldPixels = changedPixels(singleContactImage, await decodePNG(multipleContactImage));
  assert.equal(multipleContact.visible, 1);
  assert.ok(multipleContact.wall > 0.002 && multipleContact.floor > 0.002 && foldPixels > 32);
  assert.deepEqual(await page.evaluate(() => window.drawFoldedShell(true)), multipleContact);
  assert.deepEqual(await canvas.screenshot(), multipleContactImage);
  await writeFile(`test-results/break03-folded-shell-${device}.png`, multipleContactImage);
  console.log(
    `Folded shell: ${foldPixels} pixels, ${(1000 * multipleContact.wall).toFixed(2)} mm wall and ${(1000 * multipleContact.floor).toFixed(2)} mm floor movement.`,
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
  await fenderTake(device);
  assert.deepEqual(errors, []);
} finally {
  await close();
}
