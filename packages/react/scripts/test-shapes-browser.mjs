// <Svg>, <ScreenQuad> and <Text3D smooth> on a real GPU, checked by the colours of their screenshots, and <Svg> on the
// small WebGL2 preview.
// Run it natively and on the WebGL2 compatibility layer:
//   npm run test:browser:shapes --workspace @margoengine/react
//   MARGO_COMPAT=1 npm run test:browser:shapes --workspace @margoengine/react
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/packages/react/tests/shapes-browser.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.setDefaultTimeout(60000);
const pixel = (image, x, y) => {
  const at = (Math.round(y * (image.height - 1)) * image.width + Math.round(x * (image.width - 1))) * 4;
  return [image.data[at], image.data[at + 1], image.data[at + 2]];
};
// Pixels whose `channel` is strong and at least twice each other channel, with their mean x and y (0 to 1).
const count = (image, channel) => {
  let n = 0,
    x = 0,
    y = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    const rgb = [0, 1, 2].map((c) => image.data[i * 4 + c]);
    if (rgb[channel] > 150 && rgb.every((v, c) => c === channel || 2 * v < rgb[channel])) {
      n++;
      x += (i % image.width) / image.width;
      y += Math.floor(i / image.width) / image.height;
    }
  }
  return { n, x: n ? x / n : 0, y: n ? y / n : 0 };
};
const near = (actual, expected, label) =>
  assert.ok(actual.every((v, c) => Math.abs(v - expected[c]) <= 24), `${label}: ${actual} near ${expected}`);
try {
  await page.waitForFunction(() => window.shapes);
  // The small WebGL2 preview (backend 'webgl2') draws Svg's parts as lit, opaque core meshes.
  for (const backend of ['webgpu', 'webgl2'])
    for (const mode of backend === 'webgpu' ? ['svg', 'screenquad', 'text3d'] : ['svg']) {
      const label = `${mode} ${backend}`;
      await page.evaluate(([mode, backend]) => window.shapes.mount(mode, backend), [mode, backend]);
      await page.waitForFunction(
        () =>
          window.shapes.state.errors.length > 0 ||
          (window.shapes.state.ready.every(Boolean) && window.shapes.state.frames.every((n) => n > 30)),
      );
      assert.deepEqual(await page.evaluate(() => window.shapes.state.errors), [], label);
      const [left, right] = await Promise.all(
        [0, 1].map(async (side) => decodePNG(await page.locator(`[data-side="${side}"] canvas`).screenshot())),
      );
      if (mode === 'svg') {
        // Fill on the left half of both; the stroke only where strokes are drawn, right of the fill.
        const [fillA, fillB, strokeA, strokeB] = [count(left, 0), count(right, 0), count(left, 2), count(right, 2)];
        assert.ok(fillA.n > 2000 && fillA.x < 0.5, `${label}: red fill ${JSON.stringify(fillA)}`);
        assert.equal(fillB.n, fillA.n, `${label}: the stroke leaves the fill as it was`);
        assert.equal(strokeA.n, 0, `${label}: skipStrokes draws no stroke`);
        assert.ok(strokeB.n > 500 && strokeB.x > 0.5, `${label}: blue stroke ${JSON.stringify(strokeB)}`);
        // The stroke's centroid is the middle of its unfilled square.
        near(pixel(right, strokeB.x, strokeB.y), pixel(right, 0.02, 0.02), `${label}: an unfilled path shows the background`);
      } else if (mode === 'screenquad') {
        // vUv runs 0 to 1 across the screen with y up: red grows to the right, green to the top.
        near(pixel(right, 0.02, 0.98), [5, 5, 0], `${label}: bottom left`);
        near(pixel(right, 0.98, 0.98), [250, 5, 0], `${label}: bottom right`);
        near(pixel(right, 0.02, 0.02), [5, 250, 0], `${label}: top left`);
        near(pixel(right, 0.98, 0.02), [250, 250, 0], `${label}: top right`);
        assert.notDeepEqual(pixel(left, 0.5, 0.5), pixel(right, 0.5, 0.5), `${label}: the quad covers the screen`);
      } else {
        // Same silhouette, different shading: smoothing moves normals, never positions.
        const background = pixel(left, 0.02, 0.02),
          mask = (image) => {
            const out = new Uint8Array(image.width * image.height);
            for (let i = 0; i < out.length; i++)
              out[i] = [0, 1, 2].some((c) => Math.abs(image.data[i * 4 + c] - background[c]) > 24) ? 1 : 0;
            return out;
          };
        const [a, b] = [mask(left), mask(right)];
        let covered = 0,
          shaded = 0;
        for (let i = 0; i < a.length; i++)
          if (a[i] && b[i]) {
            covered++;
            if ([0, 1, 2].some((c) => Math.abs(left.data[i * 4 + c] - right.data[i * 4 + c]) > 8)) shaded++;
          }
        const total = a.reduce((s, v) => s + v, 0);
        assert.ok(total > 3000, `${label}: the text draws (${total} pixels)`);
        assert.ok(covered > 0.97 * total, `${label}: same silhouette (${covered} of ${total})`);
        assert.ok(shaded > 0.05 * total, `${label}: smooth shades differently (${shaded} of ${total})`);
      }
      console.log(label, 'ok');
    }
  await page.evaluate(() => window.shapes.unmount());
  await page.waitForFunction(() => window.shapes.state.engines.every((engine) => engine.disposed));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
