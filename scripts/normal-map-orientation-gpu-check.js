// Real-GPU check that a normal map's +Y bends the surface up the image for every UV convention: materials meshes
// (three.js orientation, flipY uploads) with derived, authored and mirrored-UV1 frames, and glTF quads (texture origin at
// the upper-left) with derived and authored tangents. A map tilted toward image-up must light brighter from image-up
// than from image-down, and a raised dome's image-top half must light brighter than its bottom half.
// Measured 2026-10-19 (Arc 140V, mean RGB): every case tilt 221 from up / 75 from down, dome top 222 / bottom 96-99.
// From ffd0f05e until materials' feature letter n, 'mesh' and 'mesh-uv1' read 75 / 221 and 96-99 / 222: dents.
// Run: node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/normal-map-orientation-gpu-check.js [--measure]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { decodePNG } from '../tests/support/png.js';

const release = await acquire({ owner: 'normal-map-orientation-gpu-check' }),
  output = 'test-results/normal-map-orientation',
  measure = process.argv.includes('--measure'),
  cases = ['mesh', 'gltf', 'gltf-tangents', 'mesh-tangents', 'mesh-uv1'];
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/normal-map-orientation.html', port: 5219 });
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const page = browser.page,
    errors = [],
    results = {};
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.normalOrientation);
  // Mean RGB at canvas pixel (x, y).
  const level = (image, x, y) => {
    const o = (y * image.width + x) * 4;
    return Math.round((image.data[o] + image.data[o + 1] + image.data[o + 2]) / 3);
  };
  async function shot(kind, map, fromUp) {
    const up = await page.evaluate((args) => window.normalOrientation.render(...args), [kind, map, fromUp]),
      label = `${kind}-${map}-${fromUp ? 'up' : 'down'}`;
    return { up, image: await decodePNG(await page.locator('canvas').screenshot({ path: `${output}/${label}.png` })) };
  }
  for (const kind of cases) {
    const lit = (await shot(kind, 'tilt', true)).image,
      shaded = (await shot(kind, 'tilt', false)).image,
      dome = await shot(kind, 'bump', true),
      // 40 pixels (half a unit) above and below the quad's centre, image-top first.
      [top, bottom] = dome.up > 0 ? [80, 160] : [160, 80];
    results[kind] = {
      tiltFromUp: level(lit, 160, 120),
      tiltFromDown: level(shaded, 160, 120),
      bumpImageTop: level(dome.image, 160, top),
      bumpImageBottom: level(dome.image, 160, bottom),
    };
  }
  console.log(JSON.stringify({ hardware: browser.hardware, results }, null, 2));
  await writeFile(`${output}/gpu.json`, JSON.stringify({ hardware: browser.hardware, results }, null, 2) + '\n');
  assert.deepEqual(errors, []);
  if (!measure)
    for (const kind of cases) {
      const r = results[kind];
      assert.ok(r.tiltFromUp > r.tiltFromDown + 60, `${kind}: image-up tilt lit from below: ${JSON.stringify(r)}`);
      assert.ok(r.bumpImageTop > r.bumpImageBottom + 40, `${kind}: dome shades as a dent: ${JSON.stringify(r)}`);
    }
} finally {
  await browser?.page.evaluate(() => window.normalOrientation?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
