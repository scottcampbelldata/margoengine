// The lowercase tags of @margoengine/react/jsx-runtime on a real GPU: a page compiled with jsxImportSource
// '@margoengine/react' draws <mesh>, <group>, <boxGeometry>, <meshStandardMaterial>, <directionalLight> and an extend()
// tag, checked by the colours of its screenshot; then real mouse clicks check that pointer events bubble. Takes the GPU
// lock.
//   npm run test:browser:tags --workspace @margoengine/react
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const release = await acquire({ owner: 'react-tags-browser' });
const browser = await openBrowser({ port: 5381, startPath: '/packages/react/tests/tags-browser.html' }),
  { page, hardware } = browser;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
// Mean colour of a square of the screenshot around (x, y), in fractions of its size.
const sample = (image, x, y, half = 6) => {
  const sum = [0, 0, 0];
  let count = 0;
  for (let j = -half; j <= half; j++)
    for (let i = -half; i <= half; i++) {
      const at = (Math.round(y * image.height + j) * image.width + Math.round(x * image.width + i)) * 4;
      for (let c = 0; c < 3; c++) sum[c] += image.data[at + c];
      count++;
    }
  return sum.map((value) => Math.round(value / count));
};
const dominant = (rgb, channel) =>
  rgb[channel] > 60 && rgb[channel] > 1.6 * Math.max(...rgb.filter((_, c) => c !== channel));
const result = { hardware, checks: [] };
try {
  await page.waitForFunction(() => window.tags);
  // After 30 frames the screenshot is taken again, five frames apart, until `drawn` holds or 30 s have passed.
  const shot = async (mode, drawn) => {
    await page.evaluate((mode) => window.tags.mount(mode), mode);
    await page.waitForFunction(() => window.tags.state.frames >= 30, null, { timeout: 30_000 });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const image = await decodePNG(
        await page.locator('#app canvas').screenshot({ path: `test-results/react-tags-${mode}.png` }),
      );
      if (drawn(image) || Date.now() > deadline) return image;
      const frames = await page.evaluate(() => window.tags.state.frames);
      await page.waitForFunction((n) => window.tags.state.frames >= n + 5, frames, { timeout: 30_000 });
    }
  };
  const image = await shot('tags', (i) => dominant(sample(i, 0.3, 0.5), 0) && dominant(sample(i, 0.7, 0.5), 2));
  const box = sample(image, 0.3, 0.5),
    sphere = sample(image, 0.7, 0.5),
    gap = sample(image, 0.5, 0.5);
  assert.ok(dominant(box, 0), `<mesh><boxGeometry><meshStandardMaterial> draws the red box, got ${box}`);
  assert.ok(dominant(sphere, 2), `the extend() tag <sphereGeometry> draws the blue sphere, got ${sphere}`);
  assert.ok(!dominant(gap, 0) && !dominant(gap, 2), `nothing is drawn between them, got ${gap}`);
  assert.equal(await page.locator('#app mesh, #app group, #app sphereGeometry').count(), 0, 'no tag reached the DOM');
  result.checks.push({ name: 'Lowercase tags and an extend() tag draw on a real engine', box, sphere, gap });

  // Bubbling with real clicks: GPU picking finds the hit mesh, then the event climbs to its parents.
  await shot('bubbling', (i) => dominant(sample(i, 0.3, 0.5), 0) && dominant(sample(i, 0.7, 0.5), 2));
  const bounds = await page.locator('#app canvas').boundingBox();
  const at = (x) => [bounds.x + x * bounds.width, bounds.y + 0.5 * bounds.height];
  // The entries logged since the last call, waiting for `count` of them; hover entries (over, enter) count only when
  // `hover` is set, since a click moves the mouse first and hovering over a new mesh is not what a click step checks.
  const events = async (count, hover = false) => {
    await page.waitForFunction(
      ([n, hover]) => window.tags.state.events.filter((entry) => hover || !/ (over|enter)$/.test(entry)).length >= n,
      [count, hover],
      { timeout: 10_000 },
    );
    // A further event, had one been sent, would come within a few frames.
    const frames = await page.evaluate(() => window.tags.state.frames);
    await page.waitForFunction((n) => window.tags.state.frames >= n + 10, frames, { timeout: 10_000 });
    const entries = await page.evaluate(() => window.tags.state.events.splice(0));
    return entries.filter((entry) => hover || !/ (over|enter)$/.test(entry));
  };
  await page.mouse.move(...at(0.3));
  const hover = await events(4, true);
  assert.deepEqual(hover, ['box over', 'group over', 'group enter', 'box enter'], 'over bubbles, enter goes outside in');
  await page.mouse.click(...at(0.3));
  const boxClick = await events(2);
  assert.deepEqual(boxClick, ['box click true', 'group click on child'], 'a click on the box bubbles to its group');
  await page.mouse.click(...at(0.7));
  const sphereClick = await events(1);
  assert.deepEqual(sphereClick, ['sphere click'], 'stopPropagation keeps the click at the sphere');
  await page.mouse.click(...at(0.5));
  const empty = await events(2);
  assert.deepEqual(empty, ['group missed pointerup', 'canvas missed pointerup'], 'a click on nothing is missed');
  result.checks.push({ name: 'Pointer events bubble on a real engine', hover, boxClick, sphereClick, empty });

  // Textured shapes: a Plane with a real JPEG and a Box with a real PNG. A texture shows as colours that vary across
  // the face (samples inside each face only), where an untextured face is one colour lit evenly; the box click comes
  // from its drawn child.
  const across = (image, from, to) => Array.from({ length: 7 }, (_, i) => sample(image, from + ((to - from) * i) / 6, 0.5, 2));
  const spread = (samples) => Math.max(...[0, 1, 2].map((c) => Math.max(...samples.map((s) => s[c])) - Math.min(...samples.map((s) => s[c]))));
  const textured = await shot('textured', (i) => spread(across(i, 0.29, 0.47)) > 40 && spread(across(i, 0.61, 0.71)) > 20);
  const plane = across(textured, 0.29, 0.47),
    boxFace = across(textured, 0.61, 0.71);
  assert.ok(spread(plane) > 40, `the JPEG shows on the plane, samples ${JSON.stringify(plane)}`);
  assert.ok(spread(boxFace) > 20, `the PNG shows on the box, samples ${JSON.stringify(boxFace)}`);
  await page.mouse.click(...at(0.65));
  const texturedClick = await events(1);
  assert.deepEqual(texturedClick, ['box click child'], 'a click on the textured box reaches its onClick');
  result.checks.push({ name: 'Textured Plane and Box draw their maps', plane, boxFace, texturedClick });

  await page.evaluate(() => window.tags.unmount());
  assert.deepEqual(await page.evaluate(() => window.tags.state.errors), []);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/react-tags-browser.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  release();
}
