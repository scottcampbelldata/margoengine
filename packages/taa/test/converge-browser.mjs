// Real-GPU check that TAA's per-frame resolve converges on the supersampled mean of a still view (KB-TAA-CLAMP1),
// built packages, on the test/stripes-fixture.js sine stripes 8 px across.
// The velocity buffer holds the jitter difference between this frame and the history frame as well as the motion; the
// resolve fetched history by the whole vector, so a still view's history moved by up to 0.8 px through a bilinear tap
// every frame, blurred, and the stripes converged about 10.5 sRGB levels above their mean (113.90 against 103.375 on
// an RTX A6000, 112.75 to 114.63 frame by frame). Now history is fetched by the motion alone. Measured on an RTX A6000
// after the fix: per-frame band means 102.875 to 103.4375 (mean 103.24) against 103.375 for the settled mean of the 8
// jitter phases and the box-filtered reference below, for every rejection mode.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

// Bounds in sRGB levels of the band mean (32 stripe periods by 48 rows). The jitter moves the last sample's share
// (0.1 of the blend) from frame to frame, so a frame may sit up to FRAME_MAX off the mean; the 16-frame mean sits within
// MEAN_MAX of it. Before the fix both missed by about 10.
const FRAME_MAX = 1,
  MEAN_MAX = 0.5;
const timer = setTimeout(() => {
  console.error('converge-browser: timed out after 150 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 150_000);
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  cacheDir: 'test-results/taa-converge/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5388, strictPort: true, watch: null, hmr: false },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5388 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 520 }, deviceScaleFactor: 1 }),
    errors = [];
  // MARGO_COMPAT=1: the page runs on the WebGL2 compatibility layer (scripts/support/compat-shim.js).
  if (compatRun()) await page.addInitScript(compatShim);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5388/packages/taa/test/upscale-browser.html');
  const modes = {
    settled: { settle: true },
    clamp: { settle: false },
    variance: { settle: false, rejection: 'variance' },
    stochastic: { settle: false, stochastic: true },
    locks: { settle: false, locks: true },
  };
  await page.evaluate(async (modes) => {
    const { rig } = await import('/packages/taa/test/stripes-fixture.js');
    document.querySelector('canvas').remove();
    const rigs = {};
    for (const [name, taa] of Object.entries(modes)) rigs[name] = await rig(name, { taa, alpha: 0 });
    window.t = {
      gpuErrors: () => Object.values(rigs).flatMap((r) => r.gpuErrors),
      frames: (n) => Promise.all(Object.values(rigs).map((r) => r.frames(n))),
    };
  }, modes);
  // Mean of red over rows 96 to 144 and columns 32 to 288 (whole stripe periods), in sRGB levels.
  const band = (image) => {
    let sum = 0,
      n = 0;
    for (let y = 96; y < 144; y++)
      for (let x = 32; x < 288; x++) {
        sum += image.data[(y * image.width + x) * 4];
        n++;
      }
    return sum / n;
  };
  // Box-filtered reference: each pixel's footprint averaged in linear light over the 8-bit scene values the fixture
  // writes (0.4 + 0.38 sin, period 8 px, zero at the view's centre column 160), shown in 8-bit sRGB.
  const decode = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4),
    encode = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  let reference = 0;
  for (let x = 32; x < 288; x++) {
    let sum = 0;
    for (let k = 0; k < 1000; k++) {
      const s = 0.4 + 0.38 * Math.sin((2 * Math.PI * (x + (k + 0.5) / 1000 - 160)) / 8);
      sum += decode(Math.round(s * 255) / 255);
    }
    reference += Math.round(encode(sum / 1000) * 255);
  }
  reference /= 256;

  await page.evaluate(() => window.t.frames(30));
  const levels = Object.fromEntries(Object.keys(modes).map((name) => [name, []]));
  // fixed-wait: the measurement itself: 16 consecutive frames, two jitter cycles, each one captured.
  for (let f = 0; f < 16; f++) {
    await page.evaluate(() => window.t.frames(1));
    for (const name of Object.keys(modes))
      levels[name].push(band(await decodePNG(await page.locator('#' + name).screenshot())));
  }
  const report = { reference };
  for (const [name, v] of Object.entries(levels))
    report[name] = { mean: v.reduce((a, b) => a + b) / v.length, min: Math.min(...v), max: Math.max(...v) };
  console.log('band means in sRGB levels', JSON.stringify(report));
  const settled = report.settled.mean;
  assert.ok(Math.abs(settled - reference) < MEAN_MAX, `the settled mean is the box-filtered one (${settled})`);
  for (const name of ['clamp', 'variance', 'stochastic', 'locks']) {
    const r = report[name];
    assert.ok(Math.abs(r.mean - settled) < MEAN_MAX, `${name}: the resolve converges on the mean (${r.mean})`);
    assert.ok(
      Math.max(r.max - settled, settled - r.min) < FRAME_MAX,
      `${name}: every frame stays by the mean (${r.min} to ${r.max})`,
    );
  }
  assert.deepEqual(await page.evaluate(() => window.t.gpuErrors()), []);
  assert.deepEqual(errors, []);
  console.log('still convergence check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
}
