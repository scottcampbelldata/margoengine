// Real-GPU check of TAA's reactive mask, built packages, on the test/stripes-fixture.js scene. Takes the GPU lock itself
// around the browser. A world-space plane of sine stripes 8 px across (drawn with the jittered camera, so TAA reprojects
// it as it would any surface) keeps the 3x3 clamp wide open; a half-transparent white square that writes no velocity,
// as particles and splats do, crosses it 6 px a frame. Plain TAA leaves a bright trail where the square was; with the square's coverage in the reactive mask
// the trail is gone, and the square shows at once at full strength.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const release = await acquire({ owner: 'taa-reactive' });
const timer = setTimeout(() => {
  console.error('reactive-browser: timed out after 120 s');
  process.exit(1);
}, 120_000);
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/taa-reactive/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5373, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5373 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5373/packages/taa/test/upscale-browser.html');
  await page.evaluate(async () => {
    const { rig } = await import('/packages/taa/test/stripes-fixture.js');
    document.querySelector('canvas').remove();
    const rigs = { plain: await rig('plain'), reactive: await rig('reactive', { mask: true }) };
    window.t = {
      gpuErrors: () => [...rigs.plain.gpuErrors, ...rigs.reactive.gpuErrors],
      frames: (n, step, show) => Promise.all(Object.values(rigs).map((r) => r.frames(n, step, show))),
    };
  });
  const shot = async (id) => decodePNG(await page.locator('#' + id).screenshot());
  // Mean of red over the square's row band, in sRGB levels, for columns [from, to).
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

  // Converge on the stripes alone, then the square crosses: 20 frames of 6 px, from x = 20 to x = 140.
  await page.evaluate(() => window.t.frames(30, 0, false));
  const before = { plain: await shot('plain'), reactive: await shot('reactive') };
  await page.evaluate(() => window.t.frames(20, 6, true));
  const after = { plain: await shot('plain'), reactive: await shot('reactive') };
  // The trail: the 48 px the square covered over the last eight frames and has now left (x 92 to 140).
  // The square: where it is now (x 140 to 188); its half-white over the stripes is 0.5 + 0.5 * stripe in linear light.
  const report = {};
  for (const mode of ['plain', 'reactive']) {
    report[mode] = {
      trail: band(after[mode], 92, 140) - band(before[mode], 92, 140),
      square: band(after[mode], 144, 184) - band(before[mode], 144, 184),
      far: band(after[mode], 240, 300) - band(before[mode], 240, 300),
    };
  }
  console.log('mean brightening in sRGB levels', report);
  // M6 Mac mini, Metal: plain trail 19.4 levels, reactive -1.4; square 49.9 plain against 63.5 reactive. A pixel the
  // square left one frame ago keeps 0.9 of a history up to 0.27 brighter in linear light, so a plain trail of 10
  // levels or more is the ghost; a reactive pixel restarts from this frame's own sample, whose jitter error averages
  // out over the band.
  assert.ok(report.plain.trail > 10, `plain TAA leaves a trail (${report.plain.trail.toFixed(1)} levels)`);
  assert.ok(Math.abs(report.reactive.trail) < 3, `the reactive mask removes it (${report.reactive.trail.toFixed(1)})`);
  assert.ok(report.reactive.square > report.plain.square + 8, 'and the square shows at full strength at once');
  for (const mode of ['plain', 'reactive'])
    assert.ok(Math.abs(report[mode].far) < 2, `away from the square nothing changes (${mode} ${report[mode].far})`);
  assert.deepEqual(await page.evaluate(() => window.t.gpuErrors()), []);
  assert.deepEqual(errors, []);
  console.log('reactive mask check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
  await release();
}
