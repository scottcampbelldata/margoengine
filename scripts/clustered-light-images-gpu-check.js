// Real-WebGPU check of the clustered light images on examples/package-benchmarks/light-features.html (a grey Lambert
// floor lit through lights.add, core's sun and ambient off, so every lit pixel is the light under test alone):
// 1. textured area lights (@margoengine/clustered/area-texture): a white rectangle light carrying a one-colour image k
//    draws the same pixels, within 2/255, as the plain light of colour k (the shader compiles and the filtered image
//    multiplies both lobes), and an image red on its left half and green on its right lights the floor red on the
//    light's left side and green on its right (the image's orientation on the rectangle).
// Frames go to test-results/clustered-light-images-*.png; nothing is recorded. Run: node
// scripts/clustered-light-images-gpu-check.js (takes the GPU lock, after npm run build:packages).
import assert from 'node:assert/strict';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';

const fill = (width, height, fn) => {
  const data = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.push(...fn(x, y));
  return { width, height, data };
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const release = await acquire({ owner: 'clustered-light-images-gpu-check' });
let browser;
try {
  browser = await openBrowser({ startPath: '/LICENSE', port: 5357 });
  const { page } = browser,
    pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page.goto('http://127.0.0.1:5357/examples/package-benchmarks/light-features.html', { timeout: 300000 });
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const grid = [];
  for (let y = 10; y < 480; y += 16) for (let x = 10; x < 640; x += 20) grid.push([x, y]);
  const rays = await page.evaluate((p) => window.check.unproject(p), grid);
  const shot = async (name, scene) => {
    const result = await page.evaluate((s) => window.check.render(s), scene);
    assert.equal(result.error, null, name);
    assert.deepEqual(result.errors, [], name);
    const img = decodePNG(
      await page.locator('canvas').screenshot({ path: `test-results/clustered-light-images-${name}.png` }),
    );
    return grid.map(([x, y]) => {
      const i = (y * img.width + x) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    });
  };
  const onFloor = (ray) => Math.abs(ray.floor[0]) < 19 && Math.abs(ray.floor[2]) < 19;

  // 1. Textured area light: 2 x 1 at 1.5 m, facing down, its up toward -z (right = up x normal).
  const k = [1, 0.5, 0.25],
    rect = { position: [0, 1.5, 0], direction: [0, -1, 0], up: [0, 0, -1], width: 2, height: 1, intensity: 4 },
    plain = await shot('area-plain', { area: [{ ...rect, color: k }] }),
    flat = await shot('area-flat', {
      area: [rect],
      areaTexture: { ...fill(8, 4, () => [255, 128, 64, 255]), colorSpace: 'linear' },
    });
  let worst = 0,
    lit = 0;
  rays.forEach((ray, i) => {
    if (!onFloor(ray)) return;
    if (Math.max(...plain[i]) > 20) lit++;
    worst = Math.max(worst, ...plain[i].map((v, c) => Math.abs(v - flat[i][c])));
  });
  // k is the image's linear bytes over 255: 128/255 and 64/255 differ from 0.5 and 0.25 by under 0.2%, and half floats
  // add 2^-11; together well under one display level, so two levels allow rounding on both frames.
  console.log(JSON.stringify({ check: 'area-texture flat', lit, maxDiff: worst }));
  assert.ok(lit >= 60, `textured area light: only ${lit} lit samples`);
  assert.ok(worst <= 2, `a one-colour image differs from the plain light by ${worst}/255`);
  const split = await shot('area-split', {
      area: [rect],
      areaTexture: { ...fill(16, 8, (x) => (x < 8 ? [255, 0, 0, 255] : [0, 255, 0, 255])), colorSpace: 'linear' },
    }),
    right = cross(rect.up, rect.direction);
  let red = 0,
    green = 0,
    wrong = [];
  rays.forEach((ray, i) => {
    if (!onFloor(ray) || Math.max(...split[i]) < 20) return;
    const side = dot(ray.floor, right),
      [r, g] = split[i];
    if (side < -1.2) r > g ? red++ : wrong.push({ pixel: grid[i], side, got: split[i] });
    if (side > 1.2) g > r ? green++ : wrong.push({ pixel: grid[i], side, got: split[i] });
  });
  console.log(JSON.stringify({ check: 'area-texture split', red, green, wrong: wrong.length }));
  assert.ok(red >= 10 && green >= 10, `split image: ${red} red and ${green} green samples`);
  assert.deepEqual(wrong.slice(0, 5), [], 'the left of the image lights the left of the floor');
  assert.deepEqual(pageErrors, []);
} finally {
  await browser?.close();
  release();
}
console.log('clustered light images GPU check passed');
