// Real-adapter check of the stage's model viewer: `addViewer` with a real glTF on real WebGPU, in each shadow mode. The
// model must fill the frame, the shadow must darken the ground under it, the turntable must keep the distance and the
// target, dispose must leave nothing behind, and WebGPU must report no error.
// Run from the repository root after building packages (`npm run test:gpu --workspace packages/stage`).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';

const release = await acquire({ owner: 'stage-viewer-gpu-check', max: 10 });
const browser = await openBrowser({ startPath: '/tests/stage-viewer.html' });
const { page } = browser;
const shot = async (name) => {
  const bytes = await page.locator('#scene canvas').screenshot();
  await writeFile(`test-results/stage-viewer-${name}.png`, bytes);
  return decodePNG(bytes);
};
const luma = (image, x0, y0, x1, y1) => {
  let sum = 0,
    count = 0;
  for (let y = Math.floor(y0 * image.height); y < y1 * image.height; y++)
    for (let x = Math.floor(x0 * image.width); x < x1 * image.width; x++) {
      const i = (y * image.width + x) * 4;
      sum += 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
      count++;
    }
  return sum / count;
};
/** Share of pixels that differ from the corner's colour: how much of the frame the scene covers. */
const covered = (image) => {
  let hit = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if (Math.abs(image.data[i] - image.data[0]) + Math.abs(image.data[i + 1] - image.data[1]) > 12) hit++;
  return hit / (image.data.length / 4);
};
const distance = ({ position, target }) => Math.hypot(...position.map((v, i) => v - target[i]));
const open = (options) => page.evaluate((o) => window.viewerPage.open(o), options);
const close = () => page.evaluate(() => window.viewerPage.close());
const results = {};
try {
  await page.waitForFunction(() => window.viewerPage, null, { timeout: 60_000 });

  const bare = await open({ shadows: false, turntable: false });
  assert.deepEqual(bare.plugins, ['environment', 'environment:lighting', 'background', 'tonemap']);
  const plain = await shot('bare');
  assert.deepEqual((await close()).gpuErrors, []);

  const contact = await open({ turntable: false });
  assert.deepEqual(contact.plugins, ['environment', 'environment:lighting', 'background', 'contact-shadows', 'tonemap']);
  const shaded = await shot('contact');
  const under = [0.3, 0.8, 0.7, 0.95];
  results.contact = { plain: luma(plain, ...under), shaded: luma(shaded, ...under), covered: covered(shaded) };
  assert.ok(results.contact.covered > 0.1, `the model covers ${results.contact.covered} of the frame`);
  assert.ok(results.contact.shaded < results.contact.plain - 1, `no shadow: ${JSON.stringify(results.contact)}`);
  const left = await close();
  assert.deepEqual(left, { plugins: [], meshes: 0, gpuErrors: [] });

  const cascaded = await open({ shadows: 'cascaded', turntable: { seconds: 4 } });
  assert.deepEqual(cascaded.plugins, ['environment', 'environment:lighting', 'background', 'shadows', 'tonemap']);
  const first = await shot('cascaded');
  await page.evaluate(() => window.viewerPage.frames(30));
  const later = await page.evaluate(() => window.viewerPage.camera()),
    second = await shot('cascaded-turned');
  results.cascaded = { before: cascaded.position, after: later.position };
  assert.notDeepEqual(later.position, cascaded.position, 'the turntable did not turn');
  assert.deepEqual(later.target, cascaded.target);
  assert.ok(Math.abs(distance(later) - distance(cascaded)) < distance(cascaded) * 1e-4, 'the distance changed');
  assert.equal(later.position[1], cascaded.position[1], 'the height changed');
  assert.ok(covered(first) > 0.1 && covered(second) > 0.1);
  assert.deepEqual(await close(), { plugins: [], meshes: 0, gpuErrors: [] });

  // The cast shadow falls away from the sun at +x +y +z: seen from the side, it lies on the floor in frame.
  const cast = await open({ shadows: 'cascaded', turntable: false }),
    side = [cast.target[0] + 0.9, cast.position[1], cast.target[2] - 0.5];
  await page.evaluate((position) => window.viewerPage.look(position), side);
  const lit = await shot('cascaded-side');
  await page.evaluate(() => window.viewerPage.dropShadow());
  const unlit = await shot('cascaded-side-unshadowed');
  results.cascaded.floor = { shadowed: luma(lit, 0, 0.45, 1, 1), plain: luma(unlit, 0, 0.45, 1, 1) };
  assert.ok(results.cascaded.floor.shadowed < results.cascaded.floor.plain - 0.5, 'no cast shadow on the floor');
  assert.deepEqual((await close()).gpuErrors, []);

  const scene = await page.evaluate(() => window.viewerPage.scene());
  results.scene = scene;
  assert.ok(scene.bounds[0] > 4 && scene.bounds[3] < 6, `the model is not under its parent: ${scene.bounds}`);
  assert.ok(scene.bounds[1] >= 0.99, `the model is not 1 above its parent: ${scene.bounds}`);
  assert.equal(scene.left, 0, 'addScene left meshes behind');
  assert.deepEqual(scene.gpuErrors, []);

  await writeFile('test-results/stage-viewer.json', JSON.stringify({ hardware: browser.hardware, ...results }, null, 2));
  console.log('Stage viewer passed on real WebGPU', JSON.stringify(results));
} finally {
  await browser.close();
  release();
}
