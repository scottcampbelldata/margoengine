// Sun glitter follows the wind: looking toward a sun 25 degrees up from a camera pitched 25 degrees down (the sun's flat
// mirror point at the centre of the frame), the glint's half width across the path, in degrees of azimuth, matches the
// slope spread of Cox and Munk (1954), crosswind mean square slope 0.003 + 0.00192 U, within a factor 1.5 at U 2 and 12.
// For a Gaussian slope density the glint falls to half where the crosswind slope is z = sigma sqrt(2 ln 2); the slope that
// turns the sun into a view azimuth phi at view elevation e is z = sin(phi) cos(e) / (sin(sun) + sin(e)).
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const WIDTH = 960,
  HEIGHT = 540,
  FOV = 60,
  ELEVATION = (25 * Math.PI) / 180,
  FRAMES = Number(process.env.MARGO_GLITTER_FRAMES ?? 24),
  // Rows within this many degrees of the mirror point.
  BAND = 1.2;
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
const tanHalf = Math.tan((FOV * Math.PI) / 360),
  // The azimuth of a pixel column on the centre row, and the elevation of a pixel row on the centre column, in degrees.
  azimuth = (x) => {
    const sx = ((2 * (x + 0.5)) / WIDTH - 1) * tanHalf * (WIDTH / HEIGHT);
    // forward = (0, -sin e, -cos e), right = (1, 0, 0): the ray (sx, -sin e, -cos e) turned from the plane of the sun.
    return (Math.atan2(sx, Math.cos(ELEVATION) - 0 * Math.sin(ELEVATION)) * 180) / Math.PI;
  },
  rowElevation = (y) => {
    const sy = (1 - (2 * (y + 0.5)) / HEIGHT) * tanHalf;
    return (
      (Math.atan2(Math.sin(ELEVATION) - sy * Math.cos(ELEVATION), Math.cos(ELEVATION) + sy * Math.sin(ELEVATION)) *
        180) /
      Math.PI
    );
  };
// sRGB code (0-255) to linear light: the half of a glint is half its light, not half its code.
const linear = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
async function profile(speed, radiance) {
  await page.evaluate(
    async ({ speed, radiance }) => {
      const { engine } = window.glitterTest;
      window.glitterTest.water?.dispose();
      const { Water } = await import('/packages/water/dist/index.js');
      window.glitterTest.water = Water.attach(engine, {
        size: [600, 600],
        segments: 512,
        horizon: true,
        color: [0, 0, 0],
        wind: { speed, direction: [0, -1] },
        lights: [
          {
            direction: [0, Math.sin((25 * Math.PI) / 180), -Math.cos((25 * Math.PI) / 180), 1],
            radiance: [radiance, radiance, radiance],
          },
        ],
      });
    },
    { speed, radiance },
  );
  const sum = new Float64Array(WIDTH);
  let rows = 0;
  for (let f = 0; f < FRAMES; f++) {
    await page.evaluate(
      async ({ f }) => {
        const { engine, water } = window.glitterTest;
        water.setTime(11.3 * f + 4);
        engine.render({ delta: 0 });
        await engine.gpu.queue.onSubmittedWorkDone();
      },
      { f },
    );
    const png = await decodePNG(await page.locator('canvas').screenshot());
    for (let y = 0; y < HEIGHT; y++) {
      if (Math.abs(rowElevation(y) - 25) > BAND) continue;
      rows++;
      for (let x = 0; x < WIDTH; x++)
        sum[x] += linear(
          0.2126 * png.data[(y * WIDTH + x) * 4] +
            0.7152 * png.data[(y * WIDTH + x) * 4 + 1] +
            0.0722 * png.data[(y * WIDTH + x) * 4 + 2],
        );
    }
  }
  const mean = sum.map((v) => v / rows),
    // Smooth over 9 columns, then the half-max width around the brightest column (the profile is symmetric).
    smooth = mean.map((_, x) => {
      let t = 0,
        n = 0;
      for (let i = -4; i <= 4; i++) if (x + i >= 0 && x + i < WIDTH) (t += mean[x + i]), n++;
      return t / n;
    });
  // What is left of the glint at the frame's sides (sky reflected off the black sea) is the floor.
  const floor = Math.min(...smooth),
    top = Math.max(...smooth),
    centre = smooth.indexOf(top),
    peak = top - floor,
    level = floor + peak / 2;
  let low = centre,
    high = centre;
  while (low > 0 && smooth[low] > level) low--;
  while (high < WIDTH - 1 && smooth[high] > level) high++;
  if (process.env.MARGO_GLITTER_DEBUG)
    console.log(`U ${speed}: floor ${floor.toFixed(1)} top ${top.toFixed(1)} centre ${centre} low ${low} high ${high}`);
  return { half: (azimuth(high) - azimuth(low)) / 2, peak, centre };
}
// Half width in degrees of azimuth that Cox and Munk's crosswind slope gives at wind speed `speed`.
const predicted = (speed) => {
  const sigma = Math.sqrt(0.003 + 0.00192 * speed),
    z = sigma * Math.sqrt(2 * Math.log(2));
  return (Math.asin((z * 2 * Math.sin(ELEVATION)) / Math.cos(ELEVATION)) * 180) / Math.PI;
};
try {
  await page.evaluate(
    async ({ WIDTH, HEIGHT }) => {
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.append(canvas);
      const pitch = (25 * Math.PI) / 180;
      const engine = await EngineKernel.create(canvas, {
        backend: 'webgpu',
        capacity: 16,
        camera: {
          position: [0, 10, 0],
          target: [0, 10 - Math.sin(pitch) * 100, -Math.cos(pitch) * 100],
          near: 0.3,
          far: 5000,
        },
      });
      engine.lighting.radiance.set([0, 0, 0, 0]);
      engine.gpu.pushErrorScope('validation');
      window.glitterTest = { engine };
    },
    { WIDTH, HEIGHT },
  );
  const slow = await profile(2, Number(process.env.MARGO_GLITTER_SLOW ?? 0.15)),
    fast = await profile(12, Number(process.env.MARGO_GLITTER_FAST ?? 0.6));
  for (const [speed, p] of [
    [2, slow],
    [12, fast],
  ])
    console.log(
      `U ${speed}: glitter half width ${p.half.toFixed(2)} degrees, Cox and Munk ${predicted(speed).toFixed(2)}, peak ${p.peak.toFixed(3)}`,
    );
  for (const [speed, p] of [
    [2, slow],
    [12, fast],
  ]) {
    const ratio = p.half / predicted(speed);
    assert.ok(ratio > 1 / 1.5 && ratio < 1.5, `U ${speed}: glitter half width ${p.half} against ${predicted(speed)}`);
  }
  assert.ok(fast.half > slow.half * 1.4, 'the glitter does not widen with the wind');
  const error = await page.evaluate(() =>
    window.glitterTest.engine.gpu.popErrorScope().then((e) => e?.message ?? null),
  );
  assert.equal(error, null);
  assert.deepEqual(errors, []);
  console.log(`water glitter browser check passed (${hardware.webgpu.vendor})`);
} finally {
  await page.evaluate(() => window.glitterTest?.engine.dispose());
  await closeAll({ browser });
}
