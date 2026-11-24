// Horizon water follows the camera: a 4 km horizon sea seen from a camera far from the origin keeps its swell near the
// camera (it used to keep regular cells only within 0.375 of `size` of the origin, so the swell stopped in a square
// and the sea past it was flat), the near field draws the same pixels as a bounded grid over the same world cells, and
// the sea reaches the true horizon from high cameras.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
await mkdir('test-results', { recursive: true });
const WIDTH = 640,
  HEIGHT = 360,
  FOV = 60;
const browser = await openBrowser({ startPath: '/tests/modern-game.html' }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
// Horizontal distance from the camera to where each pixel's ray meets the sea plane y = 0 (Infinity above the horizon).
function seaDistances(position, target) {
  const sub = (a, b) => a.map((v, i) => v - b[i]),
    norm = (a) => a.map((v) => v / Math.hypot(...a)),
    cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const forward = norm(sub(target, position)),
    right = norm(cross(forward, [0, 1, 0])),
    up = cross(right, forward),
    t = Math.tan((FOV * Math.PI) / 360),
    out = new Float64Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const sx = ((2 * (x + 0.5)) / WIDTH - 1) * t * (WIDTH / HEIGHT),
        sy = (1 - (2 * (y + 0.5)) / HEIGHT) * t,
        d = forward.map((f, i) => f + sx * right[i] + sy * up[i]);
      out[y * WIDTH + x] = d[1] < 0 ? (Math.hypot(d[0], d[2]) * position[1]) / -d[1] : Infinity;
    }
  return out;
}
// Wave texture: RMS of luma minus its 5x5 mean over the pixels whose sea point lies `from` to `to` metres away.
function texture(png, distances, from, to) {
  const luma = new Float64Array(WIDTH * HEIGHT);
  for (let i = 0; i < luma.length; i++)
    luma[i] = 0.2126 * png.data[i * 4] + 0.7152 * png.data[i * 4 + 1] + 0.0722 * png.data[i * 4 + 2];
  let sum = 0,
    count = 0;
  for (let y = 2; y < HEIGHT - 2; y++)
    for (let x = 2; x < WIDTH - 2; x++) {
      const d = distances[y * WIDTH + x];
      if (!(d >= from && d <= to)) continue;
      let mean = 0;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) mean += luma[(y + j) * WIDTH + x + i];
      const v = luma[y * WIDTH + x] - mean / 25;
      sum += v * v;
      count++;
    }
  return { rms: Math.sqrt(sum / count), count };
}
const shoot = async (name, options, position, target) => {
  await page.evaluate(
    async ({ options, position, target }) => {
      const { engine } = window.horizonTest;
      window.horizonTest.water?.dispose();
      const { Water } = await import('/packages/water/dist/index.js');
      window.horizonTest.water = Water.attach(engine, options);
      engine.camera.position = [...position];
      engine.camera.target = [...target];
      const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
      await waitForPipelines(async () => {
        engine.render({ delta: 0 });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
    },
    { options, position, target },
  );
  return decodePNG(
    await page
      .locator('canvas')
      .screenshot({ path: `test-results/water-horizon-${hardware.webgpu.vendor}-${name}.png` }),
  );
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
        camera: { position: [0, 520, 0], target: [-600, 0, -600], near: 1, far: 30000 },
      });
      engine.gpu.pushErrorScope('validation');
      window.horizonTest = { engine };
    },
    { WIDTH, HEIGHT },
  );
  // A 4 km sea with a 48 m and a 27 m swell on 8 m cells, seen from 520 m up looking 1 km out and down.
  const sea = {
      size: [4096, 4096],
      segments: 512,
      horizon: true,
      // A low sun ahead of the camera: its glints follow the swell's slopes.
      lights: [{ direction: [-0.6, 0.3, -0.7, 2], radiance: [1, 0.92, 0.8] }],
      waves: [
        { direction: [1, 0.3], amplitude: 0.9, wavelength: 48, phase: 0.43 },
        { direction: [1, 0.6], amplitude: 0.44, wavelength: 27, phase: 2.17 },
      ],
    },
    look = [-660, -520, -760],
    at = (p) => p.map((v, i) => v + look[i]);
  const home = [0, 520, 0],
    far = [2100, 520, 2400],
    distances = seaDistances(home, at(home));
  const centre = texture(await shoot('origin', sea, home, at(home)), distances, 300, 900),
    away = texture(await shoot('far', sea, far, at(far)), distances, 300, 900);
  // The far camera's band lies more than 0.4 of `size` from the origin along an axis: past main's regular rows.
  const band = [300, 900].map((s) => far.map((v, i) => v + (look[i] * s) / Math.hypot(look[0], look[2])));
  assert.ok(
    band.every((p) => Math.max(Math.abs(p[0]), Math.abs(p[2])) > 0.4 * 4096),
    'the measured band left the outer rows',
  );
  assert.ok(centre.count > 20000 && centre.rms > 1, `no swell texture to compare at the origin: ${centre.rms}`);
  // Near field: a camera about 50 cells from the origin, between cells; the horizon grid (centred on the camera) and a bounded grid
  // (centred on the origin) cover the near sea with the same world cells, so they draw the same pixels there.
  const near = { ...sea, size: [1024, 1024], segments: 256 },
    eye = [201.3, 6, 298.7],
    ahead = [141.3, 0, 238.7],
    followed = await shoot('near-horizon', near, eye, ahead),
    bounded = await shoot('near-bounded', { ...near, horizon: false }, eye, ahead),
    nearDistances = seaDistances(eye, ahead);
  let compared = 0,
    differ = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    // Sea within 150 m of the camera, inside both grids' regular rows (384 m from each centre).
    if (!(nearDistances[i] <= 150)) continue;
    compared++;
    const o = i * 4;
    if (
      Math.abs(followed.data[o] - bounded.data[o]) +
        Math.abs(followed.data[o + 1] - bounded.data[o + 1]) +
        Math.abs(followed.data[o + 2] - bounded.data[o + 2]) >
      3
    )
      differ++;
  }
  // The sea meets the true horizon: from 520 m (horizon in frame) and from 3,000 m (biome scene 03's view, horizon just
  // above the frame), every column's first water pixel is at most 2 rows below the first pixel looking down. The grid
  // used to end in a square 10 km past its edge: 2.5 degrees below the horizon from 520 m, 14 from 3,000 m.
  await page.evaluate(async () => {
    const { engine } = window.horizonTest;
    window.horizonTest.water?.dispose();
    window.horizonTest.water = undefined;
    engine.render({ delta: 0 });
    await engine.gpu.queue.onSubmittedWorkDone();
  });
  const clear = await decodePNG(
      await page
        .locator('canvas')
        .screenshot({ path: `test-results/water-horizon-${hardware.webgpu.vendor}-clear.png` }),
    ),
    gaps = {};
  for (const [name, position, target] of [
    ['edge-520', [2100, 520, 2400], [1440, 370, 1640]],
    ['edge-3000', [0, 3000, 5200], [0, 200, 1200]],
  ]) {
    const image = await shoot(name, sea, position, target),
      looking = seaDistances(position, target);
    let worst = 0;
    for (let x = 0; x < WIDTH; x++) {
      let down = HEIGHT,
        water = HEIGHT;
      for (let y = HEIGHT - 1; y >= 0; y--) {
        const i = y * WIDTH + x,
          o = i * 4;
        if (looking[i] < Infinity) down = y;
        if (
          Math.abs(image.data[o] - clear.data[o]) +
            Math.abs(image.data[o + 1] - clear.data[o + 1]) +
            Math.abs(image.data[o + 2] - clear.data[o + 2]) >
          6
        )
          water = y;
      }
      worst = Math.max(worst, water - down);
    }
    gaps[name] = worst;
  }
  const validation = await page.evaluate(async () => {
    const { engine } = window.horizonTest,
      error = await engine.gpu.popErrorScope();
    return error?.message;
  });
  const result = { centre, away, ratio: away.rms / centre.rms, compared, differ, gaps };
  await writeFile(
    `test-results/water-horizon-${hardware.webgpu.vendor}.json`,
    JSON.stringify({ hardware, ...result, errors }, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.equal(validation, undefined);
  assert.deepEqual(errors, []);
  assert.ok(result.ratio >= 0.5, `the swell stops short of a camera far from the origin: ${result.ratio.toFixed(3)}`);
  assert.ok(compared > 20000, `too few near-field sea pixels: ${compared}`);
  assert.ok(differ <= 10, `the camera-following grid moved the near-field waves: ${differ} pixels`);
  for (const [name, gap] of Object.entries(gaps))
    assert.ok(gap <= 2, `${name}: the sea ends ${gap} rows below the horizon`);
} finally {
  await page.evaluate(() => window.horizonTest?.engine.dispose());
  await closeAll({ browser });
}
