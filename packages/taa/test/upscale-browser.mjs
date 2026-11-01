// Real-GPU check of TAAUpscale, built packages. Takes the GPU lock itself around the browser.
// Compares each upscale against a full-size frame by PSNR, and a moving box's trail against a still background.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const release = await acquire({ owner: 'taa-upscale' });
const timer = setTimeout(() => {
  console.error('upscale-browser: timed out after 180 s');
  process.exit(1);
}, 180_000);
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/taa-upscale/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5345, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5345 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5345/packages/taa/test/upscale-browser.html');
  await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { TAAUpscale } = await import('/packages/taa/dist/upscale.js');
    const canvas = document.querySelector('canvas'),
      engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [0, 3, 9], target: [0, 0, 0] },
      });
    engine.stop();
    const light = new PbrMaterial({ color: '#f0f0e8' }),
      dark = new PbrMaterial({ color: '#203040' });
    for (let x = -6; x <= 6; x++)
      for (let z = -3; z <= 3; z++)
        engine
          .createMesh()
          .setGeometry(box(0.4, 0.4, 0.4))
          .setPosition([x * 0.8, 0, z * 0.8])
          .setRotation([0, 0.4 * x, 0])
          .setMaterial((x + z) & 1 ? light : dark);
    const mover = engine
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setPosition([-20, 2, 0])
      .setMaterial(new PbrMaterial({ color: '#ff0000' }));
    window.t = {
      engine,
      mover,
      up: null,
      TAAUpscale,
      frames: (n) => {
        for (let i = 0; i < n; i++) engine.render({ delta: 1 / 60 });
        return engine.gpu.queue.onSubmittedWorkDone();
      },
      use(options) {
        this.up?.dispose();
        this.up = options ? TAAUpscale.attach(engine, options) : null;
      },
    };
  });
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  const psnr = (a, b) => {
    let sum = 0,
      count = 0;
    for (let i = 0; i < a.data.length; i += 4)
      for (let k = 0; k < 3; k++) {
        const d = a.data[i + k] - b.data[i + k];
        sum += d * d;
        count++;
      }
    return 10 * Math.log10((255 * 255) / (sum / count));
  };
  await page.evaluate(() => window.t.frames(2));
  const reference = await shot();
  await page.evaluate(() => {
    window.t.use({ scale: 0.5, temporal: false, sharpen: 0 });
    return window.t.frames(2);
  });
  const lanczos = psnr(await shot(), reference);
  await page.evaluate(() => {
    window.t.use({ scale: 0.5, sharpen: 0 });
    return window.t.frames(1);
  });
  const single = psnr(await shot(), reference);
  await page.evaluate(() => window.t.frames(48));
  const accumulated = psnr(await shot(), reference);
  await page.evaluate(() => {
    window.t.up.options.sharpen = 0.5;
    return window.t.frames(1);
  });
  const sharpened = psnr(await shot(), reference);
  // Ghost: a red box crosses the frame at speed, so red pixels may only lie around where it is now.
  const moved = await page.evaluate(async () => {
    window.t.up.options.sharpen = 0;
    for (let i = 0; i <= 24; i++) {
      window.t.mover.setPosition([-4 + i * 0.33, 2, 0]);
      await window.t.frames(1);
    }
    return true;
  });
  const after = await shot();
  let trail = 0,
    body = 0;
  for (let y = 0; y < after.height; y++)
    for (let x = 0; x < after.width; x++) {
      const i = (y * after.width + x) * 4,
        red = after.data[i] > 90 && after.data[i] > after.data[i + 1] * 2 && after.data[i] > after.data[i + 2] * 2;
      if (!red) continue;
      if (x < after.width * 0.72) trail++;
      else body++;
    }
  const report = { lanczos, single, accumulated, sharpened, trail, body, moved };
  console.log(JSON.stringify(report));
  await page.evaluate(() => window.t.engine.dispose());
  assert.deepEqual(errors, []);
  assert.ok(lanczos > 18, `Lanczos stays near the full frame: ${lanczos}`);
  assert.ok(accumulated > lanczos + 0.5, `accumulated frames beat one upscaled frame: ${accumulated} vs ${lanczos}`);
  assert.ok(accumulated > single, `history adds detail: ${accumulated} vs ${single}`);
  assert.notEqual(sharpened, accumulated, 'sharpen changes the frame');
  assert.ok(body > 50, `the box is drawn: ${body}`);
  assert.ok(trail < body * 0.15, `no trail behind the box: ${trail} red pixels against ${body}`);
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
  await release();
}
