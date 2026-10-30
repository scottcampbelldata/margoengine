// Real-GPU proof (run from the repository root after building packages, in a shared GPU slot):
//   node packages/scatter/test/shadow.browser.mjs
// GPU scatter casts into Shadows: a box drawn as a `Scatter`, and as a `ScatterTiles` record, darkens the floor where
// its shadow falls by at least 25 percent once `shadows.add(scatter)` adds it, and not without it. Before scatter had
// `drawShadow`, Shadows rejected the scatter (TypeError) and its trees cast nothing.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/shadow.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
// Floor points in open sun, and within 1 m of the middle of the box top's shadow (-2, 0, 0): shaded at every yaw (a
// Scatter turns each instance by a random yaw) and never hidden by the box from the camera.
const shaded = [
    [-2, 0, 0],
    [-2, 0, 0.6],
    [-2, 0, -0.6],
    [-2.5, 0, 0.3],
    [-2.4, 0, -0.5],
  ],
  open = [
    [3, 0, 0],
    [3, 0, 2],
    [0, 0, 4],
    [-2, 0, 4],
    [-2, 0, -4],
  ];
await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    // Mean sRGB luma of the 3 x 3 pixels around each point.
    const luma = (image, [u, v]) => {
      const x = Math.round(u * image.width),
        y = Math.round(v * image.height);
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = ((y + dy) * image.width + x + dx) * 4;
          sum += 0.2126 * image.data[k] + 0.7152 * image.data[k + 1] + 0.0722 * image.data[k + 2];
        }
      return sum / 9;
    };
    const results = [];
    for (const kind of ['scatter', 'tiles'])
      for (const cast of [false, true]) {
        const errors = await page.evaluate(([kind, cast]) => window.check.show(kind, cast), [kind, cast]);
        assert.deepEqual(errors, [], `${kind} ${cast ? 'casting' : 'not added'}`);
        // After a frame: the camera's matrix is made by the first render.
        const pixels = await page.evaluate((points) => points.map((p) => window.check.pixel(p)), [...shaded, ...open]);
        const image = await decodePNG(await page.locator('canvas').screenshot()),
          values = pixels.map((p) => luma(image, p)),
          sun = values.slice(shaded.length).reduce((a, b) => a + b) / open.length,
          shade = values.slice(0, shaded.length);
        assert.ok(sun > 40, `${kind}: open floor is lit (${sun})`);
        if (cast)
          for (const [i, v] of shade.entries())
            assert.ok(v <= 0.75 * sun, `${kind}: floor at ${shaded[i]} is in the box's shadow (${v} vs open ${sun})`);
        else
          for (const [i, v] of shade.entries())
            assert.ok(v > 0.9 * sun, `${kind} not added: floor at ${shaded[i]} stays lit (${v} vs open ${sun})`);
        results.push({ kind, cast, sun: +sun.toFixed(1), shade: shade.map((v) => +v.toFixed(1)) });
      }
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter shadows', JSON.stringify(results));
  },
  () => context.close(),
);
watchExit();
