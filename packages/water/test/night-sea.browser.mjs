// The sea at night: a Water with no options under a moonlit night's lighting (ambient and sun both low) is lit by the sky
// it mirrors, so the sea near the camera is not brighter than the sky above the horizon (the engine's dark background
// here). A sea lit by a fixed ambient glowed above the sky it reflected. Under a clear day's lighting the same sea is far
// brighter than at night, lit by the full sky.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const WIDTH = 640,
  HEIGHT = 360;
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const linear = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
async function bands(light) {
  await page.evaluate(
    async ({ light }) => {
      const { engine } = window.nightTest;
      window.nightTest.water?.dispose();
      engine.lighting.direction.set(light.direction);
      engine.lighting.radiance.set(light.radiance);
      const { Water } = await import('/packages/water/dist/index.js');
      window.nightTest.water = Water.attach(engine);
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
    },
    { light },
  );
  const png = await decodePNG(await page.locator('canvas').screenshot());
  const mean = (from, to) => {
    let sum = 0,
      n = 0;
    for (let y = Math.round(from * HEIGHT); y < Math.round(to * HEIGHT); y++)
      for (let x = 0; x < WIDTH; x++, n++)
        sum += linear(
          0.2126 * png.data[(y * WIDTH + x) * 4] +
            0.7152 * png.data[(y * WIDTH + x) * 4 + 1] +
            0.0722 * png.data[(y * WIDTH + x) * 4 + 2],
        );
    return sum / n;
  };
  // The 100 m sea ends below the horizon, which sits at about 44% of the way down: the bottom rows look down onto the
  // sea, the rows above the horizon show the sky.
  return { near: mean(0.88, 1), sky: mean(0.1, 0.4) };
}
try {
  await page.evaluate(
    async ({ WIDTH, HEIGHT }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, 4, 0], target: [0, 1.5, -40], near: 0.3, far: 20000 },
      });
      engine.gpu.pushErrorScope('validation');
      window.nightTest = { engine };
    },
    { WIDTH, HEIGHT },
  );
  const night = await bands({ direction: [0.3, 0.5, 0.2, 0.3], radiance: [0.2, 0.25, 0.4, 0.03] }),
    day = await bands({ direction: [1, 3, 1, 1], radiance: [1, 0.96, 0.86, 0.3] });
  console.log(`night: near ${night.near.toExponential(2)}, sky ${night.sky.toExponential(2)}`);
  console.log(`day: near ${day.near.toExponential(2)}, sky ${day.sky.toExponential(2)}`);
  assert.ok(night.sky > 1e-4, 'there is no sky in the frame to compare with');
  assert.ok(
    night.near <= night.sky,
    `the night sea (${night.near}) is brighter than the sky above the horizon (${night.sky})`,
  );
  assert.ok(night.near < day.near * 0.2, 'the night sea is not far darker than the day sea');
  const error = await page.evaluate(() => window.nightTest.engine.gpu.popErrorScope().then((e) => e?.message ?? null));
  assert.equal(error, null);
  assert.deepEqual(errors, []);
  console.log(`water night sea browser check passed (${hardware.webgpu.vendor})`);
} finally {
  await page.evaluate(() => window.nightTest?.engine.dispose());
  await closeAll({ browser });
}
