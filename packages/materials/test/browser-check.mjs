// Real-adapter check (run from the repository root after building packages): node packages/materials/test/browser-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/materials/test/browser-check.html', port: 5207 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());
});
const pixel = async (y = 0.5) => {
  const image = await decodePNG(await page.locator('canvas').screenshot()),
    o = (Math.floor(image.height * y) * image.width + Math.floor(image.width / 2)) * 4;
  return [...image.data.slice(o, o + 3)];
};
const near = (actual, expected, label, tolerance = 3) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${label}: ${actual} != ${expected}`,
  );
// Margo's display transform (Khronos PBR Neutral, then sRGB), as packages/shared/display.js computes it.
const display = (c) => {
  const x = Math.min(...c),
    offset = x < 0.08 ? x - 6.25 * x * x : 0.04,
    v = c.map((value) => value - offset),
    peak = Math.max(...v);
  assert.ok(peak < 0.76, 'reference stays below the tone-map shoulder');
  return v.map((value) => Math.round(255 * (value >= 0.0031308 ? 1.055 * value ** (1 / 2.4) - 0.055 : value * 12.92)));
};
// The lit scenarios: base sRGB 188 under irradiance 2 from the viewer, ambient 0.1 times the hemisphere at n.y = 0.
const base = ((188 / 255 + 0.055) / 1.055) ** 2.4,
  diffuse = [0.675, 0.65, 0.625].map((sky) => base * (2 / Math.PI + 0.1 * sky)),
  // Blinn-Phong at n.h = 1: specular 0.1 * (30 + 2) / (8 pi) * n.l (1) * irradiance (2).
  highlight = ((0.1 * 32) / (8 * Math.PI)) * 2;
const expected = {
  lambert: display(diffuse),
  phong: display(diffuse.map((d) => d + highlight)),
  phongFog: [255, 0, 255],
  iblLambert: [0, 0, 0],
  loaded: [255, 128, 0],
  basic: [0, 0, 255],
  canvas: [0, 255, 0],
  normal: [128, 128, 255],
  matcap: [255, 128, 0],
  transparent: [130, 3, 4],
  additive: [5, 194, 9],
  mask: [5, 6, 9],
  video: [255, 0, 255],
};
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });
  for (const name of [
    'loaded',
    'basic',
    'canvas',
    'flipTop',
    'normal',
    'standard',
    'matcap',
    'transparent',
    'additive',
    'mask',
    'effects',
    'geometry',
    'canvasRegion',
    'lambert',
    'phong',
    'phongFog',
    'iblLambert',
    'iblStandard',
    'litEffects',
    'video',
  ]) {
    if (name === 'video') await page.evaluate(() => window.videoStep('#ff00ff'));
    const result = await page.evaluate((n) => window.check.run(n), name),
      center = await pixel();
    assert.equal(result.error, null, name);
    assert.deepEqual(result.errors, [], name);
    if (expected[name]) near(center, expected[name], name);
    if (name === 'flipTop') {
      near(await pixel(0.3), [255, 0, 0], 'image top at UV v=1');
      near(await pixel(0.7), [0, 0, 255], 'image bottom at UV v=0');
    }
    const step = async () => assert.deepEqual(await page.evaluate(() => window.check.step()), [], name + ' step');
    if (name === 'geometry') {
      near(center, [5, 6, 9], 'the first quad is off centre');
      await step();
      near(await pixel(), [0, 0, 255], 'a full update covers the centre');
      await step();
      near(await pixel(), [255, 0, 0], 'a ranged UV update samples the red top');
    }
    if (name === 'canvasRegion') {
      near(await pixel(0.3), [0, 255, 0], 'region before');
      await step();
      near(await pixel(0.3), [255, 0, 0], 'the updated region (image top, flipY) shows the new pixels');
      near(await pixel(0.7), [0, 255, 0], 'outside the region the texture keeps its old pixels');
    }
    if (name === 'iblLambert' || name === 'iblStandard') {
      if (name === 'iblStandard') assert.ok(Math.max(...center) > 3, 'a black dielectric reflects the sky: ' + center);
      await step();
      const white = await pixel();
      assert.ok(Math.min(...white) > 40, name + ' white base takes the sky diffuse: ' + white);
      console.log('  white base', white);
    }
    if (name === 'standard' || name === 'effects' || name === 'litEffects')
      assert.ok(
        center.some((v, i) => Math.abs(v - [5, 6, 9][i]) > 20),
        name + ' drew nothing',
      );
    if (name === 'canvas') {
      assert.deepEqual(await page.evaluate(() => window.check.greenToYellow()), []);
      near(await pixel(), [255, 255, 0], 'canvas update');
    }
    if (name === 'video')
      for (const [color, rgb] of [
        ['#00ffff', [0, 255, 255]],
        ['#ffffff', [255, 255, 255]],
      ]) {
        const step = await page.evaluate((c) => window.videoStep(c), color);
        assert.deepEqual(step.errors, []);
        near(await pixel(), rgb, 'video frame ' + color);
      }
    console.log('ok', name, center);
    await page.evaluate(() => window.check.clear());
  }
  assert.deepEqual(pageErrors, []);
  console.log('materials browser check passed');
} finally {
  await context.close();
}
