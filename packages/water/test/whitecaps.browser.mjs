// Whitecaps and chop: a steep wind sea drawn with `whitecaps` 0, 0.5 and 1 and with `chop` 0 and 1, the same camera and
// time. Whitecaps must turn a share of the sea white that grows with the amount (none at 0), and chop must add fine
// surface detail (luma texture at a few pixels' scale). Without the feature the frames are identical and this fails.
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
const shoot = async (name, extra) => {
  await page.evaluate(async (extra) => {
    const { engine } = window.capsTest;
    window.capsTest.water?.dispose();
    const { Water } = await import('/packages/water/dist/index.js');
    window.capsTest.water = Water.attach(engine, {
      size: [200, 200],
      segments: 256,
      color: [0.004, 0.012, 0.016],
      lights: [{ direction: [0.1, 0.3, -1, 1], radiance: [0.6, 0.7, 0.9] }],
      waves: [
        { direction: [-0.8, -0.6], amplitude: 1, wavelength: 60, steepness: 0.5, phase: 0.4 },
        { direction: [-0.95, -0.2], amplitude: 0.85, wavelength: 12, steepness: 0.3, phase: 4.3 },
      ],
      ...extra,
    });
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    await waitForPipelines(async () => {
      engine.render({ delta: 0 });
      await engine.gpu.queue.onSubmittedWorkDone();
    });
  }, extra);
  const png = await decodePNG(
    await page
      .locator('canvas')
      .screenshot({ path: `test-results/water-whitecaps-${hardware.webgpu.vendor}-${name}.png` }),
  );
  const luma = new Float64Array(WIDTH * HEIGHT);
  for (let i = 0; i < luma.length; i++)
    luma[i] = 0.2126 * png.data[i * 4] + 0.7152 * png.data[i * 4 + 1] + 0.0722 * png.data[i * 4 + 2];
  return luma;
};
// The sea: the lower two thirds of the frame (the camera looks down onto it, the horizon near the top).
const SEA = Math.round(HEIGHT / 3);
const whiter = (a, b) => {
  let n = 0,
    total = 0;
  for (let y = SEA; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++, total++) if (b[y * WIDTH + x] - a[y * WIDTH + x] > 25) n++;
  return n / total;
};
// How crisp the foam is: of the sea pixels the whitecaps whiten, the share lifted to at least three quarters of the
// brightest foam (the 95th percentile of the lift). Soft, half-covered patches read as grey blotches and score low.
const crispness = (a, b) => {
  const lifts = [];
  for (let y = SEA; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const lift = b[y * WIDTH + x] - a[y * WIDTH + x];
      if (lift > 25) lifts.push(lift);
    }
  lifts.sort((p, q) => p - q);
  const top = lifts[Math.floor(lifts.length * 0.95)];
  return lifts.filter((lift) => lift >= top * 0.75).length / lifts.length;
};
// Fine detail: RMS of luma minus its 3x3 mean over the sea.
const texture = (l) => {
  let sum = 0,
    count = 0;
  for (let y = SEA + 1; y < HEIGHT - 1; y++)
    for (let x = 1; x < WIDTH - 1; x++) {
      let mean = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) mean += l[(y + j) * WIDTH + x + i];
      const v = l[y * WIDTH + x] - mean / 9;
      sum += v * v;
      count++;
    }
  return Math.sqrt(sum / count);
};
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
        camera: { position: [0, 9, 40], target: [0, 0, -10], near: 0.3, far: 2000 },
      });
      engine.gpu.pushErrorScope('validation');
      window.capsTest = { engine };
    },
    { WIDTH, HEIGHT },
  );
  const calm = await shoot('none', {}),
    zero = await shoot('zero', { whitecaps: 0 }),
    half = await shoot('half', { whitecaps: 0.5 }),
    full = await shoot('full', { whitecaps: 1 }),
    choppy = await shoot('chop', { chop: 1 });
  // 0 is the default: the same pixels.
  assert.equal(whiter(calm, zero), 0, 'whitecaps 0 changed the sea');
  const h = whiter(calm, half),
    f = whiter(calm, full);
  console.log(`whitecaps: ${(h * 100).toFixed(1)}% of the sea whiter at 0.5, ${(f * 100).toFixed(1)}% at 1`);
  assert.ok(f > 0.06, `whitecaps 1 whitens only ${(f * 100).toFixed(2)}% of the sea`);
  assert.ok(h > 0.005 && h < f * 0.8, `whitecaps do not grow with the amount: ${h} at 0.5, ${f} at 1`);
  const crisp = crispness(calm, full);
  console.log(`whitecaps: ${(crisp * 100).toFixed(1)}% of the foam within a quarter of its brightest`);
  // Crisp white caps (2026-11-13; Radeon 680M: 38.1%); the former soft, partly covered patches scored 16.1%.
  assert.ok(
    crisp > 0.3,
    `whitecaps read as grey blotches: only ${(crisp * 100).toFixed(1)}% of the foam is near its brightest`,
  );
  const t0 = texture(calm),
    t1 = texture(choppy);
  console.log(`chop: fine texture ${t0.toFixed(2)} -> ${t1.toFixed(2)}`);
  assert.ok(t1 > t0 * 1.3, `chop 1 adds too little surface detail: ${t0.toFixed(2)} -> ${t1.toFixed(2)}`);
  // The setters take effect on the next frame and reject values outside 0-1.
  const live = await page.evaluate(async () => {
    const { engine, water } = window.capsTest;
    water.setChop(0).setWhitecaps(1);
    let rejected = 0;
    for (const bad of [-0.1, 1.1, Number.NaN])
      try {
        water.setWhitecaps(bad);
      } catch (error) {
        rejected += +(error instanceof RangeError);
      }
    engine.render({ delta: 0 });
    await engine.gpu.queue.onSubmittedWorkDone();
    const error = await engine.gpu.popErrorScope();
    return { rejected, error: error?.message ?? null };
  });
  assert.deepEqual(live, { rejected: 3, error: null });
  const set = await (async () => {
    const png = await decodePNG(await page.locator('canvas').screenshot());
    const l = new Float64Array(WIDTH * HEIGHT);
    for (let i = 0; i < l.length; i++)
      l[i] = 0.2126 * png.data[i * 4] + 0.7152 * png.data[i * 4 + 1] + 0.0722 * png.data[i * 4 + 2];
    return l;
  })();
  assert.ok(whiter(calm, set) > f * 0.8, 'setWhitecaps(1) did not reach the next frame');
  assert.deepEqual(errors, []);
  console.log(`water whitecaps browser check passed (${hardware.webgpu.vendor})`);
} finally {
  await page.evaluate(() => window.capsTest?.engine.dispose());
  await closeAll({ browser });
}
