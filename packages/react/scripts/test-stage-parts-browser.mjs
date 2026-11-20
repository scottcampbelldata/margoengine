// Real-GPU checks of Mask and the other staging components (`MARGO_COMPAT=1` for the WebGL2 layer).
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/stage-parts-browser.html' });
const { page } = browser,
  errors = [],
  rows = [];
page.setDefaultTimeout(30000);
page.on('pageerror', (error) => errors.push(error.message));
const pixel = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
const red = (p) => p[0] > 120 && p[1] < 40 && p[2] < 40;
const dark = (p) => p.every((v) => v < 30);
// Each mode: what the centre and the corner of the canvas must show.
const checks = {
  caustics: 'caustics',
  'accumulative-shadows': 'accumulative-shadows',
  'marching-cubes': { centre: red, corner: dark },
  sampler: { centre: red, corner: dark },
  depth: 'depth',
  mask: { centre: red, corner: dark },
  'mask-inverse': { centre: dark, corner: red },
};
try {
  await page.waitForFunction(() => window.stageParts);
  const selected = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
  for (const mode of selected ? [selected] : Object.keys(checks)) {
    await page.evaluate((mode) => window.stageParts.mount(mode), mode);
    await page.waitForFunction(() => window.stageParts.state.frames > 20);
    assert.deepEqual(await page.evaluate(() => window.stageParts.state.errors), [], mode);
    if (checks[mode] === 'caustics') {
      // Photons focused by the ball: a bright spot under it, near the map centre, well above the mean.
      await page.waitForFunction(() => window.stageParts.state.caustics);
      const map = await page.evaluate(() => window.stageParts.readCaustics());
      assert.ok(map.finite, `${mode}: finite irradiance`);
      assert.ok(map.max > 3 * map.mean, `${mode}: focused, max ${map.max} mean ${map.mean}`);
      const centre = map.resolution / 2;
      assert.ok(Math.hypot(map.x - centre, map.y - centre) < map.resolution / 4, `${mode}: focus at ${map.x},${map.y}`);
      rows.push({ mode, ...map });
      continue;
    }
    if (checks[mode] === 'accumulative-shadows') {
      await page.waitForFunction(() => window.stageParts.state.accumulative?.samples >= 32);
      const info = await page.evaluate(() => {
        const a = window.stageParts.state.accumulative;
        return JSON.stringify({ samples: a.samples, entries: a.entries?.size, stats: a.stats });
      });
      // World x = -1 and +1 on the plane: the box's white shadow and the clear mirror spot (camera 4 away, fov 50).
      const image = await decodePNG(await page.locator('section canvas').screenshot()),
        unit = image.height / 2 / (4 * Math.tan((25 * Math.PI) / 180)),
        at = (x, y) => pixel(image, Math.round(image.width / 2 + x * unit), Math.round(image.height / 2 - y * unit)),
        sum = (p) => p[0] + p[1] + p[2],
        shadow = [at(-1, 0.8), at(-1, -0.8)],
        lit = [at(1, 0.8), at(1, -0.8)];
      for (const [i, kind] of ['PbrMaterial', 'TextureMaterial'].entries()) {
        assert.ok(sum(lit[i]) < 60, `${mode} ${kind}: clear spot ${lit[i]} ${info}`);
        assert.ok(sum(shadow[i]) > 450, `${mode} ${kind}: shadow ${shadow[i]} against ${lit[i]} ${info}`);
      }
      rows.push({ mode, shadow, lit });
      continue;
    }
    if (checks[mode] === 'depth') {
      // The plane covers the centre: its depth differs from the cleared corner, which keeps the clear value.
      // Drawn for its first 3 frames only; the texture keeps that depth after the view is gone.
      assert.deepEqual(await page.evaluate(() => window.stageParts.state.engine.views?.map((v) => Boolean(v.target))), [
        false,
      ]);
      const [centre, corner] = await page.evaluate(() => window.stageParts.readDepth());
      assert.ok(centre > 0 && centre < 1, `${mode}: centre depth ${centre}`);
      assert.ok(corner === 0 || corner === 1, `${mode}: corner depth ${corner}`);
      rows.push({ mode, centre, corner });
      continue;
    }
    const image = await decodePNG(await page.locator('section canvas').screenshot()),
      centre = pixel(image, image.width >> 1, image.height >> 1),
      corner = pixel(image, 4, 4);
    assert.ok(checks[mode].centre(centre), `${mode}: centre ${centre}`);
    assert.ok(checks[mode].corner(corner), `${mode}: corner ${corner}`);
    rows.push({ mode, centre, corner });
  }
  await page.evaluate(() => window.stageParts.unmount());
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/react-stage-parts${compatRun() ? '-compat' : ''}.json`,
    JSON.stringify({ hardware: browser.hardware, rows }, null, 2),
  );
  console.log(JSON.stringify(rows));
} finally {
  await browser.close();
}
