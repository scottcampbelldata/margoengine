import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';

import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';
const release = await acquire({ owner: 'codex-batch192', max: 4, waitMax: 60 });
const timer = setTimeout(() => {
  console.error('upscale-velocity-browser: timed out after 240 s');
  process.exit(1);
}, 240_000);
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/taa-upscale-velocity/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5392, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5392 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  if (compatRun()) await page.addInitScript(compatShim);
  await page.goto('http://127.0.0.1:5392/packages/taa/test/upscale-browser.html');
  const result = await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { Camera } = await import('/packages/core/dist/extension.js'),
      { TAAUpscaleVelocity } = await import('/packages/taa/dist/upscale-velocity.js');
    const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
    engine.stop();
    const device = engine.gpu,
      gpuErrors = [];
    device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
    const spinner = engine
      .createMesh()
      .setGeometry(box(1.5, 1.5, 1.5))
      .setMaterial(new PbrMaterial({ color: '#d04020', roughness: 0.5 }));
    const upscale = TAAUpscaleVelocity.attach(engine, { scale: 0.5, sharpen: 0 });
    const W = 200,
      H = 160,
      format = navigator.gpu.getPreferredCanvasFormat();
    // An XR eye's frustum: off-axis toward the nose, WebGPU clip depth reversed (EyeViews.place).
    const eyeProjection = (x) => {
      const n = 0.1,
        f = 100,
        t = n * Math.tan((35 * Math.PI) / 180),
        b = -t,
        l = -t * (W / H) - x * 0.5 * n,
        r = t * (W / H) - x * 0.5 * n,
        m = new Float64Array(16);
      m[0] = (2 * n) / (r - l);
      m[5] = (2 * n) / (t - b);
      m[8] = (r + l) / (r - l);
      m[9] = (t + b) / (t - b);
      m[10] = f / (n - f);
      m[11] = -1;
      m[14] = (n * f) / (n - f);
      for (let column = 0; column < 16; column += 4) m[column + 2] = m[column + 3] - m[column + 2];
      return m;
    };
    const eye = (id, x) => {
      const camera = new Camera({ position: [x, 0.4, 4], target: [x, 0, 0], fov: 70 }),
        projection = eyeProjection(x);
      camera.project = (out) => out.set(projection);
      const color = device.createTexture({
        size: [W, H],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      return { id, camera, viewport: [0, 0, 1, 1], target: { color } };
    };
    const read = async (texture) => {
      const buffer = device.createBuffer({
        size: 256 * H * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 * 4 }, [W, H]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const rows = new Uint8Array(buffer.getMappedRange()),
        out = [];
      for (let y = 0; y < H; y++) out.push(...rows.subarray(y * 1024, y * 1024 + W * 4));
      buffer.destroy();
      return out;
    };
    // The same 24 frames of spin for every run, so the eyes see the same scene whichever views draw it.
    const run = async (views) => {
      for (let f = 0; f < 24; f++) {
        spinner.setRotation([0.3, f * 0.08, 0]);
        engine.render({ views, delta: 1 / 60 });
      }
      await device.queue.onSubmittedWorkDone();
      return Promise.all(views.map((v) => read(v.target.color)));
    };
    const [left, right] = await run([eye('xr-0', -0.032), eye('xr-1', 0.032)]);
    // New ids, so TAA starts each eye alone from no history, as the stereo pair started.
    const [alone] = await run([eye('alone-0', -0.032)]);
    const [aloneRight] = await run([eye('alone-1', 0.032)]);
    const diff = (a, b) => a.reduce((n, v, i) => n + (v !== b[i]), 0);
    // Two offset rectangles in one target must match the same two views on separate targets.
    const shared = device.createTexture({
      size: [W * 2, H],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const offsetLeft = eye('offset-left', -0.032),
      offsetRight = eye('offset-right', 0.032);
    offsetLeft.target.color.destroy();
    offsetRight.target.color.destroy();
    offsetLeft.target.color = shared;
    offsetRight.target.color = shared;
    offsetLeft.viewport = [0, 0, 0.5, 1];
    offsetRight.viewport = [0.5, 0, 0.5, 1];
    for (let f = 0; f < 24; f++) {
      spinner.setRotation([0.3, f * 0.08, 0]);
      engine.render({ views: [offsetLeft, offsetRight], delta: 1 / 60 });
    }
    const readRegion = async (texture, width, height, origin = [0, 0, 0]) => {
      const stride = Math.ceil((width * 4) / 256) * 256;
      const buffer = device.createBuffer({
        size: stride * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, origin }, { buffer, bytesPerRow: stride }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(buffer.getMappedRange()),
        result = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) result.set(data.subarray(y * stride, y * stride + width * 4), y * width * 4);
      buffer.destroy();
      return result;
    };
    const offsetLeftDiff = diff(await readRegion(shared, W, H), left);
    const offsetRightDiff = diff(await readRegion(shared, W, H, [W, 0, 0]), right);
    // A translating thin surface must supply object motion, then only jitter when it stops.
    spinner.setGeometry(box(0.06, 2, 0.05)).setRotation([0, 0, 0]);
    const motionEye = eye('thin-motion', 0);
    const frame = async (x) => {
      spinner.setPosition([x, 0, 0]);
      engine.render({ views: [motionEye], delta: 1 / 60 });
      await device.queue.onSubmittedWorkDone();
      const velocity = upscale.velocity;
      const bytes = await readRegion(velocity.texture, W / 2, H / 2);
      const depth = await readRegion(velocity.expectedDepth, W / 2, H / 2);
      const v = new DataView(bytes.buffer),
        d = new DataView(depth.buffer);
      const half = (n) => {
        const e = (n >> 10) & 31,
          m = n & 1023;
        return (n & 32768 ? -1 : 1) * (e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24);
      };
      const xs = [];
      for (let i = 0; i < bytes.length; i += 4) if (d.getFloat32(i, true) > 0) xs.push(half(v.getUint16(i, true)));
      return xs;
    };
    await frame(-0.2);
    const moving = await frame(0.2),
      stopped = await frame(0.2);
    const movingObjectUV = moving.map((v) => v + 0.25 / (W / 2)); // phase 2 minus phase 1 jitter = -0.25 low pixels
    const stoppedError = stopped.map((v) => Math.abs(v - 0.5 / (W / 2))); // phase 3 minus phase 2 = +0.5 low pixels
    const movingMin = Math.min(...movingObjectUV),
      stationaryMax = Math.max(...stoppedError);
    upscale.dispose();
    engine.dispose();
    return {
      gpuErrors,
      offsetLeftDiff,
      offsetRightDiff,
      movingSamples: moving.length,
      stoppedSamples: stopped.length,
      movingMin,
      stationaryMax,
      leftAlone: diff(left, alone),
      rightAlone: diff(right, aloneRight),
      eyes: diff(left, right),
      covered: left.filter((v, i) => i % 4 === 0 && Math.max(v, left[i + 2]) > 100).length,
    };
  });
  console.log('velocity upscale stereo', result);
  assert.ok(result.covered > 500, `the box is in view (${result.covered} pixels)`);
  assert.equal(result.leftAlone, 0, 'the left eye equals its frame drawn alone');
  assert.equal(result.rightAlone, 0, 'the right eye equals its frame drawn alone');
  assert.ok(result.eyes > 200, `the eyes differ by parallax (${result.eyes} bytes)`);
  assert.equal(result.offsetLeftDiff, 0, 'offset left viewport equals its isolated view');
  assert.equal(result.offsetRightDiff, 0, 'offset right viewport equals its isolated view');
  assert.ok(result.movingSamples > 0 && result.stoppedSamples > 0, 'thin surface supplies motion samples');
  assert.ok(result.movingMin > 0.02, 'translation survives subtraction of jitter');
  assert.ok(result.stationaryMax < 0.00002, 'a stopped surface contains only projection jitter');
  assert.deepEqual(result.gpuErrors, []);
  assert.deepEqual(errors, []);
  console.log('velocity upscaling check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
  await release();
}
