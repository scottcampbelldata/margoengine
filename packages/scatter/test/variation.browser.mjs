// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/scatter/test/variation.browser.mjs
// Lit scatter `variation` and `clusters`, as a `Scatter` and as a `ScatterTiles` grid, 400 green objects from above:
// - unset and `{ variation: { hue: 0, value: 0 }, clusters: 0 }` draw the same bytes (the lit vertex stage is the
//   original text when both are off, so the default draws as before the options existed);
// - `variation: { hue: 0.06, value: 0.15 }` spreads the hue of the boxes' pixels to over 3 times the unset spread;
// - `clusters: 0.3` on smooth spheres raises the mean luma step between neighbouring pixels over 1.5 times.
// Before the options existed both were ignored: the spreads matched the unset draw and this check failed.
// Measured 2026-10-30, RTX A6000, against main 0882df47: the unset draw's PNG bytes match main's; main fails here
// (hue 1.34 vs 1.34 degrees). Frame cost, 1440 x 900, 20,000 lit spheres (30.7 M triangles), median of 4 x 120
// frames: off 4.9 ms, variation 4.9 ms, variation plus clusters 4.8 ms (within the 0.1 ms timer step and noise).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/variation.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

/** Pixels of the green objects: saturated enough that their hue is well defined (the background is grey). */
const objectPixels = (image) => {
  const out = [];
  for (let k = 0; k < image.data.length; k += 4) {
    const r = image.data[k],
      g = image.data[k + 1],
      b = image.data[k + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24 && g > r && g > b) out.push(k);
  }
  return out;
};
/** Circular standard deviation of the hue of the object pixels, in degrees. */
const hueSpread = (image) => {
  let c = 0,
    s = 0;
  const pixels = objectPixels(image);
  for (const k of pixels) {
    const [r, g, b] = [image.data[k], image.data[k + 1], image.data[k + 2]],
      angle = Math.atan2((Math.sqrt(3) / 2) * (g - b), r - (g + b) / 2);
    c += Math.cos(angle);
    s += Math.sin(angle);
  }
  const length = Math.hypot(c, s) / pixels.length;
  return { degrees: (Math.sqrt(-2 * Math.log(length)) * 180) / Math.PI, pixels: pixels.length };
};
/** Mean luma step to the right and lower neighbour, over object pixels whose neighbours are object pixels too. */
const lumaStep = (image) => {
  const inside = new Uint8Array(image.width * image.height);
  for (const k of objectPixels(image)) inside[k / 4] = 1;
  const luma = (i) => 0.2126 * image.data[i * 4] + 0.7152 * image.data[i * 4 + 1] + 0.0722 * image.data[i * 4 + 2];
  let sum = 0,
    count = 0;
  for (let y = 0; y < image.height - 1; y++)
    for (let x = 0; x < image.width - 1; x++) {
      const i = y * image.width + x;
      if (!inside[i] || !inside[i + 1] || !inside[i + image.width]) continue;
      sum += Math.abs(luma(i + 1) - luma(i)) + Math.abs(luma(i + image.width) - luma(i));
      count += 2;
    }
  return sum / count;
};

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const draw = async (kind, shape, look) => {
      const errors = await page.evaluate(
        ([kind, shape, look]) => window.check.show(kind, shape, look),
        [kind, shape, look],
      );
      assert.deepEqual(errors, [], `${kind} ${shape} ${JSON.stringify(look)}`);
      const png = await page.locator('canvas').screenshot();
      return { png, image: await decodePNG(png) };
    };
    const results = [];
    for (const kind of ['scatter', 'tiles']) {
      const plain = await draw(kind, 'box', {}),
        off = await draw(kind, 'box', { variation: { hue: 0, value: 0 }, clusters: 0 }),
        tinted = await draw(kind, 'box', { variation: { hue: 0.06, value: 0.15 } });
      assert.ok(plain.png.equals(off.png), `${kind}: variation 0 and clusters 0 draw the same bytes as unset`);
      const before = hueSpread(plain.image),
        after = hueSpread(tinted.image);
      assert.ok(before.pixels > 5000 && after.pixels > 5000, `${kind}: the boxes cover the view (${before.pixels})`);
      assert.ok(
        after.degrees > 3 * before.degrees && after.degrees > 3,
        `${kind}: variation spreads the hue (${after.degrees.toFixed(2)} vs ${before.degrees.toFixed(2)} degrees)`,
      );
      const smooth = await draw(kind, 'sphere', { variation: { value: 0.15 } }),
        clumped = await draw(kind, 'sphere', { variation: { value: 0.15 }, clusters: 0.3 }),
        step = [lumaStep(smooth.image), lumaStep(clumped.image)];
      assert.ok(
        step[1] > 1.5 * step[0],
        `${kind}: clusters break the smooth shading (luma step ${step[1].toFixed(2)} vs ${step[0].toFixed(2)})`,
      );
      results.push({
        kind,
        hue: [+before.degrees.toFixed(2), +after.degrees.toFixed(2)],
        step: step.map((v) => +v.toFixed(2)),
      });
    }
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter variation', JSON.stringify(results));
  },
  () => context.close(),
);
watchExit();
