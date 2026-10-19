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
const pixel = async (y = 0.5, x = 0.5) => {
  const image = await decodePNG(await page.locator('canvas').screenshot()),
    o = (Math.floor(image.height * y) * image.width + Math.floor(image.width * x)) * 4;
  return [...image.data.slice(o, o + 3)];
};
/** Pixels of the canvas's middle row that are red (an unlit red surface). */
const redWidth = async () => {
  const image = await decodePNG(await page.locator('canvas').screenshot()),
    row = Math.floor(image.height / 2) * image.width;
  let n = 0;
  for (let x = 0; x < image.width; x++) if (image.data[(row + x) * 4] > 200 && image.data[(row + x) * 4 + 1] < 60) n++;
  return n;
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
  highlight = ((0.1 * 32) / (8 * Math.PI)) * 2,
  // A clustered point light 1 unit away (intensity 2, range 100: window (1 - 1e-8)^2), straight on: n.l = n.h = 1.
  local = (base * 2) / Math.PI;
const gray = (v) => display([v, v, v]),
  lambert = (n, l) => Math.max(0, n.reduce((s, x, k) => s + x * l[k], 0) / Math.hypot(...n) / Math.hypot(...l));
const expected = {
  clusteredLambert: display([local, local, local]),
  clusteredPhong: display([local + highlight, local + highlight, local + highlight]),
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
  // White at alpha 128/255 over the clear colour [5, 6, 9].
  alphaBlend: [5, 6, 9].map((b) => Math.round((255 * 128) / 255 + (b * 127) / 255)),
  // Bumped normal (-256/255, 0, 1) normalised, lit from (-1, 0, 1) (towards it) or (1, 0, 1) (away: n.l clamps to 0).
  bumpFacing: gray(local * lambert([-256 / 255, 0, 1], [-1, 0, 1])),
  bumpAway: [0, 0, 0],
  bumpNormalMap: gray(local * lambert([-256 / 255, 0, 1], [-1, 0, 1])),
  // The displaced caster's shadow lies off the centre: the wall at n.l = cos 45 under the sun (irradiance 2) or the
  // point light (intensity 8 at distance sqrt 8, window (1 - (sqrt 8 / 20)^4)^2).
  displacedShadow: gray(local * Math.SQRT1_2),
  displacedLocalShadow: gray((base / Math.PI) * Math.SQRT1_2 * (1 - (Math.SQRT2 / 10) ** 4) ** 2),
  // Base colour times a white lightmap (intensity 1), unlit white times sRGB 128.
  lightMapLambert: gray(base),
  lightMapUnlit: [128, 128, 128],
  emissiveIntensity: gray(0.5),
  flatShading: gray(local),
  vertexColors: [255, 0, 0],
  vertexColorsTint: [0, 0, 255],
  displacedHookShadow: gray((base / Math.PI) * Math.SQRT1_2 * (1 - (Math.SQRT2 / 10) ** 4) ** 2),
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
    'swap',
    'sampler',
    'canvasRegion',
    'lambert',
    'phong',
    'phongFog',
    'iblLambert',
    'iblStandard',
    'clusteredLambert',
    'clusteredPhong',
    'alphaMap',
    'alphaBlend',
    'bumpFacing',
    'bumpAway',
    'bumpNormalMap',
    'lightMapLambert',
    'emissiveIntensity',
    'flatShading',
    'vertexColors',
    'vertexColorsTint',
    'lightMapUnlit',
    'displace',
    'displaceInstanced',
    'displacedShadow',
    'displacedLocalShadow',
    'displacedHookShadow',
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
    if (name === 'swap') {
      near(center, [255, 0, 0], 'the first material');
      await step();
      near(await pixel(), [128, 128, 255], 'swapped to normal shading');
      await step();
      near(await pixel(), [0, 0, 255], 'swapped back to unlit, another colour');
    }
    if (name === 'sampler') {
      const left = await pixel(0.5, 0.4);
      near(left, [255, 0, 0], 'nearest: the left texel only');
      await step();
      const blended = await pixel(0.5, 0.4);
      assert.ok(blended[2] > 40 && blended[0] > 100, 'linear: the left texel blends in the right one: ' + blended);
    }
    if (name === 'canvasRegion') {
      near(await pixel(0.3), [0, 255, 0], 'region before');
      await step();
      near(await pixel(0.3), [255, 0, 0], 'the updated region (image top, flipY) shows the new pixels');
      near(await pixel(0.7), [0, 255, 0], 'outside the region the texture keeps its old pixels');
    }
    if (name === 'vertexColors') {
      await step();
      near(await pixel(), [255, 255, 255], 'vertexColors false, live: the vertex colours are ignored');
    }
    if (name === 'flatShading') {
      await step();
      near(await pixel(), gray(local * Math.SQRT1_2), 'smooth again, live: the leaning vertex normals');
    }
    if (name === 'emissiveIntensity') {
      await step();
      near(await pixel(), gray(0.7), 'emissive 0.25 at intensity 2.8, live');
    }
    if (name === 'lightMapLambert') {
      near(await pixel(0.5, 0.3), gray(base), 'lightMap reads UV1 (the white texel), not UV0 (black on the left)');
      await step();
      near(await pixel(), gray(base * 0.5), 'lightMapIntensity 0.5, live');
    }
    if (name === 'displace' || name === 'displaceInstanced') {
      const displaced = await redWidth();
      await step();
      const flat = await redWidth();
      assert.ok(Math.abs(displaced / flat - 1.5) < 0.03, `displaced 1 of 3 units nearer: ${displaced} / ${flat} px`);
      console.log('  red width displaced / flat', displaced, flat);
    }
    if (name.startsWith('displaced')) {
      await step();
      const shadowed = await pixel();
      assert.ok(Math.max(...shadowed) < 0.25 * Math.max(...center), `${name} undisplaced shadow: ${shadowed}`);
      console.log('  undisplaced caster shadow', shadowed);
    }
    if (name === 'bumpAway') {
      await step();
      near(await pixel(), gray(local * Math.SQRT1_2), 'bumpMap removed live: the flat normal at 45 degrees');
    }
    if (name === 'alphaMap') {
      near(await pixel(0.5, 0.4), [5, 6, 9], 'alphaMap green 0 cuts at alphaTest 0.5');
      near(await pixel(0.5, 0.6), [255, 0, 0], 'alphaMap green 255 keeps the surface');
      await step();
      near(await pixel(0.5, 0.4), [255, 0, 0], 'alphaMap removed live');
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
