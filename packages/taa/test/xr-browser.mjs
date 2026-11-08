// Real-GPU check of TAA with stereo eyes, drawn as @margoengine/xr's EyeViews draws them: each eye is a RenderView with
// its own target and id (xr-0, xr-1) through `engine.render({views})`, and a camera whose `project` is the eye's own
// off-axis frustum with depth reversed, as an XRView gives it. TAA keeps history, jitter cycle and captures per view id.
// Built packages; takes the GPU lock itself around the browser. A spinning box is drawn for 24 frames by two eyes
// 6.4 cm apart; each eye's frame must equal, byte for byte, the frame that eye gets when drawn alone for the same 24
// frames, so neither eye reprojects the other's history, and the two eyes must differ (parallax).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const release = await acquire({ owner: 'taa-xr' });
const timer = setTimeout(() => {
  console.error('xr-browser: timed out after 120 s');
  process.exit(1);
}, 120_000);
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/taa-xr/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5377, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5377 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5377/packages/taa/test/upscale-browser.html');
  const result = await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { Camera } = await import('/packages/core/dist/extension.js'),
      { TAA } = await import('/packages/taa/dist/index.js');
    const engine = await Engine.create(document.querySelector('canvas'), { backend: 'webgpu' });
    engine.stop();
    const device = engine.gpu,
      gpuErrors = [];
    device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
    const spinner = engine
      .createMesh()
      .setGeometry(box(1.5, 1.5, 1.5))
      .setMaterial(new PbrMaterial({ color: '#d04020', roughness: 0.5 }));
    TAA.attach(engine);
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
      const buffer = device.createBuffer({ size: 256 * H * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
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
    return {
      gpuErrors,
      leftAlone: diff(left, alone),
      rightAlone: diff(right, aloneRight),
      eyes: diff(left, right),
      covered: left.filter((v, i) => i % 4 === 0 && Math.max(v, left[i + 2]) > 100).length,
    };
  });
  console.log('stereo TAA', result);
  assert.ok(result.covered > 500, `the box is in view (${result.covered} pixels)`);
  assert.equal(result.leftAlone, 0, 'the left eye equals its frame drawn alone');
  assert.equal(result.rightAlone, 0, 'the right eye equals its frame drawn alone');
  assert.ok(result.eyes > 200, `the eyes differ by parallax (${result.eyes} bytes)`);
  assert.deepEqual(result.gpuErrors, []);
  assert.deepEqual(errors, []);
  console.log('stereo TAA check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
  await release();
}
