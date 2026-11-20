// Whitecap coverage follows the wind: a top-down 200 m view of a sea from a wind of U m/s, no `whitecaps` option, shows
// foam over W = 3.84e-6 U^3.41 of the sea (Monahan and O'Muircheartaigh 1980) within a factor 1.5 at U 3, 8, 15 and 25,
// none below 3 m/s, and the same at any chop. Foam is counted where a pixel is at least half foam: the sea is black, the
// glints are off and the foam is lit white, so foam is the only bright thing. Each speed is measured over many wave
// clocks, because a patch of foam is a few square metres.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const SIZE = 640,
  FOV = 60,
  VIEW = 200,
  HEIGHT = VIEW / (2 * Math.tan((FOV * Math.PI) / 360)),
  FRAMES = Number(process.env.MARGO_WHITECAP_FRAMES ?? 40);
const W = (u) => 3.84e-6 * u ** 3.41;
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const luma = (png) => {
  const l = new Float64Array(SIZE * SIZE);
  for (let i = 0; i < l.length; i++)
    l[i] = 0.2126 * png.data[i * 4] + 0.7152 * png.data[i * 4 + 1] + 0.0722 * png.data[i * 4 + 2];
  return l;
};
// The share of sea pixels at least half foam, over `FRAMES` wave clocks; `white` is the luma of full foam (about 240 here).
async function coverage(extra, white) {
  await page.evaluate(
    async ({ extra }) => {
      const { engine } = window.capsTest;
      window.capsTest.water?.dispose();
      const { Water } = await import('/packages/water/dist/index.js');
      window.capsTest.water = Water.attach(engine, {
        size: [420, 420],
        segments: 512,
        color: [0, 0, 0],
        lights: [{ direction: [0, 1, 0, 0], radiance: [0, 0, 0] }],
        ...extra,
      });
    },
    { extra },
  );
  let foam = 0,
    total = 0,
    brightest = 0;
  for (let f = 0; f < FRAMES; f++) {
    await page.evaluate(
      async ({ f }) => {
        const { engine, water } = window.capsTest;
        water.setTime(13.7 * f + 5);

        engine.render({ delta: 0 });
        await engine.gpu.queue.onSubmittedWorkDone();
      },
      { f },
    );
    const l = luma(await decodePNG(await page.locator('canvas').screenshot()));
    for (const v of l) {
      total++;
      if (v >= white * 0.5) foam++;
      if (v > brightest) brightest = v;
    }
  }
  return { share: foam / total, brightest };
}
try {
  await page.evaluate(
    async ({ SIZE, HEIGHT }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${SIZE}px;height:${SIZE}px`;
      document.body.append(canvas);
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: { position: [0, HEIGHT, 0.5], target: [0, 0, 0], near: 1, far: 1000 },
      });
      // Foam is lit white by the ambient and the sun; nothing else in the frame is bright.
      engine.lighting.direction.set([0.3, 0.9, 0.2, 1]);
      engine.lighting.radiance.set([2, 2, 2, 1]);
      engine.gpu.pushErrorScope('validation');
      window.capsTest = { engine };
    },
    { SIZE, HEIGHT },
  );
  // Foam covers W of the sea within a factor 1.5 at U 3, 8, 15, 25 and at any chop, and none of it below 3 m/s.
  for (const [speed, chop] of [
    [0, 0],
    [2.9, 1],
    [3, 0],
    [3, 1],
    [8, 0],
    [8, 1],
    [15, 0],
    [15, 1],
    [25, 0],
    [25, 1],
  ]) {
    const { share, brightest } = await coverage({ wind: speed, chop }, 200);
    console.log(
      `U ${speed} chop ${chop}: foam ${(share * 100).toFixed(4)}% of the sea, W ${(W(speed) * 100).toFixed(4)}%, brightest ${brightest.toFixed(0)}`,
    );
    if (speed < 3) assert.equal(share, 0, `foam at ${speed} m/s`);
    else
      assert.ok(
        share > W(speed) / 1.5 && share < W(speed) * 1.5,
        `U ${speed} chop ${chop}: foam covers ${share}, whitecap coverage is ${W(speed)}`,
      );
  }
  // A `whitecaps` of 0 set by hand keeps the sea free of foam at any wind: the wind only sets the default.
  assert.equal(
    (await coverage({ wind: 15, whitecaps: 0 }, 200)).share,
    0,
    'whitecaps 0 did not turn the wind foam off',
  );
  const error = await page.evaluate(() => window.capsTest.engine.gpu.popErrorScope().then((e) => e?.message ?? null));
  assert.equal(error, null);
  assert.deepEqual(errors, []);
  console.log(`water whitecap coverage check passed (${hardware.webgpu.vendor})`);
} finally {
  await page.evaluate(() => window.capsTest?.engine.dispose());
  await closeAll({ browser });
}
