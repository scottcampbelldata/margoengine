// Real-adapter check (run from the repository root after building packages): node packages/shader/test/utils-check.mjs
// The maths nodes run in a compute pass over random inputs against formulas written out in JavaScript here, and the surface
// nodes are drawn on a wall and read back against the slope, projection or line of sight worked out by hand.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const context = await openBrowser({ startPath: '/packages/shader/test/utils-check.html', port: 5231 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const each = (a, b, f) => a.map((x, i) => f(x, b[i]));
const hardLight = (b, t) => (t <= 0.5 ? 2 * t * b : b + (2 * t - 1) - b * (2 * t - 1));
const curve = (x) => (x <= 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x));
const blends = {
  blendAdd: (b, t) => Math.min(b + t, 1),
  blendSubtract: (b, t) => Math.max(b - t, 0),
  blendMultiply: (b, t) => b * t,
  blendScreen: (b, t) => 1 - (1 - b) * (1 - t),
  blendOverlay: (b, t) => hardLight(t, b),
  blendHardLight: hardLight,
  blendDarken: Math.min,
  blendLighten: Math.max,
  blendDifference: (b, t) => Math.abs(b - t),
  blendExclusion: (b, t) => b + t - 2 * b * t,
  blendDodge: (b, t) => (b === 0 ? 0 : t === 1 ? 1 : Math.min(1, b / (1 - t))),
  blendBurn: (b, t) => (b === 1 ? 1 : t === 0 ? 0 : 1 - Math.min(1, (1 - b) / t)),
  blendSoftLight: (b, t) => (t <= 0.5 ? b - (1 - 2 * t) * b * (1 - b) : b + (2 * t - 1) * (curve(b) - b)),
};
const rotate = (v, k, a) => {
  const c = Math.cos(a),
    s = Math.sin(a),
    along = k[0] * v[0] + k[1] * v[1] + k[2] * v[2],
    x = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return v.map((e, i) => e * c + x[i] * s + k[i] * along * (1 - c));
};
const grey = Math.sqrt(1 / 3);
const fract = (x) => x - Math.floor(x);
const maths = {
  luminance: (a) => [luma(a), 0, 0],
  saturation: (a, b) => a.map((x) => luma(a) + (x - luma(a)) * (b[0] * 2)),
  hue: (a, b) => rotate(a, [grey, grey, grey], b[0] * 6),
  rotateUV: (a, b) => {
    const s = Math.sin(b[0] * 6),
      c = Math.cos(b[0] * 6),
      x = a[0] - 0.5,
      y = a[1] - 0.5;
    return [x * c - y * s + 0.5, x * s + y * c + 0.5, 0];
  },
  rotateAxis: (a, b) => rotate(a, [0, 0.6, 0.8], b[0] * 6),
  remap: (a) => a.map((x) => ((x - 0.25) / 0.5) * 4 - 1),
  remapClamp: (a) => a.map((x) => Math.min(1, Math.max(0, (x - 0.25) / 0.5)) * 4 - 1),
  oscSine: (a) => [Math.sin(a[0] * 7 * Math.PI * 2) * 0.5 + 0.5, 0, 0],
  oscSquare: (a) => [fract(a[0] * 7) < 0.5 ? 1 : 0, 0, 0],
  oscTriangle: (a) => [1 - Math.abs(fract(a[0] * 7) * 2 - 1), 0, 0],
  oscSawtooth: (a) => [fract(a[0] * 7), 0, 0],
  ...Object.fromEntries(Object.entries(blends).map(([k, f]) => [k, (a, b) => each(a, b, f)])),
  blendHalf: (a, b) => each(a, b, (x, y) => x + (blends.blendScreen(x, y) - x) * 0.5),
};
const pixel = async (name, y = 0.5, x = 0.5) => {
  const { errors } = await page.evaluate((n) => window.check.run(n), name);
  assert.deepEqual(errors, [], name);
  const image = await decodePNG(await page.locator('canvas').screenshot()),
    o = (Math.floor(image.height * y) * image.width + Math.floor(image.width * x)) * 4,
    value = [...image.data.slice(o, o + 3)];
  await page.evaluate(() => window.check.clear());
  return value;
};
const encode = (v) => Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
const shows = async (name, linear, tolerance = 2) => {
  const actual = await pixel(name),
    expected = linear.map(encode);
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${name}: ${actual} != ${expected}`,
  );
  console.log('ok', name);
};
const unit = (v) => v.map((x) => x / Math.hypot(...v));
const half = (v) => v.map((x) => x * 0.5 + 0.5);
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 30000 });

  const { names, inputs, results, errors } = await page.evaluate(() => window.check.maths());
  assert.deepEqual(errors, []);
  assert.deepEqual([...names].sort(), Object.keys(maths).sort());
  for (const name of Object.keys(maths)) {
    let worst = 0;
    results[name].forEach((row, i) => {
      const expected = maths[name](inputs.a[i], inputs.b[i]);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(row[k] - expected[k]));
    });
    assert.ok(worst < 2e-4, `${name}: off by ${worst}`);
    console.log('ok', name, worst.toExponential(1));
  }
  // A panorama lookup against the layout of @margoengine/environment: the middle faces -z, +x right of it, +y the top row.
  const uvs = await page.evaluate(() => window.check.equirect());
  for (const [got, want] of [
    [uvs.front, [0.5, 0.5]],
    [uvs.right, [0.75, 0.5]],
    [uvs.left, [0.25, 0.5]],
    [uvs.up, [0.5, 1]],
    [uvs.down, [0.5, 0]],
    [uvs.upUnflipped, [0.5, 0]],
  ])
    got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-5, `equirect ${got} != ${want}`));
  console.log('ok equirectUV');

  // The wall lies in x and y and faces the camera: u along +x, v along +y.
  await shows('normalFlat', half([0, 0, 1]));
  await shows('normalRight', half([1, 0, 0]));
  await shows('normalUp', half([0, 1, 0]));
  await shows('normalDown', half([0, -1, 0]));
  await shows('normalTangents', half([0, 1, 0]));
  await shows('normalStrength', half(unit([0.5, 0, 1])), 3);
  // A turned UV turns the frame with it: u now grows along the wall's -y, so the map's +x leans that way.
  await shows('normalTurned', half([0, -1, 0]));
  // Height = 0.5 x: the slope is 1/2, so the normal leans away from it.
  await shows('bump', half(unit([-0.5, 0, 1])), 3);
  await shows('bumpStrength', half(unit([-1, 0, 1])), 3);
  await shows('bumpBack', half(unit([0.5, 0, 1])), 3);
  // Facing +z only the xy projection shows; a diagonal normal shares evenly between its two axes.
  await shows('triplanarZ', [0.25, 0.75, 0]);
  await shows('triplanarShared', [0.375, 0.625, 0]);
  // The camera sits 3 in front of the wall and 3 to the right. A surface 0.4 deep at scale 0.1 shifts u by 0.04 at 45 degrees.
  await shows('parallaxConstant', [0.04 * 5, 0, 0], 3);
  await shows('parallaxTangents', [0.04 * 5, 0, 0], 3);
  await shows('parallaxOneStep', [0.04 * 5, 0, 0], 3);
  await shows('parallaxTop', [0, 0, 0], 1);
  // A ramp, height = u from u0 = 0.5, moving left as depth grows: d = 1 - u0 + 0.1 d, so d = 0.5 / 0.9 and u moves 0.1 d.
  await shows('parallaxRamp', [(0.1 * 0.5) / 0.9 * 5, 0, 0], 3);
  const nodes = [await pixel('matcapNode'), await pixel('matcapNode', 0.35, 0.6)],
    material = [await pixel('matcapMaterial'), await pixel('matcapMaterial', 0.35, 0.6)];
  assert.ok(
    nodes.flat().every((v, i) => Math.abs(v - material.flat()[i]) <= 2),
    `matcapUV reads what MatcapMaterial reads: ${nodes} != ${material}`,
  );
  console.log('ok matcapUV');
  await shows('panoramaTop', [1, 0, 0]);
  await shows('panoramaBottom', [0, 0, 1]);
  assert.deepEqual(pageErrors, []);
  console.log('utils check passed');
} finally {
  await context.close();
}
