// Real-GPU check of TAA's velocityOnly with MotionBlur in a PostStack at 4x MSAA, built packages. Takes the GPU lock itself
// around the browser. A moving box must blur with the vectors and stay sharp without the blur, and a still view must not
// shimmer: with no jitter its frames are the same bytes.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const release = await acquire({ owner: 'taa-velocity-only' });
const timer = setTimeout(() => {
  console.error('velocity-only-browser: timed out after 120 s');
  process.exit(1);
}, 120_000);
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/taa-velocity-only/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5346, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5346 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5346/packages/taa/test/upscale-browser.html');
  await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { TAA } = await import('/packages/taa/dist/index.js'),
      { PostStack } = await import('/packages/post/dist/index.js'),
      { MotionBlur } = await import('/packages/post/dist/motion-blur.js');
    const engine = await Engine.create(document.querySelector('canvas'), {
      backend: 'webgpu',
      camera: { position: [0, 0, 9], target: [0, 0, 0] },
    });
    engine.stop();
    const device = engine.gpu,
      gpuErrors = [];
    device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
    const mover = engine
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setPosition([-2, 0, 0])
      .setMaterial(new PbrMaterial({ color: '#ffffff', emissive: '#ffffff' }));
    let taa;
    const blur = new MotionBlur({ velocity: () => taa?.velocity, shutter: 1, samples: 32 }),
      stack = PostStack.attach(engine, [blur]);
    taa = TAA.attach(engine, { velocityOnly: true, depth: () => stack.depthTexture });
    let x = -2;
    window.t = {
      gpuErrors,
      async frames(n, step) {
        for (let i = 0; i < n; i++) {
          x += step;
          mover.setPosition([x, 0, 0]);
          engine.render({ delta: 1 / 60 });
        }
        await device.queue.onSubmittedWorkDone();
      },
      set: (enabled) => (blur.enabled = enabled),
      vectors() {
        const v = taa.velocity;
        return { format: v?.texture.format, resolved: v?.resolved ?? null, jitter: v ? [...v.jitter] : null };
      },
    };
  });
  const shot = async () => decodePNG(await page.locator('canvas').screenshot());
  // Pixels of the box's row that are neither background nor the box: the width of its soft edges.
  const soft = (image) => {
    const row = Math.floor(image.height / 2);
    let lo = 255,
      hi = 0;
    const values = [];
    for (let x = 0; x < image.width; x++) {
      const v = image.data[(row * image.width + x) * 4];
      values.push(v);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    assert.ok(hi - lo > 100, `the box is on the row (${lo} to ${hi})`);
    return values.filter((v) => v > lo + 0.1 * (hi - lo) && v < hi - 0.1 * (hi - lo)).length;
  };

  await page.evaluate(() => window.t.frames(6, 0.4));
  assert.deepEqual(await page.evaluate(() => window.t.vectors()), {
    format: 'rg16float',
    resolved: null,
    jitter: [0, 0],
  });
  const moving = soft(await shot());
  await page.evaluate(async () => {
    window.t.set(false);
    await window.t.frames(2, 0.4);
  });
  const sharp = soft(await shot());
  console.log('soft edge pixels', { moving, sharp });
  assert.ok(moving >= 20, `the moving box blurs (${moving} soft pixels)`);
  assert.ok(sharp <= 6, `without the blur its edges stay sharp (${sharp} soft pixels)`);

  await page.evaluate(async () => {
    window.t.set(true);
    await window.t.frames(4, 0);
  });
  const still = await shot();
  await page.evaluate(() => window.t.frames(5, 0));
  const later = await shot();
  assert.equal(Buffer.compare(Buffer.from(still.data), Buffer.from(later.data)), 0, 'a still view keeps its bytes');
  assert.equal(soft(still) <= 6, true, 'a still box does not blur');
  assert.deepEqual(await page.evaluate(() => window.t.gpuErrors), []);
  assert.deepEqual(errors, []);
  console.log('velocity-only check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
  await release();
}
