// Real-GPU check of TAA's history rejection options, built packages, on the test/stripes-fixture.js scenes. Takes the GPU
// lock itself around the browser.
//   rejection 'variance': a white square that writes no velocity crosses bright 1 px dots 4 px apart on a dark plane;
//   next to a dot the min/max box spans dark to bright and keeps the white trail, while clipping toward the
//   neighbourhood mean +- 1.25 sigma, which one bright pixel in nine moves little, keeps less of it; away from the
//   square nothing moves.
//   locks: a still bright line 0.4 px wide on a dark plane is hit by the jitter on some frames only; the min/max clamp
//   throws its history away on the frames that miss it and the line vanishes, while a locked line keeps its history.
// The line and stripe rigs that prove a rejection mode run with settle false, so they measure pixels that are not settled
// (Scott, 2026-11-16, "Revise asserts"); with settle on, the default, the still line holds its mean and still stripes
// do not move at all, checked by the settled rigs.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

const timer = setTimeout(() => {
  console.error('rejection-browser: timed out after 150 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 150_000);
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  cacheDir: 'test-results/taa-rejection/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5374, strictPort: true, watch: null, hmr: false },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5374 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 }),
    errors = [];
  // MARGO_COMPAT=1: the page runs on the WebGL2 compatibility layer (scripts/support/compat-shim.js).
  if (compatRun()) await page.addInitScript(compatShim);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5374/packages/taa/test/upscale-browser.html');
  await page.evaluate(async () => {
    const { rig } = await import('/packages/taa/test/stripes-fixture.js');
    document.querySelector('canvas').remove();
    const rigs = {
      clamp: await rig('clamp', { pattern: 'dots', alpha: 1 }),
      variance: await rig('variance', { pattern: 'dots', alpha: 1, taa: { rejection: 'variance' } }),
      lineClamp: await rig('lineClamp', { pattern: 'line', taa: { settle: false } }),
      lineLocks: await rig('lineLocks', { pattern: 'line', taa: { locks: true, settle: false } }),
      surface: await rig('surface', { pattern: 'sine', alpha: 0, taa: { settle: false } }),
      sky: await rig('sky', { pattern: 'sine', alpha: 0, sky: true, taa: { settle: false } }),
      lineSettled: await rig('lineSettled', { pattern: 'line' }),
      surfaceSettled: await rig('surfaceSettled', { pattern: 'sine', alpha: 0 }),
      skySettled: await rig('skySettled', { pattern: 'sine', alpha: 0, sky: true }),
    };
    window.t = {
      gpuErrors: () => Object.values(rigs).flatMap((r) => r.gpuErrors),
      frames: (names, n, step, show) => Promise.all(names.map((name) => rigs[name].frames(n, step, show))),
    };
  });
  const shot = async (id) => decodePNG(await page.locator('#' + id).screenshot());
  // Mean of red over rows 96 to 144, in sRGB levels, for columns [from, to).
  const band = (image, from, to) => {
    let sum = 0,
      n = 0;
    for (let y = 96; y < 144; y++)
      for (let x = from; x < to; x++) {
        sum += image.data[(y * image.width + x) * 4];
        n++;
      }
    return sum / n;
  };

  // Variance clipping against the square's trail (as reactive-browser.mjs, without a mask, over sparse dots).
  const stripes = ['clamp', 'variance'];
  await page.evaluate((names) => window.t.frames(names, 30, 0, false), stripes);
  const before = { clamp: await shot('clamp'), variance: await shot('variance') };
  await page.evaluate((names) => window.t.frames(names, 20, 6, true), stripes);
  const trail = {};
  for (const mode of stripes) {
    const after = await shot(mode);
    trail[mode] = {
      trail: band(after, 92, 140) - band(before[mode], 92, 140),
      far: band(after, 240, 300) - band(before[mode], 240, 300),
    };
  }
  console.log('trail brightening in sRGB levels', trail);
  // Apple silicon Mac, Metal: 53.0 levels clamped, 35.1 clipped. Near a dot the box keeps white history up to the dot's 0.9;
  // the variance box of one bright pixel in nine reaches about half that, and pixels far from dots clear in both.
  assert.ok(trail.clamp.trail > 30, `the min/max clamp keeps a trail (${trail.clamp.trail.toFixed(1)})`);
  assert.ok(
    trail.variance.trail < trail.clamp.trail * 0.8,
    `variance clipping keeps less of it (${trail.variance.trail.toFixed(1)})`,
  );
  for (const mode of stripes) assert.ok(Math.abs(trail[mode].far) < 2, `away from the square nothing moves (${mode})`);

  // Thin-feature locks against a line the jitter misses on some frames: 16 frames, after 24 to settle.
  const lines = ['lineClamp', 'lineLocks', 'lineSettled'];
  await page.evaluate((names) => window.t.frames(names, 24), lines);
  const frames = { lineClamp: [], lineLocks: [], lineSettled: [] };
  // fixed-wait: the measurement itself: 16 consecutive frames, two jitter cycles, each one captured and compared.
  for (let f = 0; f < 16; f++) {
    await page.evaluate((names) => window.t.frames(names, 1), lines);
    for (const mode of lines) frames[mode].push(await shot(mode));
  }
  // The line is at the view's centre, between columns 159 and 160. Its brightness in a frame: the brightest of columns
  // 157 to 162, averaged over rows 60 to 180. The clamped line vanishes on the frames the jitter misses it (5 of 8 on
  // Apple silicon Mac, Metal: dimmest frame 5 levels, the background); the locked one stays (dimmest frame 54).
  const flicker = {};
  for (const mode of lines) {
    const levels = frames[mode].map((image) => {
      let sum = 0;
      for (let y = 60; y < 180; y++) {
        let peak = 0;
        for (let x = 157; x < 163; x++) peak = Math.max(peak, image.data[(y * image.width + x) * 4]);
        sum += peak;
      }
      return sum / 120;
    });
    flicker[mode] = { dimmest: Math.min(...levels), brightest: Math.max(...levels) };
  }
  console.log('line brightness over 16 frames in sRGB levels', flicker);
  assert.ok(flicker.lineClamp.brightest > 60 && flicker.lineLocks.brightest > 60, 'the line shows in both');
  assert.ok(flicker.lineClamp.dimmest < 15, `the clamped line vanishes on some frames (${flicker.lineClamp.dimmest})`);
  assert.ok(flicker.lineLocks.dimmest > 30, `the locked line never does (${flicker.lineLocks.dimmest})`);
  // Settled (the default): the line shows one level every frame, its box-filtered mean. The line covers 0.2 px of each
  // of columns 159 and 160, so each pixel's footprint holds 0.02 + 0.2 * 0.88 in linear light, 122.4 sRGB levels; the
  // 8 jitter phases estimate that coverage. RTX A6000: 123 every frame (0 levels apart, 0.6 from the mean).
  const lineMean = 255 * (1.055 * (0.02 + 0.2 * 0.88) ** (1 / 2.4) - 0.055);
  assert.ok(
    flicker.lineSettled.brightest - flicker.lineSettled.dimmest <= 1,
    `the settled line holds still (${JSON.stringify(flicker.lineSettled)})`,
  );
  assert.ok(
    Math.abs(flicker.lineSettled.dimmest - lineMean) < 3,
    `the settled line shows its mean, ${lineMean.toFixed(1)} (${flicker.lineSettled.dimmest})`,
  );

  // History over the sky (2026-11-13: pixels at depth 0, the reversed-Z far plane, had none, so the march noise of
  // volumetric clouds over the sky stood unaveraged): the same stripes, once on a surface and once at depth 0, change
  // from frame to frame by the same amount once settled (Radeon 680M, Vulkan: 17.0 and 17.0 levels); without sky
  // history the sky's changed by the whole jitter (24.7 against 17.0).
  const backdrops = ['surface', 'sky', 'surfaceSettled', 'skySettled'];
  await page.evaluate((names) => window.t.frames(names, 30), backdrops);
  const change = {};
  for (const mode of backdrops) {
    const a = await shot(mode);
    await page.evaluate((name) => window.t.frames([name], 1), mode);
    const b = await shot(mode);
    let sum = 0;
    for (let i = 0; i < a.data.length; i += 4) sum += Math.abs(a.data[i] - b.data[i]);
    change[mode] = sum / (a.data.length / 4);
  }
  console.log('frame-to-frame change of settled stripes in sRGB levels', change);
  assert.ok(change.surface > 0.05, `the jitter moves the stripes at all (${change.surface})`);
  assert.ok(change.sky < change.surface * 1.15, `the sky keeps history as a surface does (${JSON.stringify(change)})`);
  // Settled (the default): still stripes on a surface and on the sky do not move at all (RTX A6000: 0 and 0 levels).
  for (const mode of ['surfaceSettled', 'skySettled'])
    assert.equal(change[mode], 0, `settled stripes hold still (${mode} ${change[mode]})`);
  assert.deepEqual(await page.evaluate(() => window.t.gpuErrors()), []);
  assert.deepEqual(errors, []);
  console.log('history rejection check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
}
