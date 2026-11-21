// Real-GPU check that settling (KB-TAA-STILL1, src/settle.ts) never holds a reactive pixel, built packages, on the
// test/stripes-fixture.js scene.. A half-white square that writes no velocity stands still
// over the 8 px stripes with its coverage in the reactive mask, as a particle or a splat that happens to hold still
// does. Its pixels are bit-equal phase to phase, so without the mask's say settling would hold them like any still
// pixel; the mask takes their history weight away in the blend, so settling must not keep it either: inside the square
// every frame shows its own jittered sample and changes, while the still stripes around it settle and stop.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { noFileWatcher } from '../../../scripts/support/no-file-watcher.js';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';

const timer = setTimeout(() => {
  console.error('settle-reactive-browser: timed out after 120 s');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 120_000);
const server = await createServer({
  plugins: [noFileWatcher()],
  configFile: false,
  cacheDir: 'test-results/taa-settle-reactive/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5386, strictPort: true, watch: null, hmr: false },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5386 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  // MARGO_COMPAT=1: the page runs on the WebGL2 compatibility layer (scripts/support/compat-shim.js).
  if (compatRun()) await page.addInitScript(compatShim);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5386/packages/taa/test/upscale-browser.html');
  await page.evaluate(async () => {
    const { rig } = await import('/packages/taa/test/stripes-fixture.js');
    document.querySelector('canvas').remove();
    const r = await rig('held', { mask: true });
    window.t = { gpuErrors: () => r.gpuErrors, frames: (n) => r.frames(n, 0, true) };
  });
  const shot = async () => decodePNG(await page.locator('#held').screenshot());
  // Largest change of red between two frames, in sRGB levels, over rows 96 to 144 and columns [from, to).
  const change = (a, b, from, to) => {
    let max = 0;
    for (let y = 96; y < 144; y++)
      for (let x = from; x < to; x++) {
        const i = (y * a.width + x) * 4;
        max = Math.max(max, Math.abs(a.data[i] - b.data[i]));
      }
    return max;
  };
  // Two jitter cycles to settle and two more to hold, then a cycle of frames, each against the one before.
  await page.evaluate(() => window.t.frames(40));
  let last = await shot();
  const report = { square: 0, stripes: 0 };
  // fixed-wait: the measurement itself: 8 consecutive frames, one jitter cycle, each compared with the one before.
  for (let f = 0; f < 8; f++) {
    await page.evaluate(() => window.t.frames(1));
    const now = await shot();
    // The square spans x 20 to 68; keep 4 px off its edges, where the 3x3 footprint reaches the stripes.
    report.square = Math.max(report.square, change(last, now, 24, 64));
    report.stripes = Math.max(report.stripes, change(last, now, 120, 300));
    last = now;
  }
  console.log('largest frame-to-frame change in sRGB levels', report);
  // RTX A6000, D3D12: 29 levels in the square, 0 on the stripes; before the fix the masked square was held with the
  // stripes and this check failed. The square's own jittered samples over 8 px stripes move it by tens of levels.
  assert.ok(report.square > 10, `a reactive pixel is never held (${report.square} levels)`);
  assert.equal(report.stripes, 0, 'the still stripes around it settle');
  assert.deepEqual(await page.evaluate(() => window.t.gpuErrors()), []);
  assert.deepEqual(errors, []);
  console.log('reactive settle check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
}
